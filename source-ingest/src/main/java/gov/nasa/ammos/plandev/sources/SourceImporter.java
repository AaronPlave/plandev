package gov.nasa.ammos.plandev.sources;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CancellationException;

/**
 * The canonical importer for storage provider {@code pg_chunks_v1}. An adapter streams records in;
 * this class validates them, packs them into chunks, builds the summary pyramid as it goes, writes
 * activities to an ordinary table, and publishes the revision. Memory is bounded by one open chunk and one bucket per level per resource,
 * never by the size of the file or of any resource.
 *
 * Records of one resource may arrive in any order and interleaved with other resources. Records
 * already in time order (the common case) are written in one pass. A resource found out of order is
 * re-sorted through a temporary table at the end (time, then arrival order), so equal timestamps keep
 * the order the file gave them. A chunk never splits samples that share a timestamp: it grows past
 * {@link #CHUNK} instead, so an exact page can be cut at a chunk boundary.
 *
 * Everything is written under the ingest attempt's lease ({@code merlin.source_ingest_lease}): into
 * tables of this attempt's own, and to the revision only while the attempt is still current.
 */
final class SourceImporter implements SourceAdapter.Sink {
  static final String STORAGE_KIND = "pg_chunks_v1";
  static final int CHUNK = 1024;
  /** Summary level k has buckets of 1 s * 4^k. */
  static final int LEVELS = 14;
  /** A level is kept only if it has at most 1/REDUCTION as many buckets as the resource has samples. */
  static final int REDUCTION = 32;
  /** Resources this small are always read raw: a whole-resource read is already bounded. */
  static final int MIN_SAMPLES_FOR_SUMMARIES = 4096;
  /** Below this many buckets a level is never abandoned mid-stream. */
  private static final int MIN_ROWS_BEFORE_DROP = 256;
  private static final long MAX_EXACT_MICROS = 1L << 53;

  private final Connection conn;
  private final Connection chunkConn;
  private final Connection summaryConn;
  private final Connection activityConn;
  private final int revisionId;
  private final int attempt;
  private final String chunkTable;
  private final String summaryTable;
  private final String activityTable;
  private final List<Res> resources = new ArrayList<>();
  private PgCopy chunks;
  private PgCopy summaries;
  private PgCopy activities;
  private int activityCount;
  private long samples;
  private long nonFinite;
  private volatile String canceled;
  private long manifestAtMillis = -1;

  SourceImporter(
      Connection conn, Connection chunkConn, Connection summaryConn, Connection activityConn, int revisionId, int attempt)
  {
    this.conn = conn;
    this.chunkConn = chunkConn;
    this.summaryConn = summaryConn;
    this.activityConn = activityConn;
    this.revisionId = revisionId;
    this.attempt = attempt;
    this.chunkTable = "merlin.source_chunk_" + revisionId + "_" + attempt;
    this.summaryTable = "merlin.source_summary_" + revisionId + "_" + attempt;
    this.activityTable = "merlin.source_activity_" + revisionId + "_" + attempt;
  }

  long samples() { return samples; }

  int activities() { return activityCount; }

  long manifestAtMillis() { return manifestAtMillis; }

  /** Stops the ingest at its next check, failing it with {@code reason}. */
  void cancel(String reason) { canceled = reason; }

  private void checkCanceled() {
    if (canceled != null) throw new CancellationException(canceled);
  }

  /** Takes the revision's row lock for the current transaction; throws if this attempt was reclaimed. */
  static void lease(Connection conn, int revisionId, int attempt) throws SQLException {
    try (final var st = conn.prepareStatement("select merlin.source_ingest_lease(?, ?)")) {
      st.setInt(1, revisionId);
      st.setInt(2, attempt);
      st.execute();
    }
  }

  @Override
  public void declare(SourceAdapter.ResourceDecl decl) {
    if (chunks != null) throw new IllegalStateException("Resource declared after samples: " + decl.key());
    resources.add(new Res(decl, resources.size()));
  }

