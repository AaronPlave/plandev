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
  void readsOnlyActivitiesWithTypedParametersAndClampsAnEndBeforeItsStart() throws Exception {
    final Collect sink;
    try (final var in = PefJsonAdapterTest.class.getResourceAsStream("/predicted-events.pef.json")) {
      sink = new Collect();
      new PefJsonAdapter().read(in, sink, null);
    }
    // The request, timed_record, before_timed_record, sequence_history and inputFiles records are not activities.
    assertEquals(List.of("ALLOCATION", "STATION_VIEW_EVENT", "STATION_VIEW", "CONDITION"),
        sink.activities.stream().map(SourceAdapter.ActivityRecord::type).toList());
    assertEquals("ALO_1$1ALLOCATION", sink.activities.get(0).key());

    final var view = sink.activities.get(2);
    assertEquals("STATION_VIEW", view.type());
    assertEquals("DSN", view.category());
    assertEquals(TolAdapter.parseTime("2026-146T20:29:49.000"), view.startMicros());
    assertEquals(TolAdapter.parseTime("2026-147T04:28:21.000"), view.endMicros());
    // DURATION -> ms, STRING stays text, null-typed dropped.
    assertTrue(view.parameters().contains("\"RISE_TO_SET\":"), view.parameters());
    assertTrue(view.parameters().contains("\"ANT\":\"55\""), view.parameters());
    assertFalse(view.parameters().contains("LIM_HIGH"), view.parameters());

    final var allocation = sink.activities.get(0);
    assertEquals(allocation.startMicros(), allocation.endMicros());
    assertEquals("{\"endTime\":\"2026-147T13:04:04.675\"}", allocation.metadata());
    assertTrue(allocation.parameters().contains("\"BOT_EOT\":14400558"), allocation.parameters());

    assertTrue(sink.activities.get(1).parameters().contains("\"EVENT_AZ\":180"), sink.activities.get(1).parameters());
    assertEquals("{}", sink.activities.get(1).metadata());
  }

  @Test
  void probeTakesAJsonArrayWithInputFilesOnly() {
    final var adapter = new PefJsonAdapter();
    assertTrue(adapter.probe("[\n{\"inputFiles\": [".getBytes(StandardCharsets.UTF_8)));
    assertFalse(adapter.probe("[{\"a\": 1}]".getBytes(StandardCharsets.UTF_8)));
    assertFalse(adapter.probe("<XML_TOL>".getBytes(StandardCharsets.UTF_8)));
  }

  @Test
  void rejectsAnActivityWithoutATime() {
    assertThrows(IllegalArgumentException.class,
        () -> read("[{\"__kind\":\"activity\",\"genealogy\":\"a\",\"StartTime\":\"2026-147T00:00:00.000\"}]"));
    assertThrows(IllegalArgumentException.class, () -> read("{}"));
  }
}
