package gov.nasa.ammos.plandev.sources;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

import java.nio.file.Path;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * Imported activities, against a real database with the imported-sources schema:
 *
 *   SOURCES_IT_DB_URL='jdbc:postgresql://localhost:5432/plandev?user=merlin_user&password=...' ./gradlew :source-ingest:test
 *
 * Ingests src/test/resources/activities.tol.xml through the worker, checks what was stored and how it is read
 * (by window, by type catalog, through merlin.analysis_activity), then deletes it. Skipped without SOURCES_IT_DB_URL.
 */
@EnabledIfEnvironmentVariable(named = "SOURCES_IT_DB_URL", matches = ".+")
final class ActivityIngestIT {
  private final SourceWorker.Config config = new SourceWorker.Config(System.getenv("SOURCES_IT_DB_URL"), null, null, null);
  private final SourceWorker worker = new SourceWorker(config);
  private int sourceId;
  private int revision;

  @BeforeEach
  void ingest() throws Exception {
    final var file = Path.of(getClass().getResource("/activities.tol.xml").toURI());
    sourceId = Integer.parseInt(query("insert into merlin.source (name, source_type) values ('it: activities', 'xml_tol') returning id").get(0));
    revision = Integer.parseInt(query("insert into merlin.source_revision (source_id, adapter, original_path, storage_kind) values ("
        + sourceId + ", 'xml_tol', '" + file + "', 'pg_chunks_v1') returning id").get(0));
    worker.ingest(worker.claim(revision));
  }

  @AfterEach
  void deleteSource() throws SQLException {
    query("delete from merlin.source where id = " + sourceId + " returning id");
  }

  @Test
  void storesActivitiesWithTheirEndsAndMetadata() throws Exception {
    assertEquals(List.of("success|6"), query("select status || '|' || (progress->>'activities') from merlin.source_revision where id = " + revision));
    assertEquals(List.of(
        "0|Pass_0|Pass|Pass_DSS-14|DSN|2030-01-01 00:00:00+00|2030-01-01 01:00:00+00",
        "1|Turn_2|Turn|Turn|GNC|2030-01-01 02:10:00+00|2030-01-01 02:20:00+00",
        "2|Pass_1|Pass|Pass_DSS-43|DSN|2030-01-01 02:00:00+00|2030-01-01 03:00:00+00",
        "3|Tour_4|modeling_control|Tour|Control|2030-01-01 00:30:00+00|2030-01-02 00:00:00+00",
        "4|Turn_3|Turn|Turn|Ground|2030-01-01 03:30:00+00|2030-01-01 03:45:00+00",
        "5|Turn_5|Turn|Turn|GNC|2030-01-01 05:00:00+00|2030-01-01 05:00:00+00"),
        query("set timezone = 'UTC'; select concat_ws('|', id, source_key, type, name, category, start_time, end_time)"
            + " from merlin.source_activity where revision_id = " + revision + " order by id"));
    assertEquals(List.of("41.25|Passes|Pass_DSS-14|[\"DSS-24\", \"DSS-36\"]"), query(
        "select concat_ws('|', parameters->'max'->>'value', attributes->>'legend', metadata->>'parent', parameters->'stations')"
            + " from merlin.source_activity where revision_id = " + revision + " and source_key = 'Pass_0'"));
  }

  @Test
  void catalogsTypesAndReadsByWindow() throws Exception {
    assertEquals(List.of("Pass|2|DSN", "Turn|3|GNC", "modeling_control|1|Control"),
        query("select concat_ws('|', type, count, category) from merlin.source_activity_type where revision_id = "
            + revision + " order by type collate \"C\""));
    // Overlapping [01:00, 02:15): including the day-long activity that started before it, and the pass ending at 01:00.
    assertEquals(List.of("Pass_0", "Pass_1", "Tour_4", "Turn_2"), query(
        "select source_key from merlin.source_activities_in_window(" + revision
            + ", '2030-01-01T01:00:00Z', '2030-01-01T02:15:00Z') order by source_key"));
    assertEquals(List.of("revision|Pass_DSS-14|Pass", "revision|Pass_DSS-43|Pass"), query(
        "select concat_ws('|', source_kind, name, type) from merlin.analysis_activity where source_kind = 'revision'"
            + " and source_ref = " + revision + " and type = 'Pass' order by start_time"));
  }

  @Test
  void deletingTheRevisionDropsItsActivities() throws Exception {
    query("delete from merlin.source_revision where id = " + revision + " returning id");
    assertEquals(List.of("0|0"), query("select (select count(*) from pg_class where relname ~ '^source_activity_" + revision
        + "_\\d+$') || '|' || (select count(*) from merlin.source_activity_type where revision_id = " + revision + ")"));
  }

  /** Runs `sql` (the last statement may return rows) and returns the first column of each row. */
  private List<String> query(String sql) throws SQLException {
    try (final var c = config.connect(true); final var st = c.createStatement()) {
      final List<String> out = new ArrayList<>();
      boolean results = st.execute(sql);
      while (true) {
        if (results) {
          try (final var rs = st.getResultSet()) {
            while (rs.next()) out.add(rs.getString(1));
          }
        } else if (st.getUpdateCount() == -1) {
          break;
        }
        results = st.getMoreResults();
      }
      return out;
    }
  }
}