  @Override
  public void manifestComplete() throws SQLException {
    // The catalog is committed before any data is read, so the source is browseable while it ingests.
    lease(conn, revisionId, attempt);
    try (final var st = conn.prepareStatement("""
        insert into merlin.source_resource
          (revision_id, id, key, name, index, category, data_type, numeric, interpolation, units, schema, metadata)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)""")) {
      for (final var r : resources) {
        final var d = r.decl;
        st.setInt(1, revisionId);
        st.setInt(2, r.id);
        st.setString(3, d.key());
        st.setString(4, d.name());
        st.setArray(5, conn.createArrayOf("text", d.index().toArray()));
        st.setString(6, emptyToNull(d.category()));
        st.setString(7, d.dataType());
        st.setBoolean(8, d.numeric());
        st.setString(9, "linear".equals(d.interpolation()) ? "linear" : "constant");
        st.setString(10, emptyToNull(d.units()));
        st.setString(11, Json.schema(d));
        st.setString(12, Json.object(
            "possibleStates", d.possibleStates().isEmpty() ? null : d.possibleStates(),
            "minimum", d.minimum(), "maximum", d.maximum()));
        st.addBatch();
      }
      st.executeBatch();
    }
    conn.commit();
    manifestAtMillis = System.currentTimeMillis();

    // Standalone tables, attached as partitions only when the revision is published.
    try (final var st = conn.prepareStatement("select merlin.source_storage_begin(?, ?)")) {
      st.setInt(1, revisionId);
      st.setInt(2, attempt);
      st.execute();
    }
    conn.commit();
    chunks = new PgCopy(chunkConn, chunkTable, "revision_id, resource_id, t0, t1, n, times, nums, texts, kinds");
    summaries = new PgCopy(summaryConn, summaryTable + "_staging", SUMMARY_COLUMNS);
    activities = new PgCopy(activityConn, activityTable, ACTIVITY_COLUMNS);
  }

  private static final String ACTIVITY_COLUMNS =
      "revision_id, id, source_key, type, name, category, start_time, end_time, attributes, parameters, metadata";

  private static final String SUMMARY_COLUMNS =
      "revision_id, resource_id, level, bucket, n, first_t, last_t, first_kind, last_kind, "
      + "min_t, max_t, first_v, last_v, min_v, max_v, first_s, last_s, "
      + "nonvalue_t, nonvalue_kind, change_t, change_kind, change_s";

  @Override
  public void sample(int resource, long t, double num, String text, byte kind) throws SQLException {
    if (chunks == null) manifestComplete();
    if (resource < 0 || resource >= resources.size()) throw new IllegalArgumentException("Unknown resource " + resource);
    if (t <= -MAX_EXACT_MICROS || t >= MAX_EXACT_MICROS) {
      throw new IllegalArgumentException("Timestamp out of range for " + resources.get(resource).decl.key() + ": " + t);
    }
    final var r = resources.get(resource);
    if (kind == SourceAdapter.VALUE) {
      if (r.numeric && !Double.isFinite(num)) { nonFinite++; kind = SourceAdapter.NULL; }
      if (!r.numeric && text == null) kind = SourceAdapter.NULL;
    }
    if (kind != SourceAdapter.VALUE) { num = Double.NaN; text = null; }
    if ((++samples & 0xffff) == 0) checkCanceled();
    r.add(t, num, text, kind);
  }

  @Override
  public void activity(SourceAdapter.ActivityRecord a) throws SQLException {
    if (chunks == null) manifestComplete();
    for (final long t : new long[] {a.startMicros(), a.endMicros()}) {
      if (t <= -MAX_EXACT_MICROS || t >= MAX_EXACT_MICROS) {
        throw new IllegalArgumentException("Timestamp out of range for activity " + a.key() + ": " + t);
      }
    }
    if ((++activityCount & 0xfff) == 0) checkCanceled();
    activities.row(11).int4(revisionId).int4(activityCount - 1).text(a.key()).text(a.type()).text(a.name())
        .text(emptyToNull(a.category())).timestamptz(a.startMicros()).timestamptz(Math.max(a.startMicros(), a.endMicros()))
        .jsonb(a.attributes()).jsonb(a.parameters()).jsonb(a.metadata());
  }

