package gov.nasa.ammos.plandev.sources;

import org.postgresql.PGConnection;

import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CancellationException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Runs ingest jobs. A job is a {@code merlin.source_revision} row: the worker claims a pending one
 * (or one whose worker stopped heartbeating), streams its file through the adapter it names into
 * {@link SourceImporter}, and records progress, failure or success on the row. Nothing about a job
 * lives in this process, so a crash loses at most the attempt in progress, which another worker
 * restarts once the heartbeat goes stale.
 *
 * Each claim increments {@code ingest_attempt}, and that number is the claim's lease: every write the
 * attempt makes (heartbeat, catalog, storage, success or failure) requires it to still be current. A
 * worker that stalls long enough to be reclaimed finds out at its next write, and stops without
 * touching the newer attempt's state or storage.
 */
final class SourceWorker {
  private static final List<SourceAdapter> ADAPTERS = List.of(new TolAdapter());
  private static final int HEARTBEAT_SECONDS = 5;
  private static final int STALE_SECONDS = 60;

  record Config(String url, String user, String password, Path fileStore) {
    static Config fromEnv() {
      final var env = System.getenv();
      return new Config(
          env.getOrDefault("PLANDEV_DB_URL", "jdbc:postgresql://localhost:5432/plandev"),
          env.getOrDefault("PLANDEV_DB_USER", "merlin_user"),
          env.getOrDefault("PLANDEV_DB_PASSWORD", ""),
          Path.of(env.getOrDefault("PLANDEV_FILE_STORE", "/usr/src/app/merlin_file_store")));
    }

    Connection connect(boolean autoCommit) throws SQLException {
      final var c = DriverManager.getConnection(url, user, password);
      c.setAutoCommit(autoCommit);
      return c;
    }
  }

  record Job(int revisionId, int attempt, String adapter, Path path) {}

  private final Config config;

  SourceWorker(Config config) { this.config = config; }

  /** Claims and runs jobs until none are left ({@code once}) or forever, waking on new jobs. */
  void run(boolean once) throws Exception {
    try (final var listen = config.connect(true)) {
      if (!once) try (final var st = listen.createStatement()) { st.execute("listen source_revision_pending"); }
      while (true) {
        final var job = claim(null);
        if (job != null) {
          ingest(job);
          continue;
        }
        if (once) return;
        // Woken by the insert trigger; the timeout also picks up revisions whose worker died.
        listen.unwrap(PGConnection.class).getNotifications(STALE_SECONDS * 1000 / 2);
      }
    }
  }

  /** Claims the oldest runnable revision (or only {@code revisionId}), starting a new attempt at it. */
  Job claim(Integer revisionId) throws SQLException {
    try (final var c = config.connect(true);
         final var st = c.prepareStatement("""
             update merlin.source_revision r
                set status = 'incomplete', started_at = now(), heartbeat_at = now(), finished_at = null,
                    error = null, progress = '{}'::jsonb, ingest_attempt = r.ingest_attempt + 1
              where r.id = (
                select id from merlin.source_revision
                 where not canceled
                   and (status = 'pending' or (status = 'incomplete' and heartbeat_at < now() - make_interval(secs => ?)))
                   and (?::integer is null or id = ?::integer)
                 order by requested_at
                 for update skip locked
                 limit 1)
             returning r.id, r.ingest_attempt, r.adapter, r.original_path,
                       (select convert_from(f.path, 'UTF8') from merlin.uploaded_file f where f.id = r.original_file_id)""")) {
      st.setInt(1, STALE_SECONDS);
      st.setObject(2, revisionId, java.sql.Types.INTEGER);
      st.setObject(3, revisionId, java.sql.Types.INTEGER);
      try (final var rs = st.executeQuery()) {
        if (!rs.next()) return null;
        final var path = rs.getString(4) != null ? Path.of(rs.getString(4)) : config.fileStore.resolve(rs.getString(5));
        return new Job(rs.getInt(1), rs.getInt(2), rs.getString(3), path);
      }
    }
  }

