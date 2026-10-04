package gov.nasa.ammos.plandev.sources;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.nio.file.Path;
import java.sql.SQLException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * Adapter plugins through the worker, against a real database with the imported-sources schema:
 *
 *   SOURCES_IT_DB_URL='jdbc:postgresql://localhost:5432/plandev?user=merlin_user&password=...' ./gradlew :source-ingest:test
 *
 * Uses the test-scope {@link CsvActivitiesAdapter}, discovered alongside TOL. Creates and deletes its own source.
 * Skipped without SOURCES_IT_DB_URL.
 */
@EnabledIfEnvironmentVariable(named = "SOURCES_IT_DB_URL", matches = ".+")
final class AdapterIngestIT {
  private final SourceWorker.Config config = new SourceWorker.Config(System.getenv("SOURCES_IT_DB_URL"), null, null, null);
  private final SourceWorker worker = new SourceWorker(config);
  private int sourceId;

  @BeforeEach
  void createSource() throws Exception {
    sourceId = Integer.parseInt(query("insert into merlin.source (name, source_type) values ('it: adapters', 'csv') returning id"));
  }

  @AfterEach
  void deleteSource() throws SQLException {
    query("delete from merlin.source where id = " + sourceId + " returning id");
  }

  private int ingest(String resource, String adapterConfig) throws Exception {
    final var file = Path.of(getClass().getResource(resource).toURI());
    // adapter is left to its default, auto.
    final int revision = Integer.parseInt(query("insert into merlin.source_revision (source_id, original_path, storage_kind, adapter_config)"
        + " values (" + sourceId + ", '" + file + "', 'pg_chunks_v1', " + (adapterConfig == null ? "null" : "'" + adapterConfig + "'") + ") returning id"));
    worker.ingest(worker.claim(revision));
    return revision;
  }

  @Test
  void autoResolvesTheAdapterAndStoresProductMetadataAndConfig() throws Exception {
    final int revision = ingest("/activities.csv", "{\"label\": \"from config\"}");
    assertEquals("success|csv_activities|1", query(
        "select concat_ws('|', status, adapter, adapter_version) from merlin.source_revision where id = " + revision));
    assertEquals("t", query("select metadata->'product' = '{\"generatedAt\": \"2030-01-02T03:04:05Z\", \"productVersion\": \"7\","
        + " \"suggestedName\": \"Test tour\", \"mission\": {\"phase\": \"cruise\"}}'::jsonb from merlin.source_revision where id = " + revision));
    assertEquals("2|from config", query("select count(*) || '|' || min(metadata->'config'->>'label')"
        + " from merlin.source_activity where revision_id = " + revision));
  }

  @Test
  void aFileNoAdapterRecognizesFailsNamingTheInstalledAdapters() throws Exception {
    final int revision = ingest("/unknown.txt", null);
    final var error = query("select status || '|' || (error->>'message') from merlin.source_revision where id = " + revision);
    assertTrue(error.startsWith("failed|No installed adapter recognizes this file"), error);
    assertTrue(error.contains("xml_tol") && error.contains("csv_activities"), error);
  }

  @Test
  void anUninstalledAdapterFailsTheRevision() throws Exception {
    final var file = Path.of(getClass().getResource("/activities.csv").toURI());
    final int revision = Integer.parseInt(query("insert into merlin.source_revision (source_id, adapter, original_path, storage_kind)"
        + " values (" + sourceId + ", 'kml', '" + file + "', 'pg_chunks_v1') returning id"));
    worker.ingest(worker.claim(revision));
    assertTrue(query("select status || '|' || (error->>'message') from merlin.source_revision where id = " + revision)
        .startsWith("failed|No adapter kml is installed"));
  }

  @Test
  void theWorkerCatalogsItsAdapters() throws Exception {
    try (final var c = config.connect(true)) {
      worker.adapters.publish(c);
    }
    // The test adapter must not stay in the catalog the UI lists.
    final var csvSchema = query("select config_schema->'properties'->'label'->>'type' from merlin.source_adapter where id = 'csv_activities'");
    query("delete from merlin.source_adapter where id = 'csv_activities' returning id");
    assertEquals("string", csvSchema);
    assertEquals("XML TOL|{resources,activities}|", query(
        "select concat_ws('|', display_name, capabilities, coalesce(config_schema::text, '')) from merlin.source_adapter where id = 'xml_tol'"));
  }

  private String query(String sql) throws SQLException {
    try (final var c = config.connect(true); final var st = c.createStatement(); final var rs = st.executeQuery(sql)) {
      return rs.next() ? rs.getString(1) : null;
    }
  }
}