  /** Flushes everything, re-sorts out-of-order resources, prunes summaries, indexes and publishes. */
  void finish(Instant revisionCoverageEnd) throws SQLException {
    if (chunks == null) manifestComplete();
    checkCanceled();
    for (final var r : resources) r.close();
    chunks.finish();
    summaries.finish();
    activities.finish();

    final var unsorted = resources.stream().filter(r -> !r.sorted).toList();
    if (!unsorted.isEmpty()) resort(unsorted);

    // Keep only the summary levels that reduce enough; publishing drops the rest.
    final List<String> kept = new ArrayList<>();
    for (final var r : resources) {
      final var levels = r.keptLevels();
      r.storage = "{\"levels\":" + levels + ",\"chunks\":" + r.chunkCount + "}";
      for (final int level : levels) kept.add("{\"resource_id\":" + r.id + ",\"level\":" + level + "}");
    }
    publish(revisionCoverageEnd, "[" + String.join(",", kept) + "]");
  }

  private void publish(Instant declaredEnd, String keptLevels) throws SQLException {
    long first = Long.MAX_VALUE, last = Long.MIN_VALUE;
    try (final var st = conn.prepareStatement("""
        update merlin.source_resource
           set sample_count = ?, coverage_start = ?, coverage_end = ?, value_min = ?, value_max = ?, storage = ?::jsonb
         where revision_id = ? and id = ?""")) {
      for (final var r : resources) {
        st.setLong(1, r.count);
        st.setTimestamp(2, r.count == 0 ? null : micros(r.first));
        st.setTimestamp(3, r.count == 0 ? null : micros(r.last));
        if (r.numeric && r.max >= r.min) {
          st.setDouble(4, r.min);
          st.setDouble(5, r.max);
        } else {
          st.setNull(4, java.sql.Types.DOUBLE);
          st.setNull(5, java.sql.Types.DOUBLE);
        }
        st.setString(6, r.storage);
        st.setInt(7, revisionId);
        st.setInt(8, r.id);
        st.addBatch();
        if (r.count > 0) {
          first = Math.min(first, r.first);
          last = Math.max(last, r.last);
        }
      }
      st.executeBatch();
    }
    try (final var st = conn.prepareStatement("select merlin.source_storage_publish(?, ?, ?::jsonb)")) {
      st.setInt(1, revisionId);
      st.setInt(2, attempt);
      st.setString(3, keptLevels);
      st.execute();
    }
    try (final var st = conn.prepareStatement("""
        update merlin.source_revision
           set status = 'success', finished_at = now(), coverage_start = ?, coverage_end = ?,
               storage_kind = ?, storage_key = ?::jsonb,
               progress = progress || ?::jsonb
         where id = ? and ingest_attempt = ?""")) {
      st.setTimestamp(1, first == Long.MAX_VALUE ? null : micros(first));
      st.setTimestamp(2, declaredEnd != null ? Timestamp.from(declaredEnd) : last == Long.MIN_VALUE ? null : micros(last));
      st.setString(3, STORAGE_KIND);
      st.setString(4, Json.object("chunks", chunkTable, "summaries", summaryTable));
      st.setString(5, Json.object("samples", samples, "nonFiniteAsNull", nonFinite, "resources", resources.size(),
          "activities", activityCount));
      st.setInt(6, revisionId);
      st.setInt(7, attempt);
      if (st.executeUpdate() != 1) throw new SQLException("Revision " + revisionId + " lost its lease while publishing");
    }
    conn.commit();
  }

