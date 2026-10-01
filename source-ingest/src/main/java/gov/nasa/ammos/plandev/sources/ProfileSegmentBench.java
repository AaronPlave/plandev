package gov.nasa.ammos.plandev.sources;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;

/**
 * Benchmark baseline: loads the same stream into today's representation, one {@code merlin.profile}
 * per resource and one {@code merlin.profile_segment} row per sample, the way simulation results and
 * plan-import results are stored. This is the best case for that schema: one binary COPY straight
 * into the dataset's partition, with its existing integrity trigger and unique index in place.
 *
 * Segments follow the existing encoding: a real segment is {"initial", "rate"}, where a linear
 * resource's rate reaches the next sample's value; a discrete segment is the value itself; a
 * non-value is a gap. Each resource holds one sample back to know the next one.
 */
final class ProfileSegmentBench implements SourceAdapter.Sink {
  private final Connection conn;
  private final Connection copyConn;
  private final List<SourceAdapter.ResourceDecl> decls = new ArrayList<>();
  private final List<Pending> pending = new ArrayList<>();
  private int datasetId;
  private long origin = Long.MIN_VALUE;
  private long last = Long.MIN_VALUE;
  private int[] profileIds;
  private PgCopy copy;
  long samples;
  long sameTimeDropped;

  private static final class Pending {
    boolean has;
    long t;
    double num;
    String text;
    byte kind;
  }

  ProfileSegmentBench(Connection conn, Connection copyConn) {
    this.conn = conn;
    this.copyConn = copyConn;
  }

  int datasetId() { return datasetId; }

  @Override
  public void declare(SourceAdapter.ResourceDecl decl) {
    decls.add(decl);
    pending.add(new Pending());
  }

  @Override
  public void manifestComplete() throws SQLException {
    try (final var st = conn.createStatement(); final var rs = st.executeQuery("insert into merlin.dataset default values returning id")) {
      rs.next();
      datasetId = rs.getInt(1);
    }
    // The dataset insert trigger allocates its partitions.
    profileIds = new int[decls.size()];
    try (final var st = conn.prepareStatement(
        "insert into merlin.profile (dataset_id, name, type, duration) values (?, ?, ?::jsonb, interval '0') returning id")) {
      for (int i = 0; i < decls.size(); i++) {
        final var d = decls.get(i);
        st.setInt(1, datasetId);
        st.setString(2, d.key());
        st.setString(3, "{\"type\":\"" + (d.numeric() ? "real" : "discrete") + "\",\"schema\":" + Json.schema(d) + "}");
        try (final var rs = st.executeQuery()) {
          rs.next();
          profileIds[i] = rs.getInt(1);
        }
      }
    }
    conn.commit();
    copy = new PgCopy(copyConn, "merlin.profile_segment_" + datasetId, "dataset_id, profile_id, start_offset, dynamics, is_gap");
  }

  /** Segment offsets need a dataset origin before the first record; this TOL's coverage start, from the profile pass. */
  void origin(long t) { origin = t; }

  @Override
  public void sample(int resource, long t, double num, String text, byte kind) throws SQLException {
    if (copy == null) manifestComplete();
    if (kind == SourceAdapter.VALUE && decls.get(resource).numeric() && !Double.isFinite(num)) kind = SourceAdapter.NULL;
    samples++;
    last = Math.max(last, t);
    final var p = pending.get(resource);
    // profile_segment is unique on (profile, start_offset): it cannot hold two records at one time,
    // so the later one wins.
    if (p.has && p.t == t) sameTimeDropped++;
    else if (p.has) write(resource, p, t, num, kind);
    p.has = true;
    p.t = t;
    p.num = num;
    p.text = text;
    p.kind = kind;
  }

  private void write(int resource, Pending p, long nextT, double nextNum, byte nextKind) throws SQLException {
    final var d = decls.get(resource);
    String dynamics = null;
    if (p.kind == SourceAdapter.VALUE) {
      if (d.numeric()) {
        double rate = 0;
        if ("linear".equals(d.interpolation()) && nextKind == SourceAdapter.VALUE && nextT > p.t) {
          rate = (nextNum - p.num) / ((nextT - p.t) / 1e6);
        }
        dynamics = "{\"initial\":" + p.num + ",\"rate\":" + rate + "}";
      } else {
        dynamics = Json.write(p.text);
      }
    }
    copy.row(5).int4(datasetId).int4(profileIds[resource]).interval(p.t - origin).jsonb(dynamics).bool(dynamics == null);
  }

  void finish() throws SQLException {
    for (int i = 0; i < pending.size(); i++) {
      final var p = pending.get(i);
      if (p.has) write(i, p, last, Double.NaN, SourceAdapter.NULL);
    }
    copy.finish();
    try (final var st = conn.prepareStatement("update merlin.profile set duration = make_interval(secs => ?) where dataset_id = ?")) {
      st.setDouble(1, (last - origin) / 1e6);
      st.setInt(2, datasetId);
      st.executeUpdate();
    }
    conn.commit();
  }
}
