package gov.nasa.ammos.plandev.sources;

import org.postgresql.PGConnection;
import org.postgresql.copy.CopyIn;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;

/**
 * Streams rows into one table with {@code COPY ... FROM STDIN (FORMAT binary)}, flushing every
 * megabyte. Binary COPY avoids escaping bytea payloads and is the fastest bulk path into Postgres.
 * Values are written in Postgres' network (big-endian) binary format.
 */
final class PgCopy implements AutoCloseable {
  private static final byte[] HEADER = {'P', 'G', 'C', 'O', 'P', 'Y', '\n', (byte) 0xff, '\r', '\n', 0, 0, 0, 0, 0, 0, 0, 0, 0};
  private final CopyIn copy;
  private ByteBuffer buf = ByteBuffer.allocate(1 << 21).order(ByteOrder.BIG_ENDIAN);
  private long bytes;

  PgCopy(Connection conn, String table, String columns) throws SQLException {
    this.copy = conn.unwrap(PGConnection.class).getCopyAPI()
        .copyIn("copy " + table + " (" + columns + ") from stdin (format binary)");
    buf.put(HEADER);
  }

  PgCopy row(int fields) throws SQLException {
    if (buf.position() > (1 << 20)) flush();
    ensure(2);
    buf.putShort((short) fields);
    return this;
  }

  PgCopy int2(int v) { ensure(6); buf.putInt(2).putShort((short) v); return this; }

  PgCopy int4(int v) { ensure(8); buf.putInt(4).putInt(v); return this; }

  PgCopy int8(long v) { ensure(12); buf.putInt(8).putLong(v); return this; }

  PgCopy float8(double v) { ensure(12); buf.putInt(8).putDouble(v); return this; }

  PgCopy bool(boolean v) { ensure(5); buf.putInt(1).put((byte) (v ? 1 : 0)); return this; }

  /** An interval of whole microseconds (no days or months). */
  PgCopy interval(long micros) { ensure(20); buf.putInt(16).putLong(micros).putInt(0).putInt(0); return this; }

  PgCopy jsonb(String json) {
    if (json == null) return nullValue();
    final byte[] b = json.getBytes(StandardCharsets.UTF_8);
    ensure(5 + b.length);
    buf.putInt(1 + b.length).put((byte) 1).put(b);
    return this;
  }

  PgCopy nullValue() { ensure(4); buf.putInt(-1); return this; }

  PgCopy float8OrNull(double v) { return Double.isNaN(v) ? nullValue() : float8(v); }

  PgCopy bytea(byte[] v) {
    if (v == null) return nullValue();
    ensure(4 + v.length);
    buf.putInt(v.length).put(v);
    return this;
  }

  PgCopy text(String v) {
    return v == null ? nullValue() : bytea(v.getBytes(StandardCharsets.UTF_8));
  }

  long bytesWritten() { return bytes + buf.position(); }

  private void ensure(int n) {
    if (buf.remaining() >= n) return;
    final var bigger = ByteBuffer.allocate(Math.max(buf.capacity() * 2, buf.position() + n)).order(ByteOrder.BIG_ENDIAN);
    buf.flip();
    bigger.put(buf);
    buf = bigger;
  }

  private void flush() throws SQLException {
    copy.writeToCopy(buf.array(), 0, buf.position());
    bytes += buf.position();
    buf.clear();
  }

  /** Ends the COPY and returns the number of rows Postgres accepted. */
  long finish() throws SQLException {
    ensure(2);
    buf.putShort((short) -1);
    flush();
    return copy.endCopy();
  }

  @Override
  public void close() throws SQLException {
    if (copy.isActive()) copy.cancelCopy();
  }
}
