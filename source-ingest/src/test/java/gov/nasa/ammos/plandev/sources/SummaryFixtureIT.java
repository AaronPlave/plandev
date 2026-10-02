package gov.nasa.ammos.plandev.sources;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.io.InputStream;
import java.sql.SQLException;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Ingests a synthetic revision large enough to have stored summary levels and multi-chunk resources,
 * and checks what the importer stored. The revision is kept, replacing any earlier one, as the fixture
 * for the gateway's summary and paging tests (plandev-gateway test/sources.pg-chunks.test.ts):
 *
 *   SOURCES_IT_DB_URL='jdbc:postgresql://localhost:5432/plandev?user=merlin_user&password=...' ./gradlew :source-ingest:test
 *
 * Every summary resource has a sample per second for SPAN seconds and one short event at EVENT seconds,
 * inside a summary bucket and not its first sample. Times are seconds after 2030-001T00:00:00Z.
 */
@EnabledIfEnvironmentVariable(named = "SOURCES_IT_DB_URL", matches = ".+")
final class SummaryFixtureIT {
  static final String NAME = "it: summary fixture";
  static final long T0 = 1893456000L * 1_000_000L;
  static final int SPAN = 16_384;
  static final int EVENT = 5000;
  static final int PAGED = 5000;

  private final SourceWorker.Config config = new SourceWorker.Config(System.getenv("SOURCES_IT_DB_URL"), null, null, null);

  private static long s(long seconds) { return T0 + seconds * 1_000_000L; }

  /** Paged: sample i is at second i, except two runs of equal timestamps, one straddling the first chunk boundary. */
  static long pagedSecond(int i) {
    if (i >= 1020 && i < 1030) return 1020;
    if (i >= 3000 && i < 3020) return 3000;
    return i;
  }

  private static SourceAdapter.ResourceDecl decl(String key, boolean numeric) {
    return new SourceAdapter.ResourceDecl(key, key, List.of(), numeric ? "float" : "string", numeric, "",
        numeric ? "linear" : "constant", "IT", List.of(), null, null);
  }

  /** The fixture as an adapter would stream it. */
  private static final SourceAdapter FIXTURE = new SourceAdapter() {
    @Override public String name() { return "it_summary"; }
    @Override public String version() { return "1"; }
    @Override public boolean probe(byte[] head) { return true; }

    @Override
    public void read(InputStream in, Sink sink) throws Exception {
      for (final var key : List.of("NumGap", "NumNull")) sink.declare(decl(key, true));
      for (final var key : List.of("DiscABA", "DiscNull", "DiscGap", "DiscMixed")) sink.declare(decl(key, false));
      sink.declare(decl("Paged", true));
      sink.manifestComplete();
      for (int i = 0; i < SPAN; i++) {
        final long t = s(i);
        final boolean event = i == EVENT;
        sink.sample(0, t, event ? Double.NaN : 10, null, event ? GAP : VALUE);
        sink.sample(1, t, event ? Double.NaN : 10, null, event ? NULL : VALUE);
        sink.sample(2, t, Double.NaN, event ? "B" : "A", VALUE);
        sink.sample(3, t, Double.NaN, event ? null : "A", event ? NULL : VALUE);
        sink.sample(4, t, Double.NaN, event ? null : "A", event ? GAP : VALUE);
        if (i == EVENT) sink.sample(5, t, Double.NaN, "B", VALUE);
        else if (i == EVENT + 1) sink.sample(5, t, Double.NaN, null, GAP);
        else sink.sample(5, t, Double.NaN, "A", VALUE);
      }
      for (int i = 0; i < PAGED; i++) sink.sample(6, s(pagedSecond(i)), i, null, VALUE);
    }
  };

