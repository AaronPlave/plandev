package gov.nasa.ammos.plandev.sources;

import java.io.BufferedInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.BlockingQueue;
import java.util.zip.GZIPInputStream;

/** Opens a source file as a stream: plain, {@code .gz}, or the first file of a {@code .tar[.gz]}. */
public final class Inputs {
  private Inputs() {}

  public static InputStream open(Path path) throws IOException {
    return open(path, raw -> raw);
  }

  /** {@code tap} wraps the raw file bytes, before any decompression (e.g. to hash or count them). */
  public static InputStream open(Path path, java.util.function.UnaryOperator<InputStream> tap) throws IOException {
    final var name = path.getFileName().toString();
    InputStream in = new BufferedInputStream(tap.apply(Files.newInputStream(path)), 1 << 20);
    if (name.endsWith(".gz") || name.endsWith(".tgz")) {
      // Decompress on its own thread so inflating overlaps with parsing.
      in = new ReadAhead(new GZIPInputStream(in, 1 << 20));
    }
    if (name.endsWith(".tar") || name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
      in = firstTarEntry(in);
    }
    return new BufferedInputStream(in, 1 << 20);
  }

  /** Positions {@code in} at the first regular file of a tar stream and bounds it to that file. */
  static InputStream firstTarEntry(InputStream in) throws IOException {
    final byte[] header = new byte[512];
    while (true) {
      if (in.readNBytes(header, 0, 512) < 512) throw new IOException("Tar archive has no regular file");
      final long size = tarSize(header);
      final char type = (char) header[156];
      if (type == '0' || type == '\0') return new Bounded(in, size);
      in.skipNBytes((size + 511) / 512 * 512); // pax / GNU long-name headers, directories
    }
  }

  private static long tarSize(byte[] h) {
    if ((h[124] & 0x80) != 0) { // GNU base-256, used for files over 8 GiB
      long v = h[124] & 0x7f;
      for (int i = 125; i < 136; i++) v = (v << 8) | (h[i] & 0xff);
      return v;
    }
    long v = 0;
    for (int i = 124; i < 136 && h[i] != 0 && h[i] != ' '; i++) v = v * 8 + (h[i] - '0');
    return v;
  }

  private static final class Bounded extends FilterInputStream {
    private long remaining;

    Bounded(InputStream in, long size) {
      super(in);
      this.remaining = size;
    }

    @Override
    public int read() throws IOException {
      if (remaining <= 0) return -1;
      final int b = in.read();
      if (b >= 0) remaining--;
      return b;
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
      if (remaining <= 0) return -1;
      final int n = in.read(b, off, (int) Math.min(len, remaining));
      if (n > 0) remaining -= n;
      return n;
    }
  }

  /** Reads {@code source} on a background thread, keeping a few megabytes ahead of the consumer. */
  private static final class ReadAhead extends InputStream {
    private static final byte[] EOF = new byte[0];
    private final BlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(16);
    private volatile IOException failure;
    private byte[] current = new byte[0];
    private int pos;

    ReadAhead(InputStream source) {
      final var t = new Thread(() -> {
        try (source) {
          while (true) {
            final byte[] buf = source.readNBytes(1 << 20);
            if (buf.length == 0) break;
            queue.put(buf);
          }
        } catch (IOException e) {
          failure = e;
        } catch (InterruptedException e) {
          Thread.currentThread().interrupt();
        } finally {
          try {
            queue.put(EOF);
          } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
          }
        }
      }, "source-read-ahead");
      t.setDaemon(true);
      t.start();
    }

    private boolean fill() throws IOException {
      if (current == EOF) return false;
      if (pos < current.length) return true;
      try {
        current = queue.take();
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new IOException(e);
      }
      pos = 0;
      if (current == EOF) {
        if (failure != null) throw failure;
        return false;
      }
      return true;
    }

    @Override
    public int read() throws IOException {
      return fill() ? current[pos++] & 0xff : -1;
    }

    @Override
    public int read(byte[] b, int off, int len) throws IOException {
      if (len == 0) return 0;
      if (!fill()) return -1;
      final int n = Math.min(len, current.length - pos);
      System.arraycopy(current, pos, b, off, n);
      pos += n;
      return n;
    }
  }
}
