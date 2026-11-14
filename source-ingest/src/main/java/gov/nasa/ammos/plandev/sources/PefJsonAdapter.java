package gov.nasa.ammos.plandev.sources;

import javax.json.JsonObject;
import javax.json.JsonValue;
import javax.json.stream.JsonParser;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Predicted Events Files (PEF) as converted to JSON: a top-level array of records. Four kinds are read, all as
 * activity records told apart by type and category; everything else (inputFiles, requests, attr_set / CMD / GEV /
 * COMMENT timed records, initial and final conditions, ...) is skipped.
 *
 * <ul>
 * <li>{@code "__kind": "activity"}: {@code StartTime}, {@code EndTime}, {@code Name}, {@code Group}, a unique
 * {@code genealogy} and typed {@code params}. The key is the genealogy, the type and name are {@code Name}, the
 * category is {@code Group}.</li>
 * <li>{@code sequence_history}: one sequence execution. Type {@code SEQUENCE}, category {@code PEF sequence}, key
 * {@code ActivityId}, name {@code ActivityType}. The sequence that loaded, called or spawned it ({@code ParentId})
 * is {@code metadata.parent}.</li>
 * <li>Each {@code step: "command"} entry of a sequence's {@code commands}: type {@code COMMAND}, category
 * {@code PEF command}, key its {@code id}, with its typed params and its sequence as {@code metadata.parent}. The
 * load and activate steps are not read: the sequence they start has its own record naming this one as its parent.
 * These are the product's record of what was sequenced; they are not editable plan directives.</li>
 * <li>{@code WARNING} and {@code ERROR} timed records (also those before and beyond the product's span): type
 * {@code WARNING} / {@code ERROR}, category {@code PEF reported}, instantaneous, with the message as a parameter and
 * the record they were raised on ({@code genealogy}) as {@code metadata.related}. They are what the tool that
 * produced the PEF reported, kept as it reported them; they are not constraints PlanDev checked. They have no
 * identifier of their own, so their key is {@code <TYPE>@<time>#<n>}, n counting them in file order.</li>
 * </ul>
 *
 * {@code metadata.parent} and {@code metadata.related} are only ever what the product names, and are another
 * record's key in the same file when that record is one of those read (a related GEV record, say, is not).
 *
 * The JSON is read rather than the raw {@code .pef} because only it carries each activity's end time; the text's
 * {@code ACT} lines give the start and the parameters only.
 *
 * Parameters become JSON by their {@code @type}: FLOAT numbers, DURATION ({@code HH:MM:SS[.fff]}) milliseconds (as
 * in TOL), empty ({@code null}-typed) values are dropped, the rest stay text. An {@code EndTime} before its
 * {@code StartTime} (seen on ALLOCATION) is clamped to the start, and the file's value is kept as
 * {@code metadata.endTime} with a {@code metadata.dataQuality} note saying so.
 *
 * The JSON has no product header, so this adapter reports no {@link ProductMetadata}.
 */
public final class PefJsonAdapter implements SourceAdapter {
  private static final Descriptor DESCRIPTOR = new Descriptor(
      "pef_json", "PEF activities (JSON)", "2",
      List.of(".pef.json", ".pef.json.gz"), List.of("application/json"), List.of("activities"), null);

  @Override public Descriptor descriptor() { return DESCRIPTOR; }

  /** A PEF record is an object with its own keys; a bare JSON array of other objects is not PEF. */
  private static final Pattern INPUT_FILES_KEY = Pattern.compile("\"inputFiles\"\\s*:");
  private static final Pattern ACTIVITY_KIND = Pattern.compile("\"__kind\"\\s*:\\s*\"activity\"");
  private static final Pattern GENEALOGY_KEY = Pattern.compile("\"genealogy\"\\s*:");
  private static final Pattern START_TIME_KEY = Pattern.compile("\"StartTime\"\\s*:");

  /**
   * An array whose head shows either the PEF header record ({@code inputFiles}) or an activity record as the converter
   * writes it ({@code "__kind": "activity"} with {@code genealogy} and {@code StartTime}). The header is optional, so
   * it can't be required; any other array of objects, including one with {@code "__kind"} alone, is not taken.
   */
  @Override
  public boolean probe(byte[] head) {
    final var text = new String(head, StandardCharsets.UTF_8).stripLeading();
    if (!text.startsWith("[")) return false;
    return INPUT_FILES_KEY.matcher(text).find()
        || (ACTIVITY_KIND.matcher(text).find() && GENEALOGY_KEY.matcher(text).find() && START_TIME_KEY.matcher(text).find());
  }

  @Override
  public void read(InputStream in, Sink sink, String config) throws Exception {
    sink.manifestComplete();
    // ponytail: each top-level record is built as a tree (the file is read one record at a time, so memory is bounded
    // by the largest record, initial_cond). Skip records unparsed if a product's records get huge.
    try (final JsonParser p = javax.json.Json.createParser(in)) {
      if (!p.hasNext() || p.next() != JsonParser.Event.START_ARRAY) {
        throw new IllegalArgumentException("PEF JSON must be an array of records");
      }
      int reported = 0;
      while (p.hasNext()) {
        final var ev = p.next();
        if (ev == JsonParser.Event.END_ARRAY) break;
        if (ev == JsonParser.Event.START_OBJECT) {
          final var record = p.getObject();
          if ("activity".equals(record.getString("__kind", null))) {
            sink.activity(activity(record));
          } else if (record.get("sequence_history") instanceof JsonObject sequence) {
            sequence(sequence, sink);
          } else {
            for (final var kind : TIMED_KINDS) {
              if (record.get(kind) instanceof JsonObject timed && REPORTED_TYPES.contains(timed.getString("@type", ""))) {
                sink.activity(reported(kind, timed, ++reported));
              }
            }
          }
        } else if (ev == JsonParser.Event.START_ARRAY) {
          p.skipArray();
        }
      }
    }
  }

  private static final List<String> TIMED_KINDS = List.of("timed_record", "before_timed_record", "beyond_timed_record");
  private static final List<String> REPORTED_TYPES = List.of("WARNING", "ERROR");

  /** A sequence execution, then each command it ran. */
  private static void sequence(JsonObject o, Sink sink) throws Exception {
    final var key = o.getString("ActivityId", null);
    final var startText = o.getString("StartTime", null);
    final var endText = o.getString("EndTime", null);
    if (key == null || startText == null || endText == null) {
      throw new IllegalArgumentException("PEF sequence_history without ActivityId, StartTime or EndTime: " + o);
    }
    final long start = TolAdapter.parseTime(startText);
    final Map<String, Object> parameters = new LinkedHashMap<>();
    final Map<String, Object> metadata = new LinkedHashMap<>();
    putText(parameters, "engine", o, "engine");
    putText(parameters, "invocationType", o, "InvocationType");
    putText(parameters, "state", o, "State");
    if (!"N/A".equals(text(o, "SequenceExecutionTime"))) putText(parameters, "sequenceExecutionTime", o, "SequenceExecutionTime");
    putText(parameters, "parentName", o, "ParentName");
    metadata.put("recordKind", "sequence_history");
    putText(metadata, "parent", o, "ParentId");
    sink.activity(new ActivityRecord(key, "SEQUENCE", o.getString("ActivityType", key), "PEF sequence",
        start, Math.max(start, TolAdapter.parseTime(endText)), "{}", Json.write(parameters), Json.write(metadata)));

    // One command is an object rather than an array of one; none is an empty array or absent.
    final var commands = o.get("commands") instanceof JsonObject c ? c.get("command") : null;
    final List<? extends JsonValue> steps =
        commands instanceof javax.json.JsonArray array ? array : commands instanceof JsonObject one ? List.of(one) : List.of();
    for (final var value : steps) {
      if (!(value instanceof JsonObject step) || !"command".equals(step.getString("step", null))) continue;
      final var id = step.getString("id", null);
      final var commandStart = step.getString("startTime", null);
      if (id == null || commandStart == null) {
        throw new IllegalArgumentException("PEF command without id or startTime in sequence " + key + ": " + step);
      }
      final long at = TolAdapter.parseTime(commandStart);
      final var commandEnd = step.getString("endTime", null);
      final Map<String, Object> commandMetadata = new LinkedHashMap<>();
      commandMetadata.put("recordKind", "sequence_command");
      commandMetadata.put("parent", key);
      sink.activity(new ActivityRecord(id, "COMMAND", step.getString("name", id), "PEF command",
          at, commandEnd == null ? at : Math.max(at, TolAdapter.parseTime(commandEnd)),
          "{}", Json.write(parameters(step)), Json.write(commandMetadata)));
    }
  }

  /** A WARNING or ERROR the producing tool reported, at the time it reported it. */
  private static ActivityRecord reported(String kind, JsonObject o, int n) {
    final var type = o.getString("@type");
    final var time = o.getString("@time", null);
    if (time == null) throw new IllegalArgumentException("PEF " + type + " record without @time: " + o);
    final long at = TolAdapter.parseTime(time);
    final Map<String, Object> parameters = new LinkedHashMap<>();
    final Map<String, Object> metadata = new LinkedHashMap<>();
    putText(parameters, "message", o, "msg");
    putText(parameters, "lastResultParentName", o, "last_result_parent_name");
    metadata.put("recordKind", kind);
    putText(metadata, "related", o, "genealogy");
    return new ActivityRecord(type + "@" + time + "#" + n, type, type, "PEF reported", at, at,
        "{}", Json.write(parameters), Json.write(metadata));
  }

  /** A field as text (numbers too: engine is written both ways), or null when absent. */
  private static String text(JsonObject o, String field) {
    final var value = o.get(field);
    return value == null || value == JsonValue.NULL ? null
        : value instanceof javax.json.JsonString string ? string.getString() : value.toString();
  }

  private static void putText(Map<String, Object> out, String name, JsonObject o, String field) {
    final var value = text(o, field);
    if (value != null && !value.isEmpty()) out.put(name, value);
  }

  /** The record's {@code params} by name, typed. */
  private static Map<String, Object> parameters(JsonObject o) {
    final Map<String, Object> parameters = new LinkedHashMap<>();
    // One param is an object rather than an array of one.
    final var params = o.get("params");
    final List<? extends JsonValue> list =
        params instanceof javax.json.JsonArray array ? array : params instanceof JsonObject one ? List.of(one) : List.of();
    for (final JsonValue v : list) {
      final var param = v.asJsonObject();
      final var value = param.getString("#text", "");
      switch (param.getString("@type", "")) {
        case "null" -> {}
        case "FLOAT" -> parameters.put(param.getString("@name"), TolAdapter.number(value.trim()));
        case "DURATION" -> parameters.put(param.getString("@name"), duration(value));
        default -> parameters.put(param.getString("@name"), value);
      }
    }
    return parameters;
  }

  private static ActivityRecord activity(JsonObject o) {
    final var key = o.getString("genealogy", null);
    final var startText = o.getString("StartTime", null);
    final var endText = o.getString("EndTime", null);
    if (key == null || startText == null || endText == null) {
      throw new IllegalArgumentException("PEF activity without genealogy, StartTime or EndTime: " + o);
    }
    final long start = TolAdapter.parseTime(startText);
    final long end = TolAdapter.parseTime(endText);
    final Map<String, Object> metadata = new LinkedHashMap<>();
    if (end < start) {
      // Shown as zero-length (an activity can't end before it starts); the file's value and the reason stay in provenance.
      metadata.put("endTime", endText);
      metadata.put("dataQuality", "EndTime is before StartTime in the file; drawn with zero duration");
    }
    final var parameters = parameters(o);
    final var name = o.getString("Name", key);
    return new ActivityRecord(key, name, name, o.getString("Group", null), start, Math.max(start, end),
        "{}", Json.write(parameters), Json.write(metadata));
  }

  /** {@code HH:MM:SS[.fff]} (hours may pass 24) as milliseconds; anything else stays text. */
  private static Object duration(String text) {
    final var parts = text.trim().split(":");
    if (parts.length != 3) return text;
    try {
      final double seconds = (Long.parseLong(parts[0]) * 60 + Long.parseLong(parts[1])) * 60 + Double.parseDouble(parts[2]);
      return TolAdapter.number(Double.toString(Math.round(seconds * 1000)));
    } catch (NumberFormatException e) {
      return text;
    }
  }
}