  /** Re-streams out-of-order resources in (time, arrival) order, replacing what was written for them. */
  private void resort(List<Res> unsorted) throws SQLException {
    final var ids = new StringBuilder();
    for (final var r : unsorted) ids.append(ids.isEmpty() ? "" : ",").append(r.id);
    final String resortTable;
    try (final var st = conn.prepareStatement("select merlin.source_storage_resort_table(?, ?)")) {
      st.setInt(1, revisionId);
      st.setInt(2, attempt);
      try (final var rs = st.executeQuery()) {
        rs.next();
        resortTable = rs.getString(1);
      }
    }
    conn.commit();
    // ctid order is insertion order: the table is fresh and append-only, and nothing has vacuumed it.
    try (final var read = conn.prepareStatement(
             "select resource_id, n, times, nums, texts, kinds from " + chunkTable
             + " where resource_id in (" + ids + ") order by resource_id, ctid");
         final var copy = new PgCopy(chunkConn, resortTable, "resource_id, seq, t, num, txt, kind")) {
      read.setFetchSize(256);
      long seq = 0;
      try (final var rs = read.executeQuery()) {
        while (rs.next()) {
          final int id = rs.getInt(1), n = rs.getInt(2);
          final var times = le(rs.getBytes(3));
          final var nums = rs.getBytes(4) == null ? null : le(rs.getBytes(4));
          final var texts = rs.getBytes(5) == null ? null : le(rs.getBytes(5));
          final byte[] kinds = rs.getBytes(6);
          for (int i = 0; i < n; i++) {
            copy.row(6).int4(id).int8(seq++).int8((long) times.getDouble())
                .float8OrNull(nums == null ? Double.NaN : nums.getDouble()).text(texts == null ? null : readText(texts))
                .int2(kinds == null ? 0 : kinds[i]);
          }
        }
      }
      copy.finish();
    }
    conn.commit();
    try (final var st = chunkConn.createStatement()) {
      st.execute("delete from " + chunkTable + " where resource_id in (" + ids + ")");
      st.execute("delete from " + summaryTable + "_staging where resource_id in (" + ids + ")");
    }

    chunks = new PgCopy(chunkConn, chunkTable, "revision_id, resource_id, t0, t1, n, times, nums, texts, kinds");
    summaries = new PgCopy(summaryConn, summaryTable + "_staging", SUMMARY_COLUMNS);
    try (final var read = conn.prepareStatement(
        "select resource_id, t, num, txt, kind from " + resortTable + " order by resource_id, t, seq")) {
      read.setFetchSize(10_000);
      Res current = null;
      try (final var rs = read.executeQuery()) {
        while (rs.next()) {
          final var r = resources.get(rs.getInt(1));
          if (r != current) {
            if (current != null) current.close();
            r.reset();
            current = r;
          }
          final double num = rs.getDouble(3);
          r.add(rs.getLong(2), rs.wasNull() ? Double.NaN : num, rs.getString(4), (byte) rs.getShort(5));
        }
      }
      if (current != null) current.close();
    }
    conn.commit();
    chunks.finish();
    summaries.finish();
  }

