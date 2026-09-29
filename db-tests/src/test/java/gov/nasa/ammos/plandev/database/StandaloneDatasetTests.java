package gov.nasa.ammos.plandev.database;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.postgresql.PGConnection;

import java.io.IOException;
import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SPIKE: a merlin.dataset owned by a merlin.standalone_dataset wrapper, with no plan, model, or simulation.
 */
@SuppressWarnings("SqlSourceToSinkFlow")
public class StandaloneDatasetTests {
  private static DatabaseTestHelper helper;
  private static Connection connection;
  private static MerlinDatabaseTestHelper merlinHelper;

  @BeforeAll
  static void beforeAll() throws SQLException, IOException, InterruptedException {
    helper = new DatabaseTestHelper("plandev_standalone_dataset_tests", "Standalone Dataset Tests");
    connection = helper.connection();
    merlinHelper = new MerlinDatabaseTestHelper(connection);
    // merlin.delete_partitions() drops partitions by unqualified name, so it needs merlin on the search_path
    // (as Hasura's connection has). Pre-existing behavior shared with simulation datasets; see SPIKE_FINDINGS.md.
    try (final var statement = connection.createStatement()) {
      statement.execute("set search_path to merlin, public");
    }
  }

  @AfterAll
  static void afterAll() throws SQLException, IOException, InterruptedException {
    helper.close();
  }

  @AfterEach
  void afterEach() throws SQLException {
    helper.clearSchema("merlin");
  }

  //region Helper Methods
  private record StandaloneDataset(int id, int datasetId) {}

  private StandaloneDataset insertStandaloneDataset() throws SQLException {
    try (final var statement = connection.createStatement()) {
      final var res = statement.executeQuery(
          //language=sql
          """
          insert into merlin.standalone_dataset (name, start_time, end_time)
          values ('test', '2029-01-01T00:00:00Z', '2029-01-03T00:00:00Z')
          returning id, dataset_id;
          """);
      res.next();
      return new StandaloneDataset(res.getInt("id"), res.getInt("dataset_id"));
    }
  }

  private void insertProfileAndSpan(final int datasetId) throws SQLException {
    try (final var statement = connection.createStatement()) {
      statement.execute(
          //language=sql
          """
          with p as (
            insert into merlin.profile (dataset_id, name, type, duration)
            values (%1$d, '/power/load', '{"type": "real", "schema": {"type": "real"}}', '48h')
            returning id
          )
          insert into merlin.profile_segment (dataset_id, profile_id, start_offset, dynamics, is_gap)
          select %1$d, p.id, v.start_offset::interval, v.dynamics::jsonb, v.is_gap
          from p, (values ('0h', '{"initial": 1, "rate": 0}', false), ('1h', null, true)) v(start_offset, dynamics, is_gap);

          insert into merlin.span (dataset_id, span_id, parent_id, start_offset, duration, type, attributes)
          values (%1$d, 1, null, '1h', '1h', 'OBSERVE', '{"arguments": {}, "computedAttributes": {}}');
          """.formatted(datasetId));
    }
  }

  private int count(final String sql) throws SQLException {
    try (final var statement = connection.createStatement()) {
      final var res = statement.executeQuery(sql);
      res.next();
      return res.getInt(1);
    }
  }

  private boolean datasetExists(final int datasetId) throws SQLException {
    return count("select count(*) from merlin.dataset where id = %d".formatted(datasetId)) == 1;
  }

  private List<String> partitionsFor(final int datasetId) throws SQLException {
    final var partitions = new ArrayList<String>();
    try (final var statement = connection.createStatement()) {
      final var res = statement.executeQuery(
          //language=sql
          """
          select tablename from pg_tables
          where schemaname = 'merlin'
            and tablename in ('profile_segment_%1$d', 'span_%1$d', 'event_%1$d')
          order by tablename;
          """.formatted(datasetId));
      while (res.next()) partitions.add(res.getString(1));
    }
    return partitions;
  }
  //endregion

  @Test
  void insertAllocatesOwnDatasetAndPartitions() throws SQLException {
    final var standalone = insertStandaloneDataset();
    assertTrue(datasetExists(standalone.datasetId()));
    assertEquals(
        List.of("event_" + standalone.datasetId(),
                "profile_segment_" + standalone.datasetId(),
                "span_" + standalone.datasetId()),
        partitionsFor(standalone.datasetId()));
  }

  @Test
  void requiresNoPlanModelOrSimulation() throws SQLException {
    final var standalone = insertStandaloneDataset();
    insertProfileAndSpan(standalone.datasetId());

    assertEquals(0, count("select count(*) from merlin.plan"));
    assertEquals(0, count("select count(*) from merlin.mission_model"));
    assertEquals(0, count("select count(*) from merlin.simulation"));
    assertEquals(0, count("select count(*) from merlin.simulation_dataset"));
    assertEquals(0, count("select count(*) from merlin.plan_dataset"));
    assertEquals(0, count("select count(*) from merlin.resource_type"));
    assertEquals(0, count("select count(*) from merlin.activity_type"));

    // Profile schemas and spans are queryable by dataset alone.
    assertEquals(1, count(
        "select count(*) from merlin.profile where dataset_id = %d and type->'schema'->>'type' = 'real'"
            .formatted(standalone.datasetId())));
    assertEquals(1, count(
        "select count(*) from merlin.profile_segment where dataset_id = %d and is_gap"
            .formatted(standalone.datasetId())));
    assertEquals(1, count(
        "select count(*) from merlin.span where dataset_id = %d and type = 'OBSERVE'"
            .formatted(standalone.datasetId())));
  }

