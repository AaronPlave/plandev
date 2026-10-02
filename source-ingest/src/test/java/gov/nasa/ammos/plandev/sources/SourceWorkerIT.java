package gov.nasa.ammos.plandev.sources;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.nio.file.Path;
import java.sql.SQLException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The ingest lease, against a real database with the imported-sources schema:
 *
 *   SOURCES_IT_DB_URL='jdbc:postgresql://localhost:5432/plandev?user=merlin_user&password=...' ./gradlew :source-ingest:test
 *
 * Creates and deletes its own source. Skipped without SOURCES_IT_DB_URL.
 */
@EnabledIfEnvironmentVariable(named = "SOURCES_IT_DB_URL", matches = ".+")
final class SourceWorkerIT {
  private static final int EDGE_SAMPLES = 42;
  private final SourceWorker.Config config = new SourceWorker.Config(System.getenv("SOURCES_IT_DB_URL"), null, null, null);
  private final SourceWorker worker = new SourceWorker(config);
  private Path edge;
  private int sourceId;

  @BeforeEach
  void createSource() throws Exception {
    edge = Path.of(getClass().getResource("/edge-cases.tol.xml").toURI());
    sourceId = queryInt("insert into merlin.source (name, source_type) values ('it: lease', 'xml_tol') returning id");
  }

  @AfterEach
  void deleteSource() throws SQLException {
    execute("delete from merlin.source where id = " + sourceId);
  }

  private int newRevision() throws SQLException {
    return queryInt("insert into merlin.source_revision (source_id, adapter, original_path, storage_kind) values ("
        + sourceId + ", 'xml_tol', '" + edge + "', 'pg_chunks_v1') returning id");
  }

  @Test
  void aReclaimedAttemptCannotTouchTheAttemptThatReplacedIt() throws Exception {
    final int revision = newRevision();
    final var a = worker.claim(revision);

    try (final var conn = config.connect(false);
         final var chunkConn = config.connect(true);
         final var summaryConn = config.connect(true);
         final var beatConn = config.connect(true)) {
      // A loads its catalog and streams every sample, then stalls with its COPYs still open...
      final var importerA = new SourceImporter(conn, chunkConn, summaryConn, revision, a.attempt());
      try (final var in = Inputs.open(edge)) {
        new TolAdapter().read(in, importerA);
      }
      // ...long enough for its heartbeat to go stale, so B reclaims the revision and ingests it.
      execute("update merlin.source_revision set heartbeat_at = now() - interval '2 minutes' where id = " + revision);
      final var b = worker.claim(revision);
      assertEquals(a.attempt() + 1, b.attempt());
      worker.ingest(b);

      // A resumes: every write it attempts is refused.
      assertNull(SourceWorker.heartbeat(beatConn, a, "{}"));
      assertThrows(SQLException.class, () -> importerA.finish(null));
    }
    worker.fail(a, new RuntimeException("resumed after being reclaimed"));

    assertEquals("success|2|", queryString(
        "select status || '|' || ingest_attempt || '|' || coalesce(error::text, '') from merlin.source_revision where id = " + revision));
    assertEquals(EDGE_SAMPLES, queryInt("select sum(n)::int from merlin.source_chunk where revision_id = " + revision));
    assertEquals(8, queryInt("select count(*)::int from merlin.source_resource where revision_id = " + revision));
    assertEquals(0, queryInt("select count(*)::int from merlin.source_storage_tables(" + revision + ") where attempt = 1"));
  }

  @Test
  void aCanceledRevisionFailsWithoutPublishing() throws Exception {
    final int revision = newRevision();
    final var job = worker.claim(revision);
    execute("update merlin.source_revision set canceled = true where id = " + revision);
    worker.ingest(job);

    assertEquals("failed|canceled", queryString(
        "select status || '|' || (error->>'type') from merlin.source_revision where id = " + revision));
    assertEquals(0, queryInt("select count(*)::int from merlin.source_storage_tables(" + revision + ")"));
    assertNull(worker.claim(revision), "a canceled revision is never claimed again");
  }

  @Test
  void aLiveAttemptIsNotReclaimed() throws Exception {
    final int revision = newRevision();
    final var job = worker.claim(revision);
    assertNull(worker.claim(revision));
    try (final var c = config.connect(true)) {
      assertEquals(Boolean.FALSE, SourceWorker.heartbeat(c, job, "{}"));
    }
    worker.ingest(job);
    assertTrue(queryString("select status from merlin.source_revision where id = " + revision).equals("success"));
  }

  private void execute(String sql) throws SQLException {
    try (final var c = config.connect(true); final var st = c.createStatement()) {
      st.execute(sql);
    }
  }

  private int queryInt(String sql) throws SQLException {
    return Integer.parseInt(queryString(sql));
  }

  private String queryString(String sql) throws SQLException {
    try (final var c = config.connect(true); final var st = c.createStatement(); final var rs = st.executeQuery(sql)) {
      rs.next();
      return rs.getString(1);
    }
  }
}
