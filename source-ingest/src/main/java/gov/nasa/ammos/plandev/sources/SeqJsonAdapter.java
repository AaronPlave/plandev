package gov.nasa.ammos.plandev.sources;

import javax.json.JsonArray;
import javax.json.JsonObject;
import javax.json.JsonString;
import javax.json.JsonValue;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * An authored sequence in seqJSON (the format SeqDev's languages convert to and from; see
 * {@code @nasa-jpl/seq-json-schema}): what was written to be run, not a record of what ran.
 *
 * <p>The whole sequence is kept as the product's metadata ({@code product.mission}), in the file's order, whatever
 * its timing: every step of {@code steps} with its kind, stem or target, arguments, time tag exactly as written, and
 * description; the {@code requests} with their own steps; the {@code immediate_commands}; and the sequence's own
 * {@code metadata}. That is the sequence's inventory, and it needs no clock.
 *
 * <p>Only a step whose time is {@code ABSOLUTE} has a time of its own. Those steps, and only those, are also
 * activity records, so they can be drawn: type {@code AUTHORED_COMMAND} for a command ({@code AUTHORED_LOAD},
 * {@code AUTHORED_ACTIVATE}, ... for the other kinds), category {@code seqJSON authored}, named by the stem or
 * target, instantaneous, with {@code metadata.step} its 1-based position in {@code steps} and {@code metadata.parent}
 * the sequence. They are authored instructions, typed apart from what a product reports ran (a PEF's
 * {@code COMMAND}). Relative, epoch-relative, block-relative and command-complete times depend on when something
 * else happens; no absolute time is made up for them, so they stay in the inventory only. When at least one step
 * is timed the sequence is a record too ({@code AUTHORED_SEQUENCE}), from its first to its last timed step: the
 * span of its timed steps, said so in {@code metadata.dataQuality}, not a run time.
 *
 * <p>Provenance a generator wrote into the sequence's metadata (SeqDev's template expansion writes
 * {@code planId}, {@code simulationDatasetId} and {@code seqId}) is kept as it is and, under
 * {@code mission.generatedFrom}, named as such. A step's own {@code metadata} (e.g. a {@code simulatedActivityId})
 * is kept with that step. Nothing is inferred.
 */
public final class SeqJsonAdapter implements SourceAdapter {
  private static final Descriptor DESCRIPTOR = new Descriptor(
      "seq_json", "Sequence (seqJSON)", "1",
      List.of(".seq.json", ".json"), List.of("application/json"), List.of("activities"), null);

  @Override public Descriptor descriptor() { return DESCRIPTOR; }

  private static final Pattern STEPS_KEY = Pattern.compile("\"steps\"\\s*:\\s*\\[");
  private static final Pattern ID_KEY = Pattern.compile("\"id\"\\s*:\\s*\"");
  private static final Pattern STEP_SHAPE = Pattern.compile("\"(stem|sequence)\"\\s*:|\"time\"\\s*:\\s*\\{");

  /** An object with an id and a steps array whose steps look like seqJSON's (a stem or sequence, a time object). */
  @Override
  public boolean probe(byte[] head) {
    final var text = new String(head, StandardCharsets.UTF_8).stripLeading();
    return text.startsWith("{") && STEPS_KEY.matcher(text).find() && ID_KEY.matcher(text).find()
        && STEP_SHAPE.matcher(text).find();
  }

  /** Keys a generator writes into the sequence's metadata to say what it was generated from. */
  private static final List<String> PROVENANCE_KEYS = List.of("planId", "simulationDatasetId", "seqId");