  /**
   * Refreshes the job's heartbeat and progress. Returns null when the attempt has lost its lease, else
   * whether the revision was canceled.
   */
  static Boolean heartbeat(Connection c, Job job, String progress) throws SQLException {
    try (final var st = c.prepareStatement("""
        update merlin.source_revision
           set heartbeat_at = now(), progress = progress || ?::jsonb
         where id = ? and ingest_attempt = ? and status = 'incomplete' returning canceled""")) {
      st.setString(1, progress);
      st.setInt(2, job.revisionId);
      st.setInt(3, job.attempt);
      try (final var rs = st.executeQuery()) {
        return rs.next() ? rs.getBoolean(1) : null;
      }
    }
  }

  void ingest(Job job) throws Exception {
    System.err.printf("revision %d attempt %d: ingesting %s with %s%n", job.revisionId, job.attempt, job.path, job.adapter);
    final long t0 = System.currentTimeMillis();
    final var bytesRead = new AtomicLong();
    final var digest = MessageDigest.getInstance("SHA-256");
    final var phase = new java.util.concurrent.atomic.AtomicReference<>("parsing");
    final var heartbeat = Executors.newSingleThreadScheduledExecutor();
    Exception failure = null;

    try (final var conn = config.connect(false);
         final var chunkConn = config.connect(true);
         final var summaryConn = config.connect(true);
         final var beatConn = config.connect(true)) {
      final var importer = new SourceImporter(conn, chunkConn, summaryConn, job.revisionId, job.attempt);
      final long total = Files.size(job.path);
      final Runnable beat = () -> {
        try {
          final var canceled = heartbeat(beatConn, job, Json.object(
              "phase", phase.get(), "bytesRead", bytesRead.get(), "bytesTotal", total, "samples", importer.samples(),
              "elapsedMs", System.currentTimeMillis() - t0,
              "catalogMs", importer.manifestAtMillis() < 0 ? null : importer.manifestAtMillis() - t0));
          if (canceled == null) importer.cancel("Ingest attempt " + job.attempt + " was reclaimed by another worker");
          else if (canceled) importer.cancel("Ingest canceled");
        } catch (SQLException e) {
          System.err.println("heartbeat failed: " + e.getMessage());
        }
      };
      heartbeat.scheduleAtFixedRate(beat, 0, HEARTBEAT_SECONDS, TimeUnit.SECONDS);

      try {
        final var adapter = ADAPTERS.stream().filter(a -> a.name().equals(job.adapter)).findFirst()
            .orElseThrow(() -> new IllegalArgumentException("No adapter named " + job.adapter));
        try (final var probe = Inputs.open(job.path)) {
          if (!adapter.probe(probe.readNBytes(4096))) {
            throw new IllegalArgumentException("File is not readable by adapter " + adapter.name());
          }
        }
        // A reclaimed job restarts from scratch.
        SourceImporter.lease(conn, job.revisionId, job.attempt);
        try (final var st = conn.prepareStatement("delete from merlin.source_resource where revision_id = ?")) {
          st.setInt(1, job.revisionId);
          st.executeUpdate();
        }
        try (final var st = conn.prepareStatement("update merlin.source_revision set adapter_version = ? where id = ?")) {
          st.setString(1, adapter.version());
          st.setInt(2, job.revisionId);
          st.executeUpdate();
        }
        conn.commit();
        try (final var in = Inputs.open(job.path, raw -> new Tap(raw, digest, bytesRead))) {
          adapter.read(in, importer);
        }
        phase.set("indexing");
        beat.run(); // a cancel or reclaim that arrived during the last interval still stops the publish
        // Written in the transaction that publishes, which holds the lease.
        try (final var st = conn.prepareStatement("update merlin.source_revision set content_hash = ? where id = ?")) {
          st.setString(1, "sha256:" + HexFormat.of().formatHex(digest.digest()));
          st.setInt(2, job.revisionId);
          st.executeUpdate();
        }
        importer.finish(null);
        try (final var st = conn.prepareStatement(
            "update merlin.source_revision set progress = progress || ?::jsonb where id = ? and ingest_attempt = ?")) {
          st.setString(1, Json.object("phase", "done", "bytesRead", bytesRead.get(), "bytesTotal", total,
              "samples", importer.samples(), "elapsedMs", System.currentTimeMillis() - t0,
              "catalogMs", importer.manifestAtMillis() - t0));
          st.setInt(2, job.revisionId);
          st.setInt(3, job.attempt);
          st.executeUpdate();
        }
        conn.commit();
        System.err.printf("revision %d: %,d samples in %.1f s%n", job.revisionId, importer.samples(),
            (System.currentTimeMillis() - t0) / 1e3);
      } catch (Exception e) {
        failure = e;
      }
    } finally {
      heartbeat.shutdownNow();
    }
    // Only once this attempt's connections are closed: an open COPY would hold the tables discard drops.
    if (failure != null) {
      fail(job, failure);
      if (!(failure instanceof CancellationException)) failure.printStackTrace();
    }
  }