  @Test
  void insertDoesNotNotifySimulationWorkers() throws SQLException {
    try (final var statement = connection.createStatement()) {
      statement.execute("listen simulation_notification");
    }
    try {
      final var standalone = insertStandaloneDataset();
      insertProfileAndSpan(standalone.datasetId());
      // Round-trip so any pending notifications are delivered to this connection.
      count("select 1");
      final var notifications = connection.unwrap(PGConnection.class).getNotifications();
      assertTrue(notifications == null || notifications.length == 0);
    } finally {
      try (final var statement = connection.createStatement()) {
        statement.execute("unlisten simulation_notification");
      }
    }
  }

  @Test
  void rejectsEndBeforeStart() {
    final var ex = assertThrows(SQLException.class, () -> {
      try (final var statement = connection.createStatement()) {
        statement.execute(
            //language=sql
            """
            insert into merlin.standalone_dataset (name, start_time, end_time)
            values ('bad', '2029-01-03T00:00:00Z', '2029-01-01T00:00:00Z');
            """);
      }
    });
    assertTrue(ex.getMessage().contains("standalone_dataset_end_after_start"));
  }

  @Nested
  class Lifecycle {
    @Test
    void deletingWrapperDeletesOwnedDataset() throws SQLException {
      final var standalone = insertStandaloneDataset();
      final var other = insertStandaloneDataset();
      insertProfileAndSpan(standalone.datasetId());
      insertProfileAndSpan(other.datasetId());

      try (final var statement = connection.createStatement()) {
        statement.execute("delete from merlin.standalone_dataset where id = %d".formatted(standalone.id()));
      }

      assertFalse(datasetExists(standalone.datasetId()));
      assertEquals(List.of(), partitionsFor(standalone.datasetId()));
      assertEquals(0, count("select count(*) from merlin.profile where dataset_id = %d".formatted(standalone.datasetId())));

      // The other wrapper and its data are untouched.
      assertTrue(datasetExists(other.datasetId()));
      assertEquals(1, count("select count(*) from merlin.span where dataset_id = %d".formatted(other.datasetId())));
      assertEquals(1, count("select count(*) from merlin.standalone_dataset"));
    }

    @Test
    void deletingDatasetDirectlyDeletesWrapperWithoutError() throws SQLException {
      final var standalone = insertStandaloneDataset();
      insertProfileAndSpan(standalone.datasetId());

      // FK cascade removes the wrapper, whose after-delete trigger then finds no dataset to delete.
      try (final var statement = connection.createStatement()) {
        assertEquals(1, statement.executeUpdate("delete from merlin.dataset where id = %d".formatted(standalone.datasetId())));
      }

      assertEquals(0, count("select count(*) from merlin.standalone_dataset"));
      assertEquals(List.of(), partitionsFor(standalone.datasetId()));
    }

    @Test
    void cannotChangeOwnedDataset() throws SQLException {
      final var standalone = insertStandaloneDataset();
      final var other = insertStandaloneDataset();
      final var ex = assertThrows(SQLException.class, () -> {
        try (final var statement = connection.createStatement()) {
          statement.execute("update merlin.standalone_dataset set dataset_id = %d where id = %d"
                                .formatted(other.datasetId(), standalone.id()));
        }
      });
      assertNotEquals(-1, ex.getMessage().indexOf("Cannot change the dataset"));
    }

    @Test
    void cannotAdoptPlanOwnedDataset() throws SQLException {
      final int modelId = merlinHelper.insertMissionModel(merlinHelper.insertFileUpload());
      final int planId = merlinHelper.insertPlan(modelId);
      final var planDataset = merlinHelper.insertPlanDataset(planId);

      final var ex = assertThrows(SQLException.class, () -> {
        try (final var statement = connection.createStatement()) {
          statement.execute(
              //language=sql
              """
              insert into merlin.standalone_dataset (name, dataset_id, start_time, end_time)
              values ('adopt', %d, '2029-01-01T00:00:00Z', '2029-01-02T00:00:00Z');
              """.formatted(planDataset.datasetId()));
        }
      });
      assertTrue(ex.getMessage().contains("already owned"));
      assertTrue(datasetExists(planDataset.datasetId()));
    }

    @Test
    void canAdoptUnownedDataset() throws SQLException {
      final int datasetId;
      try (final var statement = connection.createStatement()) {
        final var res = statement.executeQuery("insert into merlin.dataset default values returning id");
        res.next();
        datasetId = res.getInt(1);
        statement.execute(
            //language=sql
            """
            insert into merlin.standalone_dataset (name, dataset_id, start_time, end_time)
            values ('adopt', %d, '2029-01-01T00:00:00Z', '2029-01-02T00:00:00Z');
            """.formatted(datasetId));
        statement.execute("delete from merlin.standalone_dataset");
      }
      assertFalse(datasetExists(datasetId));
    }
  }
}