  private static ByteBuffer le(byte[] b) { return ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN); }

  private static String readText(ByteBuffer b) {
    final int len = b.getInt();
    if (len == -1) return null;
    final var s = new String(b.array(), b.position(), len, StandardCharsets.UTF_8);
    b.position(b.position() + len);
    return s;
  }

  private static Timestamp micros(long t) {
    return Timestamp.from(Instant.ofEpochSecond(Math.floorDiv(t, 1_000_000L), Math.floorMod(t, 1_000_000L) * 1000L));
  }

  private static String emptyToNull(String s) { return s == null || s.isEmpty() ? null : s; }

  /** Per-resource ingest state: the open chunk, the open bucket of every summary level, and totals. */
  private final class Res {
    final SourceAdapter.ResourceDecl decl;
    final int id;
    final boolean numeric;
    long[] t = new long[CHUNK];
    double[] v;
    String[] s;
    byte[] k = new byte[CHUNK];
    int n;
    boolean anyNonValue;
    boolean sorted = true;
    long lastT = Long.MIN_VALUE;
    long count, chunkCount;
    long first = Long.MAX_VALUE, last = Long.MIN_VALUE;
    double min = Double.POSITIVE_INFINITY, max = Double.NEGATIVE_INFINITY;
    boolean hasPrev;
    byte prevKind;
    double prevNum;
    String prevText;
    final Level[] levels = new Level[LEVELS];
    String storage = "{}";

    Res(SourceAdapter.ResourceDecl decl, int id) {
      this.decl = decl;
      this.id = id;
      this.numeric = decl.numeric();
      this.v = numeric ? new double[CHUNK] : null;
      this.s = numeric ? null : new String[CHUNK];
      for (int i = 0; i < LEVELS; i++) levels[i] = new Level(i);
    }

    void reset() {
      n = 0; anyNonValue = false; sorted = true; lastT = Long.MIN_VALUE;
      count = 0; chunkCount = 0; first = Long.MAX_VALUE; last = Long.MIN_VALUE;
      min = Double.POSITIVE_INFINITY; max = Double.NEGATIVE_INFINITY; hasPrev = false;
      for (int i = 0; i < LEVELS; i++) levels[i] = new Level(i);
    }

    void add(long time, double num, String text, byte kind) throws SQLException {
      if (time < lastT) sorted = false;
      lastT = time;
      count++;
      first = Math.min(first, time);
      last = Math.max(last, time);
      if (kind == SourceAdapter.VALUE && numeric) {
        min = Math.min(min, num);
        max = Math.max(max, num);
      }
      final boolean changed = !hasPrev || kind != prevKind
          || (kind == SourceAdapter.VALUE && (numeric ? Double.compare(num, prevNum) != 0 : !text.equals(prevText)));
      hasPrev = true;
      prevKind = kind;
      prevNum = num;
      prevText = text;

      if (n >= CHUNK && time != t[n - 1]) flushChunk();
      if (n == t.length) grow();
      t[n] = time;
      if (numeric) v[n] = num; else s[n] = text;
      k[n] = kind;
      if (kind != SourceAdapter.VALUE) anyNonValue = true;
      n++;

      if (sorted) {
        for (final var level : levels) if (!level.dropped) level.add(time, num, text, kind, changed);
      }
    }

    /** A run of equal timestamps longer than a chunk stays in one chunk. */
    private void grow() {
      final int size = t.length * 2;
      t = java.util.Arrays.copyOf(t, size);
      k = java.util.Arrays.copyOf(k, size);
      if (numeric) v = java.util.Arrays.copyOf(v, size); else s = java.util.Arrays.copyOf(s, size);
    }

    void close() throws SQLException {
      if (n > 0) flushChunk();
      if (sorted) for (final var level : levels) if (!level.dropped) level.emit();
    }

    List<Integer> keptLevels() {
      final List<Integer> out = new ArrayList<>();
      if (count < MIN_SAMPLES_FOR_SUMMARIES) return out;
      for (final var level : levels) {
        if (!level.dropped && level.rows > 0 && level.rows <= count / REDUCTION) out.add(level.level);
      }
      return out;
    }

    private void flushChunk() throws SQLException {
      final var times = ByteBuffer.allocate(n * 8).order(ByteOrder.LITTLE_ENDIAN);
      long t0 = Long.MAX_VALUE, t1 = Long.MIN_VALUE;
      for (int i = 0; i < n; i++) {
        times.putDouble(t[i]);
        t0 = Math.min(t0, t[i]);
        t1 = Math.max(t1, t[i]);
      }
      byte[] nums = null, texts = null;
      if (numeric) {
        final var b = ByteBuffer.allocate(n * 8).order(ByteOrder.LITTLE_ENDIAN);
        for (int i = 0; i < n; i++) b.putDouble(v[i]);
        nums = b.array();
      } else {
        int size = 0;
        final byte[][] encoded = new byte[n][];
        for (int i = 0; i < n; i++) {
          encoded[i] = s[i] == null ? null : s[i].getBytes(StandardCharsets.UTF_8);
          size += 4 + (encoded[i] == null ? 0 : encoded[i].length);
        }
        final var b = ByteBuffer.allocate(size).order(ByteOrder.LITTLE_ENDIAN);
        for (final var e : encoded) {
          if (e == null) b.putInt(-1);
          else b.putInt(e.length).put(e);
        }
        texts = b.array();
      }
      chunks.row(9).int4(revisionId).int4(id).int8(t0).int8(t1).int4(n).bytea(times.array()).bytea(nums).bytea(texts)
          .bytea(anyNonValue ? java.util.Arrays.copyOf(k, n) : null);
      chunkCount++;
      n = 0;
      anyNonValue = false;
      if (!numeric) java.util.Arrays.fill(s, null);
    }

    /** One summary level's open bucket. */
    private final class Level {
      final int level;
      final long width;
      long bucket = Long.MIN_VALUE;
      int bn;
      long firstT, lastT, minT, maxT;
      double firstV, lastV, minV, maxV;
      String firstS, lastS;
      byte firstKind, lastKind;
      // The first null/gap and (discrete) the first change after the bucket's first sample.
      boolean hasNonValue, hasChange;
      long nonValueT, changeT;
      byte nonValueKind, changeKind;
      String changeS;
      long rows;
      boolean dropped;

      Level(int level) {
        this.level = level;
        long w = 1_000_000L;
        for (int i = 0; i < level; i++) w *= 4;
        this.width = w;
      }

      void add(long time, double num, String text, byte kind, boolean changed) throws SQLException {
        final long b = Math.floorDiv(time, width);
        if (b != bucket) {
          emit();
          if (dropped) return;
          bucket = b;
          firstT = time; firstV = num; firstS = text; firstKind = kind;
          minT = maxT = 0; minV = Double.POSITIVE_INFINITY; maxV = Double.NEGATIVE_INFINITY;
          hasNonValue = hasChange = false;
        } else {
          if (!hasNonValue && kind != SourceAdapter.VALUE) {
            hasNonValue = true; nonValueT = time; nonValueKind = kind;
          }
          if (!numeric && !hasChange && changed) {
            hasChange = true; changeT = time; changeKind = kind; changeS = text;
          }
        }
        bn++;
        lastT = time; lastV = num; lastS = text; lastKind = kind;
        if (kind == SourceAdapter.VALUE && numeric) {
          if (num < minV) { minV = num; minT = time; }
          if (num > maxV) { maxV = num; maxT = time; }
        }
      }

      void emit() throws SQLException {
        if (bn == 0) return;
        final boolean hasRange = numeric && maxV >= minV;
        summaries.row(22).int4(revisionId).int4(id).int2(level).int8(bucket).int4(bn).int8(firstT).int8(lastT)
            .int2(firstKind).int2(lastKind);
        if (hasRange) summaries.int8(minT).int8(maxT); else summaries.nullValue().nullValue();
        summaries.float8OrNull(numeric ? firstV : Double.NaN).float8OrNull(numeric ? lastV : Double.NaN);
        if (hasRange) summaries.float8(minV).float8(maxV); else summaries.nullValue().nullValue();
        summaries.text(numeric ? null : firstS).text(numeric ? null : lastS);
        if (hasNonValue) summaries.int8(nonValueT).int2(nonValueKind); else summaries.nullValue().nullValue();
        if (hasChange) summaries.int8(changeT).int2(changeKind).text(changeS);
        else summaries.nullValue().nullValue().nullValue();
        bn = 0;
        // Abandon levels that clearly will not reduce the data. Only costs speed, never correctness:
        // a reader falls back to a coarser level or to raw chunks.
        if (++rows > MIN_ROWS_BEFORE_DROP && rows > count / (REDUCTION / 4)) dropped = true;
      }
    }
  }
}
