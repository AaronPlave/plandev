package gov.nasa.ammos.plandev.sources;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class SeqJsonAdapterTest {
  private static final class Collect implements SourceAdapter.Sink {
    final List<SourceAdapter.ActivityRecord> activities = new ArrayList<>();
    SourceAdapter.ProductMetadata product;

    @Override public void declare(SourceAdapter.ResourceDecl decl) { throw new AssertionError("no resources"); }
    @Override public void manifestComplete() {}
    @Override public void sample(int resource, long t, double num, String text, byte kind) { throw new AssertionError(); }
    @Override public void activity(SourceAdapter.ActivityRecord a) { activities.add(a); }
    @Override public void productMetadata(SourceAdapter.ProductMetadata p) { product = p; }
  }

  private static Collect read(InputStream in) throws Exception {
    final var sink = new Collect();
    new SeqJsonAdapter().read(in, sink, null);
    return sink;
  }

  private static Collect read(String json) throws Exception {
    return read(new ByteArrayInputStream(json.getBytes(StandardCharsets.UTF_8)));
  }

  /** SeqDev's own e2e fixture: relative and command-complete times only. */
  @Test
  void keepsAnUntimedSequenceInOrderAndDrawsNothingOfIt() throws Exception {
    final Collect sink;
    try (final var in = SeqJsonAdapterTest.class.getResourceAsStream("/seqdev-ban00001.seq.json")) {
      sink = read(in);
    }
    assertTrue(sink.activities.isEmpty(), "no time is made up for relative or command-complete steps");
    assertEquals("testDescription", sink.product.suggestedName());
    final var mission = Json.write(sink.product.mission());
    assertTrue(mission.contains("\"kind\":\"authored sequence\""), mission);
    assertTrue(mission.contains("{\"position\":1,\"type\":\"command\",\"name\":\"ECHO\",\"args\":[{\"type\":\"string\",\"value\":\"TEST1\"}]"), mission);
    assertTrue(mission.contains("\"time\":{\"tag\":\"00:00:01\",\"type\":\"COMMAND_RELATIVE\"}"), mission);
    assertTrue(mission.contains("\"absoluteSteps\":0,\"otherSteps\":4"), mission);
    assertFalse(mission.contains("generatedFrom"), "authored on its own: no plan is claimed");
  }

  /** SYNTHETIC (not mission data): absolute and relative steps, with a generator's provenance. */
  @Test
  void drawsOnlyAbsoluteStepsTypedAsAuthoredAndKeepsGeneratorProvenance() throws Exception {
    final var sink = read("""
        {"id": "seq_a", "metadata": {"planId": 3, "simulationDatasetId": 7, "timeSorted": true},
         "steps": [
          {"type": "command", "stem": "PWR_ON", "time": {"type": "ABSOLUTE", "tag": "2026-150T01:00:00"},
           "args": [{"name": "unit", "type": "string", "value": "A"}], "metadata": {"simulatedActivityId": 42}},
          {"type": "command", "stem": "WAIT_CMD", "time": {"type": "COMMAND_RELATIVE", "tag": "00:05:00"}, "args": []},
          {"type": "load", "sequence": "sub.seq", "time": {"type": "ABSOLUTE", "tag": "2026-150T02:00:00.5Z"}},
          {"type": "command", "stem": "BAD", "time": {"type": "ABSOLUTE", "tag": "tomorrow"}, "args": []}
         ]}""");
    assertEquals(List.of("AUTHORED_COMMAND", "AUTHORED_LOAD", "AUTHORED_SEQUENCE"),
        sink.activities.stream().map(SourceAdapter.ActivityRecord::type).toList());
    final var first = sink.activities.get(0);
    assertEquals("seq_a#1", first.key());
    assertEquals("PWR_ON", first.name());
    assertEquals("seqJSON authored", first.category());
    assertEquals("{\"unit\":\"A\"}", first.parameters());
    assertEquals("{\"recordKind\":\"authored_step\",\"parent\":\"seq_a\",\"step\":1,\"timeTag\":\"2026-150T01:00:00\","
        + "\"stepMetadata\":{\"simulatedActivityId\":42}}", first.metadata());
    assertEquals("seq_a#3", sink.activities.get(1).key());
    final var sequence = sink.activities.get(2);
    assertEquals(TolAdapter.parseTime("2026-150T01:00:00"), sequence.startMicros());
    assertEquals(TolAdapter.parseTime("2026-150T02:00:00.5"), sequence.endMicros());
    assertTrue(sequence.metadata().contains("Spans its 2 absolute-timed step(s) of 4"), sequence.metadata());
    final var mission = Json.write(sink.product.mission());
    assertTrue(mission.contains("\"generatedFrom\":{\"planId\":3,\"simulationDatasetId\":7}"), mission);
    assertTrue(mission.contains("\"dataQuality\":\"Its ABSOLUTE time tag could not be read; not drawn\""), mission);
  }

  @Test
  void probesSeqJsonButNotPefOrOtherJson() {
    final var adapter = new SeqJsonAdapter();
    assertTrue(adapter.probe("{\"id\":\"s\",\"metadata\":{},\"steps\":[{\"stem\":\"A\",\"time\":{\"type\":\"COMMAND_COMPLETE\"}}]}"
        .getBytes(StandardCharsets.UTF_8)));
    assertFalse(adapter.probe("[{\"inputFiles\":[]}]".getBytes(StandardCharsets.UTF_8)));
    assertFalse(adapter.probe("{\"id\":\"x\",\"steps\":[1,2]}".getBytes(StandardCharsets.UTF_8)));
  }

  @Test
  void acceptsAnEmptySequence() throws Exception {
    final var sink = read("{\"id\": \"empty\", \"metadata\": {}, \"steps\": []}");
    assertTrue(sink.activities.isEmpty());
    assertTrue(Json.write(sink.product.mission()).contains("\"steps\":[]"));
  }

  @Test
  void rejectsMalformedStructureInsteadOfImportingLess() {
    for (final var json : List.of(
        "{\"id\": \"s\", \"steps\": {}}",
        "{\"id\": \"s\", \"steps\": [42]}",
        "{\"id\": \"s\", \"steps\": [{\"stem\": \"NO_TYPE\"}]}",
        "{\"id\": \"s\", \"steps\": [{\"type\": \"command\", \"stem\": \"X\", \"time\": \"A2026-001\"}]}",
        "{\"id\": \"s\", \"steps\": [{\"type\": \"command\", \"stem\": \"X\", \"args\": {\"a\": 1}}]}",
        "{\"id\": \"s\", \"requests\": [{\"name\": \"r\"}]}",
        "{\"id\": \"s\", \"immediate_commands\": [\"X\"]}",
        "{\"id\": 7, \"steps\": []}")) {
      final var thrown = org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class, () -> read(json), json);
      assertTrue(thrown.getMessage().startsWith("seqJSON"), thrown.getMessage());
    }
  }

  @Test
  void flagsUnreadableRelativeTagsAndUnknownKindsButKeepsThem() throws Exception {
    final var sink = read("""
        {"id": "v", "steps": [
          {"type": "command", "stem": "A", "time": {"type": "COMMAND_RELATIVE", "tag": "soon"}, "args": []},
          {"type": "note", "text": "a variant's own step", "time": {"type": "COMMAND_COMPLETE"}},
          {"type": "command", "stem": "B", "time": {"type": "COMMAND_RELATIVE", "tag": "001T00:00:01.5"}, "args": []}
        ]}""");
    final var mission = Json.write(sink.product.mission());
    assertTrue(mission.contains("\"dataQuality\":\"Its COMMAND_RELATIVE time tag could not be read\""), mission);
    assertTrue(mission.contains("\"dataQuality\":\"Not a step kind seqJSON defines: kept as written\""), mission);
    assertEquals(2, mission.split("dataQuality").length - 1, mission);
  }
}