  /**
   * Discards the attempt's own storage and, if it still holds the lease, marks the revision failed. A
   * reclaimed attempt changes nothing but its own (unread) tables.
   */
  void fail(Job job, Exception e) throws SQLException {
    final int updated;
    try (final var c = config.connect(true)) {
      try (final var st = c.prepareStatement("select merlin.source_storage_discard(?, ?)")) {
        st.setInt(1, job.revisionId);
        st.setInt(2, job.attempt);
        st.execute();
      }
      try (final var st = c.prepareStatement("""
          update merlin.source_revision
             set status = 'failed', finished_at = now(), error = ?::jsonb
           where id = ? and ingest_attempt = ? and status = 'incomplete'""")) {
        st.setString(1, Json.write(Map.of(
            "type", e instanceof CancellationException ? "canceled" : e.getClass().getSimpleName(),
            "message", String.valueOf(e.getMessage()))));
        st.setInt(2, job.revisionId);
        st.setInt(3, job.attempt);
        updated = st.executeUpdate();
      }
    }
    System.err.printf(updated == 1 ? "revision %d attempt %d failed: %s%n" : "revision %d attempt %d stopped, no longer current: %s%n",
        job.revisionId, job.attempt, e.getMessage());
  }

  /** Registers a file already on the server as a new pending revision. Prints the ids. */
  static void register(Config config, String name, String adapter, Path path, Integer planId, String user) throws Exception {
    try (final var c = config.connect(false)) {
      int sourceId, revisionId;
      try (final var st = c.prepareStatement(
          "insert into merlin.source (name, source_type, owner) values (?, ?, ?) returning id")) {
        st.setString(1, name);
        st.setString(2, adapter);
        st.setString(3, user);
        try (final var rs = st.executeQuery()) { rs.next(); sourceId = rs.getInt(1); }
      }
      try (final var st = c.prepareStatement("""
          insert into merlin.source_revision (source_id, adapter, original_path, storage_kind, requested_by)
          values (?, ?, ?, ?, ?) returning id""")) {
        st.setInt(1, sourceId);
        st.setString(2, adapter);
        st.setString(3, path.toAbsolutePath().toString());
        st.setString(4, SourceImporter.STORAGE_KIND);
        st.setString(5, user);
        try (final var rs = st.executeQuery()) { rs.next(); revisionId = rs.getInt(1); }
      }
      Integer bindingId = null;
      if (planId != null) {
        try (final var st = c.prepareStatement(
            "insert into merlin.plan_source (plan_id, source_revision_id, label, created_by) values (?, ?, ?, ?) returning id")) {
          st.setInt(1, planId);
          st.setInt(2, revisionId);
          st.setString(3, name);
          st.setString(4, user);
          try (final var rs = st.executeQuery()) { rs.next(); bindingId = rs.getInt(1); }
        }
      }
      c.commit();
      System.out.println(Json.object("sourceId", sourceId, "revisionId", revisionId, "planSourceId", bindingId));
    }
  }

  /** Counts and hashes the bytes of the original file as they are read. */
  private static final class Tap extends FilterInputStream {
    private final MessageDigest digest;
    private final AtomicLong count;

    Tap(InputStream in, MessageDigest digest, AtomicLong count) {
      super(in);
      this.digest = digest;
      this.count = count;
    }

    @Override
    public int read() throws IOException {
      final int b = in.read();
      if (b >= 0) { digest.update((byte) b); count.incrementAndGet(); }
      return b;
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
      final int n = in.read(b, off, len);
      if (n > 0) { digest.update(b, off, n); count.addAndGet(n); }
      return n;
    }
  }
}
