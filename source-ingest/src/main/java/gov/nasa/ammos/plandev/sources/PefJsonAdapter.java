package gov.nasa.ammos.plandev.sources;

import javax.json.JsonObject;
import javax.json.JsonValue;
import javax.json.stream.JsonParser;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Predicted Events Files (PEF) as converted to JSON: a top-level array of records, of which only those with
 * {@code "__kind": "activity"} are read. Each has {@code StartTime}, {@code EndTime}, {@code Name}, {@code Group}, a
 * unique {@code genealogy} and typed {@code params}. Everything else (inputFiles, timed_record, sequence_history,
 * requests, ...) is skipped.
 *
 * The JSON is read rather than the raw {@code .pef} because only it carries each activity's end time; the text's
 * {@code ACT} lines give the start and the parameters only.
 *
 * The key is the genealogy, the type and name are {@code Name}, the category is {@code Group}. Parameters become
 * JSON by their {@code @type}: FLOAT numbers, DURATION ({@code HH:MM:SS[.fff]}) milliseconds (as in TOL), empty
 * ({@code null}-typed) values are dropped, the rest stay text. An {@code EndTime} before its {@code StartTime}
 * (seen on ALLOCATION) is clamped to the start, and the file's value is kept as {@code metadata.endTime}.
 *
 * The JSON has no product header, so this adapter reports no {@link ProductMetadata}.
 */
public final class PefJsonAdapter implements SourceAdapter {
  private static final Descriptor DESCRIPTOR = new Descriptor(
      "pef_json", "PEF activities (JSON)", "1",
      List.of(".pef.json", ".pef.json.gz"), List.of("application/json"), List.of("activities"), null);

  @Override public Descriptor descriptor() { return DESCRIPTOR; }

  @Override
  public boolean probe(byte[] head) {
    final var text = new String(head, StandardCharsets.UTF_8).stripLeading();
    return text.startsWith("[") && text.contains("\"inputFiles\"");
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
      while (p.hasNext()) {
        final var ev = p.next();
        if (ev == JsonParser.Event.END_ARRAY) break;
        if (ev == JsonParser.Event.START_OBJECT) {
          final var record = p.getObject();
          if ("activity".equals(record.getString("__kind", null))) sink.activity(activity(record));
        } else if (ev == JsonParser.Event.START_ARRAY) {
          p.skipArray();
        }
      }
    }
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
    final Map<String, Object> parameters = new LinkedHashMap<>();
    final Map<String, Object> metadata = new LinkedHashMap<>();
    if (end < start) metadata.put("endTime", endText);
    for (final JsonValue v : o.getJsonArray("params") == null ? List.<JsonValue>of() : o.getJsonArray("params")) {
      final var param = v.asJsonObject();
      final var value = param.getString("#text", "");
      switch (param.getString("@type", "")) {
        case "null" -> {}
        case "FLOAT" -> parameters.put(param.getString("@name"), TolAdapter.number(value.trim()));
        case "DURATION" -> parameters.put(param.getString("@name"), duration(value));
        default -> parameters.put(param.getString("@name"), value);
      }
    }
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
