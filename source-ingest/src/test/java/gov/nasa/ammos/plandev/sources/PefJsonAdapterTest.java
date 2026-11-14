package gov.nasa.ammos.plandev.sources;

import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class PefJsonAdapterTest {
  private static final class Collect implements SourceAdapter.Sink {
    boolean manifest;
    final List<SourceAdapter.ActivityRecord> activities = new ArrayList<>();

    @Override public void declare(SourceAdapter.ResourceDecl decl) { throw new AssertionError("PEF declares no resources"); }
    @Override public void manifestComplete() { manifest = true; }
    @Override public void sample(int resource, long t, double num, String text, byte kind) { throw new AssertionError(); }
    @Override public void activity(SourceAdapter.ActivityRecord a) {
      if (!manifest) throw new AssertionError("activity before the manifest");
      activities.add(a);
    }
  }

  private static Collect read(String json) throws Exception {
    final var sink = new Collect();
    new PefJsonAdapter().read(new ByteArrayInputStream(json.getBytes(StandardCharsets.UTF_8)), sink, null);
    return sink;
  }

  @Test
  void readsActivitiesWithTypedParametersAndClampsAnEndBeforeItsStart() throws Exception {
    final Collect sink;
    try (final var in = PefJsonAdapterTest.class.getResourceAsStream("/predicted-events.pef.json")) {
      sink = new Collect();
      new PefJsonAdapter().read(in, sink, null);
    }
    // The request, ACT timed_record and inputFiles records are not read; the reported WARNING and the sequence are.
    assertEquals(List.of("WARNING", "ALLOCATION", "STATION_VIEW_EVENT", "STATION_VIEW", "CONDITION", "SEQUENCE"),
        sink.activities.stream().map(SourceAdapter.ActivityRecord::type).toList());
    assertEquals("ALO_1$1ALLOCATION", sink.activities.get(1).key());

    final var view = sink.activities.get(3);
    assertEquals("STATION_VIEW", view.type());
    assertEquals("DSN", view.category());
    assertEquals(TolAdapter.parseTime("2026-146T20:29:49.000"), view.startMicros());
    assertEquals(TolAdapter.parseTime("2026-147T04:28:21.000"), view.endMicros());
    // DURATION -> ms, STRING stays text, null-typed dropped.
    assertTrue(view.parameters().contains("\"RISE_TO_SET\":"), view.parameters());
    assertTrue(view.parameters().contains("\"ANT\":\"55\""), view.parameters());
    assertFalse(view.parameters().contains("LIM_HIGH"), view.parameters());

    final var allocation = sink.activities.get(1);
    assertEquals(allocation.startMicros(), allocation.endMicros());
    // Not silently a zero-length activity: the file's end and the reason are kept with it.
    assertEquals("{\"endTime\":\"2026-147T13:04:04.675\","
        + "\"dataQuality\":\"EndTime is before StartTime in the file; drawn with zero duration\"}", allocation.metadata());
    assertTrue(allocation.parameters().contains("\"BOT_EOT\":14400558"), allocation.parameters());

    assertTrue(sink.activities.get(2).parameters().contains("\"EVENT_AZ\":180"), sink.activities.get(2).parameters());
    assertEquals("{}", sink.activities.get(2).metadata());
  }

  @Test
  void readsSequencesTheirCommandsAndReportedWarningsWithTheRelationshipsTheProductNames() throws Exception {
    final var sink = read("""
        [
         {"sequence_history": {"engine": "14", "ParentName": "bgs.lgo", "ParentEngine": "16", "ParentId": "UP_1bgs.lgo",
           "ActivityId": "UP_1bgs.lgo_2pass.seq", "ActivityType": "pass.seq", "InvocationType": "SPAWN",
           "StartTime": "2026-147T13:54:13.698", "SequenceExecutionTime": "N/A", "EndTime": "2026-147T18:15:48.881",
           "State": "COMPLETED", "commands": {"command": [
             {"step": "load", "id": "UP_1bgs.lgo_2pass.seq_1begin.seq", "name": "/eng1/seq/begin.seq", "to_engine": "16",
              "params": [], "time": "2026-147T13:55:13.697"},
             {"step": "command", "id": "UP_1bgs.lgo_2pass.seq_2CMD", "name": "SEQ_EXECUTE", "type": "SEQ_EXECUTE",
              "params": [{"@name": "sequence_name", "@type": "QUOTED_STRING", "#text": "begin.seq"},
                         {"@name": "rate", "@type": "FLOAT", "#text": "2000.00000000000000000"}],
              "startTime": "2026-147T13:56:13.697", "endTime": "2026-147T13:56:13.697"}]}}},
         {"sequence_history": {"engine": -1, "ParentName": "", "ParentId": "", "ActivityId": "ATR", "ActivityType": "ATR",
           "InvocationType": "SASF", "StartTime": "2026-147T00:00:00.000", "SequenceExecutionTime": "2026-147T00:00:01.000",
           "EndTime": "2026-146T00:00:00.000", "State": "RUNNING",
           "commands": {"command": {"step": "command", "id": "ATR_1CMD", "name": "NOOP", "params": [],
                                    "startTime": "2026-147T00:00:02.000", "endTime": "2026-147T00:00:02.000"}}}},
         {"sequence_history": {"ActivityId": "EMPTY", "StartTime": "2026-147T00:00:00.000", "EndTime": "2026-147T00:00:00.000"}},
         {"timed_record": {"@type": "ERROR", "@time": "2026-147T16:00:00.000", "genealogy": "UP_1bgs.lgo_2pass.seq_2CMD",
           "atTime": "2026-147T16:00:00.000", "last_result_parent_name": "pass.seq", "msg": "Modeling error"}},
         {"timed_record": {"@type": "CMD", "@time": "2026-147T16:00:00.000", "genealogy": "UP_1bgs.lgo_2pass.seq_2CMD"}},
         {"beyond_timed_record": {"@type": "WARNING", "@time": "2026-147T16:00:00.000", "msg": "late"}}
        ]""");
    assertEquals(List.of("SEQUENCE", "COMMAND", "SEQUENCE", "COMMAND", "SEQUENCE", "ERROR", "WARNING"),
        sink.activities.stream().map(SourceAdapter.ActivityRecord::type).toList());

    final var sequence = sink.activities.get(0);
    assertEquals("UP_1bgs.lgo_2pass.seq", sequence.key());
    assertEquals("pass.seq", sequence.name());
    assertEquals("PEF sequence", sequence.category());
    assertEquals(TolAdapter.parseTime("2026-147T18:15:48.881"), sequence.endMicros());
    // N/A is no execution time.
    assertEquals("{\"engine\":\"14\",\"invocationType\":\"SPAWN\",\"state\":\"COMPLETED\",\"parentName\":\"bgs.lgo\"}",
        sequence.parameters());
    assertEquals("{\"recordKind\":\"sequence_history\",\"parent\":\"UP_1bgs.lgo\"}", sequence.metadata());

    // The load step is not a record of its own; the command names its sequence.
    final var command = sink.activities.get(1);
    assertEquals("UP_1bgs.lgo_2pass.seq_2CMD", command.key());
    assertEquals("SEQ_EXECUTE", command.name());
    assertEquals("PEF command", command.category());
    assertEquals(TolAdapter.parseTime("2026-147T13:56:13.697"), command.startMicros());
    assertEquals("{\"sequence_name\":\"begin.seq\",\"rate\":2000}", command.parameters());
    assertEquals("{\"recordKind\":\"sequence_command\",\"parent\":\"UP_1bgs.lgo_2pass.seq\"}", command.metadata());

    // No parent is no parent; a numeric engine is kept; an end before the start is clamped; one command is an object.
    final var root = sink.activities.get(2);
    assertEquals("{\"recordKind\":\"sequence_history\"}", root.metadata());
    assertTrue(root.parameters().contains("\"engine\":\"-1\""), root.parameters());
    assertTrue(root.parameters().contains("\"sequenceExecutionTime\":\"2026-147T00:00:01.000\""), root.parameters());
    assertEquals(root.startMicros(), root.endMicros());
    assertEquals("ATR_1CMD", sink.activities.get(3).key());
    // No commands at all, and its name falls back to its id.
    assertEquals("EMPTY", sink.activities.get(4).name());

    final var error = sink.activities.get(5);
    assertEquals("ERROR@2026-147T16:00:00.000#1", error.key());
    assertEquals("PEF reported", error.category());
    assertEquals(error.startMicros(), error.endMicros());
    assertEquals("{\"message\":\"Modeling error\",\"lastResultParentName\":\"pass.seq\"}", error.parameters());
    assertEquals("{\"recordKind\":\"timed_record\",\"related\":\"UP_1bgs.lgo_2pass.seq_2CMD\"}", error.metadata());
    // Same time as the error: the counter keeps the keys apart. Nothing related is named, so none is recorded.
    final var warning = sink.activities.get(6);
    assertEquals("WARNING@2026-147T16:00:00.000#2", warning.key());
    assertEquals("{\"recordKind\":\"beyond_timed_record\"}", warning.metadata());
  }

  private static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }

  private static byte[] head(String resource) throws Exception {
    try (final var in = PefJsonAdapterTest.class.getResourceAsStream(resource)) {
      return in.readNBytes(4096);
    }
  }

  @Test
  void probeRecognizesPefByItsHeaderOrByItsActivityRecords() throws Exception {
    final var adapter = new PefJsonAdapter();
    assertTrue(adapter.probe(head("/predicted-events.pef.json")));
    assertTrue(adapter.probe(bytes("[\n{\"inputFiles\": [")));
    // No header record: the activity records themselves identify it.
    assertTrue(adapter.probe(head("/predicted-events-no-header.pef.json")));
    assertTrue(adapter.probe(bytes("  [{\"__kind\":\"activity\",\"genealogy\":\"a$1X\",\"StartTime\":\"2026-147T00:00:00.000\"}")));
  }

  @Test
  void probeRejectsOtherJsonAndOtherFormats() {
    final var adapter = new PefJsonAdapter();
    assertFalse(adapter.probe(bytes("[{\"a\": 1}]")));
    assertFalse(adapter.probe(bytes("[]")));
    assertFalse(adapter.probe(bytes("[{\"__kind\": \"activity\", \"name\": \"x\"}]")));
    // A request record alone, or a word that merely appears in a value, is not enough.
    assertFalse(adapter.probe(bytes("[{\"__kind\": \"request\", \"StartTime\": \"2026-147T16:00:00.000\"}]")));
    assertFalse(adapter.probe(bytes("[{\"note\": \"inputFiles genealogy activity\"}]")));
    // The same records outside an array are another kind of file.
    assertFalse(adapter.probe(bytes("{\"inputFiles\": [], \"__kind\": \"activity\"}")));
    assertFalse(adapter.probe(bytes("<XML_TOL>")));
  }

  @Test
  void rejectsAnActivityWithoutATime() {
    assertThrows(IllegalArgumentException.class,
        () -> read("[{\"__kind\":\"activity\",\"genealogy\":\"a\",\"StartTime\":\"2026-147T00:00:00.000\"}]"));
    assertThrows(IllegalArgumentException.class, () -> read("{}"));
  }
}