  @Test
  void ingestsTheFixtureAndStoresEveryVisibleEventInItsSummaries() throws Exception {
    final int revision;
    try (final var c = config.connect(false)) {
      try (final var st = c.createStatement()) {
        st.execute("delete from merlin.source where name = '" + NAME + "'");
        try (final var rs = st.executeQuery("insert into merlin.source (name, source_type) values ('" + NAME + "', 'synthetic') returning id")) {
          rs.next();
          try (final var st2 = c.createStatement(); final var rs2 = st2.executeQuery(
              "insert into merlin.source_revision (source_id, adapter, original_path, storage_kind) values ("
                  + rs.getInt(1) + ", 'it_summary', 'synthetic', 'pg_chunks_v1') returning id")) {
            rs2.next();
            revision = rs2.getInt(1);
          }
        }
      }
      c.commit();
    }
    final var job = new SourceWorker(config).claim(revision);
    try (final var conn = config.connect(false);
         final var chunkConn = config.connect(true);
         final var summaryConn = config.connect(true)) {
      final var importer = new SourceImporter(conn, chunkConn, summaryConn, revision, job.attempt());
      FIXTURE.read(InputStream.nullInputStream(), importer);
      importer.finish(null);
    }

    assertEquals("success", query("select status from merlin.source_revision where id = " + revision));
    // 64 s buckets and coarser: one summary row per 64 samples is the first level that reduces 32x.
    assertEquals("[3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]",
        query("select storage->>'levels' from merlin.source_resource where revision_id = " + revision + " and key = 'NumGap'"));
    final String bucket = "s.level = 3 and s.first_t <= " + s(EVENT) + " and s.last_t >= " + s(EVENT);
    assertEquals(s(EVENT) + "|2|", summary(revision, "NumGap", bucket, "nonvalue_t || '|' || nonvalue_kind || '|' || coalesce(change_t::text, '')"));
    assertEquals(s(EVENT) + "|1", summary(revision, "NumNull", bucket, "nonvalue_t || '|' || nonvalue_kind"));
    assertEquals("A|A|" + s(EVENT) + "|0|B|", summary(revision, "DiscABA", bucket,
        "first_s || '|' || last_s || '|' || change_t || '|' || change_kind || '|' || change_s || '|' || coalesce(nonvalue_t::text, '')"));
    assertEquals(s(EVENT) + "|1|" + s(EVENT) + "|1", summary(revision, "DiscNull", bucket,
        "change_t || '|' || change_kind || '|' || nonvalue_t || '|' || nonvalue_kind"));
    assertEquals(s(EVENT) + "|2|" + s(EVENT) + "|2", summary(revision, "DiscGap", bucket,
        "change_t || '|' || change_kind || '|' || nonvalue_t || '|' || nonvalue_kind"));
    assertEquals(s(EVENT) + "|B|" + s(EVENT + 1) + "|2", summary(revision, "DiscMixed", bucket,
        "change_t || '|' || change_s || '|' || nonvalue_t || '|' || nonvalue_kind"));

    // A chunk never splits a timestamp, so the run at the first 1024-sample boundary makes that chunk longer.
    final String paged = " from merlin.source_chunk c join merlin.source_resource r on r.revision_id = c.revision_id"
        + " and r.id = c.resource_id where c.revision_id = " + revision + " and r.key = 'Paged'";
    assertEquals("1030", query("select c.n" + paged + " order by c.t1 limit 1"));
    assertEquals("t", query("select bool_and(t0 > prev) from (select c.t0, lag(c.t1) over (order by c.t1) as prev" + paged + ") c"));
    assertTrue(Integer.parseInt(query("select (storage->>'chunks') from merlin.source_resource where revision_id = "
        + revision + " and key = 'Paged'")) >= 4);
  }

  private String summary(int revision, String key, String where, String select) throws SQLException {
    return query("select " + select + " from merlin.source_summary s join merlin.source_resource r"
        + " on r.revision_id = s.revision_id and r.id = s.resource_id"
        + " where s.revision_id = " + revision + " and r.key = '" + key + "' and " + where);
  }

  private String query(String sql) throws SQLException {
    try (final var c = config.connect(true); final var st = c.createStatement(); final var rs = st.executeQuery(sql)) {
      return rs.next() ? rs.getString(1) : null;
    }
  }
}