  @Override
  public void read(InputStream in, Sink sink, String config) throws Exception {
    sink.manifestComplete();
    final JsonObject sequence;
    try (final var reader = javax.json.Json.createReader(in)) {
      sequence = reader.readObject();
    }
    final var id = sequence.getString("id", null);
    if (id == null) throw new IllegalArgumentException("seqJSON without an id");

    final List<Map<String, Object>> steps = new ArrayList<>();
    final List<ActivityRecord> timed = new ArrayList<>();
    final List<String> untimedKinds = new ArrayList<>();
    final var stepArray = sequence.get("steps") instanceof JsonArray a ? a : JsonValue.EMPTY_JSON_ARRAY;
    int position = 0;
    for (final var value : stepArray) {
      position++;
      if (!(value instanceof JsonObject step)) continue;
      final var described = step(step, position);
      steps.add(described);
      final var time = step.get("time") instanceof JsonObject t ? t : null;
      final var at = time == null || !"ABSOLUTE".equals(time.getString("type", null)) ? null
          : absolute(time.getString("tag", ""));
      if (at == null) {
        untimedKinds.add(time == null ? "none" : time.getString("type", "none"));
        if (time != null && "ABSOLUTE".equals(time.getString("type", null))) {
          described.put("dataQuality", "Its ABSOLUTE time tag could not be read; not drawn");
        }
        continue;
      }
      final Map<String, Object> metadata = new LinkedHashMap<>();
      metadata.put("recordKind", "authored_step");
      metadata.put("parent", id);
      metadata.put("step", position);
      metadata.put("timeTag", time.getString("tag"));
      if (step.get("metadata") instanceof JsonObject own) metadata.put("stepMetadata", own);
      final var kind = step.getString("type", "step");
      timed.add(new ActivityRecord(id + "#" + position, "AUTHORED_" + kind.toUpperCase(),
          (String) described.getOrDefault("name", kind), "seqJSON authored", at, at, "{}",
          Json.write(described.getOrDefault("args", Map.of())), Json.write(metadata)));
    }

    final Map<String, Object> mission = new LinkedHashMap<>();
    mission.put("format", "seqJSON");
    mission.put("kind", "authored sequence");
    mission.put("sequenceId", id);
    if (sequence.get("metadata") instanceof JsonObject metadata) {
      mission.put("metadata", metadata);
      final Map<String, Object> generatedFrom = new LinkedHashMap<>();
      for (final var key : PROVENANCE_KEYS) {
        if (metadata.containsKey(key)) generatedFrom.put(key, metadata.get(key));
      }
      if (!generatedFrom.isEmpty()) mission.put("generatedFrom", generatedFrom);
    }
    mission.put("steps", steps);
    mission.put("timing", Map.of(
        "absoluteSteps", timed.size(),
        "otherSteps", untimedKinds.size(),
        "note", timed.size() == steps.size()
            ? "Every step has an absolute time"
            : "Steps without an ABSOLUTE time are listed in order only; no time is made up for them"));
    if (sequence.get("requests") instanceof JsonArray requests && !requests.isEmpty()) {
      final List<Map<String, Object>> described = new ArrayList<>();
      for (final var value : requests) {
        if (!(value instanceof JsonObject request)) continue;
        final Map<String, Object> r = new LinkedHashMap<>();
        r.put("name", request.getString("name", null));
        if (request.get("time") != null) r.put("time", request.get("time"));
        if (request.get("ground_epoch") != null) r.put("groundEpoch", request.get("ground_epoch"));
        final List<Map<String, Object>> requestSteps = new ArrayList<>();
        int n = 0;
        if (request.get("steps") instanceof JsonArray array) {
          for (final var s : array) if (s instanceof JsonObject o) requestSteps.add(step(o, ++n));
        }
        r.put("steps", requestSteps);
        described.add(r);
      }
      mission.put("requests", described);
    }
    if (sequence.get("immediate_commands") instanceof JsonArray immediate && !immediate.isEmpty()) {
      final List<Map<String, Object>> described = new ArrayList<>();
      int n = 0;
      for (final var s : immediate) if (s instanceof JsonObject o) described.add(step(o, ++n));
      mission.put("immediateCommands", described);
    }
    sink.productMetadata(new ProductMetadata(null, null, id, mission));

    for (final var record : timed) sink.activity(record);
    if (!timed.isEmpty()) {
      final long start = timed.stream().mapToLong(ActivityRecord::startMicros).min().orElseThrow();
      final long end = timed.stream().mapToLong(ActivityRecord::startMicros).max().orElseThrow();
      sink.activity(new ActivityRecord(id, "AUTHORED_SEQUENCE", id, "seqJSON authored", start, end, "{}", "{}",
          Json.object("recordKind", "authored_sequence",
              "dataQuality", "Spans its " + timed.size() + " absolute-timed step(s) of " + steps.size()
                  + "; not when it ran")));
    }
  }

  /** One step as written: its kind, what it names, its arguments (by name when named), its time tag, its notes. */
  private static Map<String, Object> step(JsonObject step, int position) {
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("position", position);
    final var kind = step.getString("type", null);
    out.put("type", kind);
    final var name = text(step, "stem") != null ? text(step, "stem")
        : text(step, "sequence") != null ? text(step, "sequence") : text(step, "name");
    if (name != null) out.put("name", name);
    if (step.get("args") instanceof JsonArray args) out.put("args", arguments(args));
    if (step.get("time") != null) out.put("time", step.get("time"));
    for (final var field : List.of("description", "engine", "epoch")) {
      if (step.get(field) != null && step.get(field) != JsonValue.NULL) out.put(field, step.get(field));
    }
    if (step.get("models") != null) out.put("models", step.get("models"));
    if (step.get("metadata") != null) out.put("metadata", step.get("metadata"));
    return out;
  }

  /** Arguments by name when every one is named, else as the list they are. */
  private static Object arguments(JsonArray args) {
    final Map<String, Object> named = new LinkedHashMap<>();
    for (final var v : args) {
      if (!(v instanceof JsonObject arg) || arg.getString("name", null) == null) return args;
      named.put(arg.getString("name"), arg.get("value"));
    }
    return named;
  }

  private static String text(JsonObject o, String field) {
    return o.get(field) instanceof JsonString s ? s.getString() : null;
  }

  /** An ABSOLUTE tag ({@code YYYY-DDDTHH:MM:SS[.ffffff]}, optionally ending in Z) in microseconds, or null. */
  private static Long absolute(String tag) {
    try {
      return TolAdapter.parseTime(tag.endsWith("Z") ? tag.substring(0, tag.length() - 1) : tag);
    } catch (IllegalArgumentException e) {
      return null;
    }
  }
}
