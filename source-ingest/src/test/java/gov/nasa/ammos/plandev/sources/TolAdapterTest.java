package gov.nasa.ammos.plandev.sources;

import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class TolAdapterTest {
  private static final long T0 = 1893456000L * 1_000_000L; // 2030-001T00:00:00Z

  private record Sample(int resource, long t, double num, String text, byte kind) {}

  private static final class Collect implements SourceAdapter.Sink {
    final List<SourceAdapter.ResourceDecl> decls = new ArrayList<>();
    final List<Sample> samples = new ArrayList<>();
    final List<SourceAdapter.ActivityRecord> activities = new ArrayList<>();
    int declaredBeforeFirstSample = -1;

    @Override public void declare(SourceAdapter.ResourceDecl decl) { decls.add(decl); }

    @Override public void manifestComplete() { declaredBeforeFirstSample = decls.size(); }

    @Override public void sample(int resource, long t, double num, String text, byte kind) {
      samples.add(new Sample(resource, t, num, text, kind));
    }

    @Override public void activity(SourceAdapter.ActivityRecord activity) {
      if (declaredBeforeFirstSample < 0) throw new AssertionError("activity before the manifest");
      activities.add(activity);
    }

    int id(String key) {
      for (int i = 0; i < decls.size(); i++) if (decls.get(i).key().equals(key)) return i;
      throw new AssertionError("no resource " + key);
    }

    List<Sample> of(String key) {
      final int id = id(key);
      return samples.stream().filter(s -> s.resource == id).toList();
    }
  }

  private static Collect read() throws Exception {
    return read("/edge-cases.tol.xml");
  }

  private static Collect read(String resource) throws Exception {
    final var sink = new Collect();
    try (final var in = TolAdapterTest.class.getResourceAsStream(resource)) {
      new TolAdapter().read(in, sink);
    }
    return sink;
  }

  private static long at(String hms) {
    final var parts = hms.split(":");
    return T0 + ((Long.parseLong(parts[0]) * 60 + Long.parseLong(parts[1])) * 60 + Long.parseLong(parts[2])) * 1_000_000L;
  }

  @Test
  void activitiesEndAfterTheirSpanElseAtTheirActEndElseAtTheirStart() throws Exception {
    final var sink = read("/activities.tol.xml");
    // Emitted as they end (Pass_1 and Turn_2 were open together); never-ended ones at the end of the file.
    assertEquals(List.of("Pass_0", "Turn_2", "Pass_1", "Tour_4", "Turn_3", "Turn_5"),
        sink.activities.stream().map(SourceAdapter.ActivityRecord::key).toList());
    final var byKey = new java.util.HashMap<String, SourceAdapter.ActivityRecord>();
    sink.activities.forEach(a -> byKey.put(a.key(), a));
    assertEquals(at("00:00:00"), byKey.get("Pass_0").startMicros());
    assertEquals(at("01:00:00"), byKey.get("Pass_0").endMicros()); // its 1 h span, not its ACT_END
    assertTrue(byKey.get("Pass_0").metadata().contains("\"actEnd\":\"2030-001T01:30:00.000\""));
    assertEquals(at("03:00:00"), byKey.get("Pass_1").endMicros()); // no span: its ACT_END
    assertEquals(at("03:45:00"), byKey.get("Turn_3").endMicros()); // no ACT_END: start + span
    assertEquals(at("05:00:00"), byKey.get("Turn_5").endMicros()); // neither: its start
    assertEquals(T0 + 86_400_000_000L, byKey.get("Tour_4").endMicros());
    assertEquals(1, sink.samples.size() / 2); // resources are read alongside
  }

  @Test
  void activitiesKeepTheirMetadataAndTypedValues() throws Exception {
    final var pass = read("/activities.tol.xml").activities.get(0);
    assertEquals("Pass", pass.type());
    assertEquals("Pass_DSS-14", pass.name());
    assertEquals("DSN", pass.category());
    assertEquals("{\"Color\":\"Orange\",\"subsystem\":\"DSN\",\"legend\":\"Passes\",\"span\":3600000,"
        + "\"start\":\"2030-001T00:00:00.000\"}", pass.attributes());
    assertEquals("{\"station\":\"DSS-14\",\"elevation\":26.5,\"count\":3,\"prime\":true,"
        + "\"stations\":[\"DSS-24\",\"DSS-36\"],\"max\":{\"units\":\"DEGREES\",\"value\":41.25},"
        + "\"nested\":[{\"a\":1}],\"bad\":\"NaN\"}", pass.parameters());
    assertEquals("{\"parent\":\"Pass_DSS-14\",\"visibility\":\"visible\",\"actEnd\":\"2030-001T01:30:00.000\"}",
        pass.metadata());
  }

  @Test
  void manifestIsCompleteBeforeAnySample() throws Exception {
    final var sink = read();
    assertEquals(8, sink.declaredBeforeFirstSample);
    assertEquals(8, sink.decls.size());
  }

  @Test
  void arrayedResourcesAreDistinctByIndex() throws Exception {
    final var sink = read();
    assertEquals(2, sink.of("Arr[A]").size());
    assertEquals(1, sink.of("Arr[B]").size());
    assertEquals(List.of("A"), sink.decls.get(sink.id("Arr[A]")).index());
  }

  @Test
  void declarationsCarryCatalogMetadata() throws Exception {
    final var line = read().decls.get(1);
    assertEquals("Line", line.key());
    assertEquals("linear", line.interpolation());
    assertEquals("deg", line.units());
    assertEquals("GNC", line.category());
    assertTrue(line.numeric());
    assertFalse(read().decls.get(2).numeric()); // Mode is a string
  }

  @Test
  void aRecordWithoutAValueIsAValidNull() throws Exception {
    final var mode = read().of("Mode");
    final var nullSample = mode.get(3);
    assertEquals(T0 + 35_000_000L, nullSample.t());
    assertEquals(SourceAdapter.NULL, nullSample.kind());
    assertNull(nullSample.text());
    assertEquals("SAFE", mode.get(4).text());
  }

  @Test
  void duplicateTimestampsAndFileOrderArePreserved() throws Exception {
    final var dup = read().of("Dup");
    assertEquals(List.of(1.0, 2.0, 3.0, 4.0), dup.stream().map(Sample::num).toList());
    assertEquals(dup.get(1).t(), dup.get(2).t());
    final var late = read().of("Late");
    assertEquals(List.of(1.0, 3.0, 2.0, 4.0, 0.5), late.stream().map(Sample::num).toList());
  }

  @Test
  void aRecordForAnUndeclaredResourceIsAnError() {
    final var xml = """
        <XML_TOL><ResourceMetadata>
        <ResourceSpec><Name>Known</Name><DataType>float</DataType></ResourceSpec>
        </ResourceMetadata>
        <TOLrecord type="RES_VAL"><TimeStamp>2030-001T00:00:00</TimeStamp><Resource><Name>Known</Name><DoubleValue>1</DoubleValue></Resource></TOLrecord>
        <TOLrecord type="RES_VAL"><TimeStamp>2030-001T00:00:01</TimeStamp><Resource><Name>Other</Name><Index level="0">A</Index><DoubleValue>2</DoubleValue></Resource></TOLrecord>
        </XML_TOL>""";
    final var sink = new Collect();
    final var e = assertThrows(IllegalArgumentException.class,
        () -> new TolAdapter().read(new java.io.ByteArrayInputStream(xml.getBytes(java.nio.charset.StandardCharsets.UTF_8)), sink));
    assertEquals("TOL record references undeclared resource Other[A]", e.getMessage());
    assertEquals(1, sink.decls.size());
  }

  @Test
  void parsesDayOfYearTimestamps() {
    assertEquals(T0, TolAdapter.parseTime("2030-001T00:00:00"));
    assertEquals(T0 + 1_500L, TolAdapter.parseTime("2030-001T00:00:00.0015"));
    assertEquals(T0 + 59L * 86_400_000_000L + 3_723_456_789L, TolAdapter.parseTime("2030-060T01:02:03.456789"));
    assertThrows(IllegalArgumentException.class, () -> TolAdapter.parseTime("2030-01-01T00:00:00"));
  }
}
