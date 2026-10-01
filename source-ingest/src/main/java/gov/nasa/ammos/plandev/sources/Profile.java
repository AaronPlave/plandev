package gov.nasa.ammos.plandev.sources;

import java.io.PrintStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * Benchmark tool: one streaming pass over a source file, recording the shape of its data
 * (counts, coverage, ordering, density) without storing anything. Writes one TSV row per
 * resource and prints totals.
 */
final class Profile implements SourceAdapter.Sink {
  private static final class Stats {
    final SourceAdapter.ResourceDecl decl;
    long count, nulls, outOfOrder, sameTime, changes;
    long first = Long.MAX_VALUE, last = Long.MIN_VALUE, prev = Long.MIN_VALUE;
    String prevText;
    double prevNum = Double.NaN;
    // densest second / minute / hour, by sample count
    long secBucket = Long.MIN_VALUE, minBucket = Long.MIN_VALUE, hourBucket = Long.MIN_VALUE;
    int secCount, minCount, hourCount, maxSec, maxMin, maxHour;

    Stats(SourceAdapter.ResourceDecl decl) { this.decl = decl; }
  }

  private final List<Stats> stats = new ArrayList<>();
  private long samples;
  private long manifestAtNanos;
  private final long startNanos = System.nanoTime();

  @Override public void declare(SourceAdapter.ResourceDecl decl) { stats.add(new Stats(decl)); }

  @Override public void manifestComplete() { manifestAtNanos = System.nanoTime(); }

  @Override
  public void sample(int resource, long t, double num, String text, byte kind) {
    final var s = stats.get(resource);
    samples++;
    s.count++;
    if (kind == SourceAdapter.NULL) s.nulls++;
    if (t < s.prev) s.outOfOrder++;
    else if (t == s.prev) s.sameTime++;
    if (s.count > 1 && (s.decl.numeric() ? Double.compare(num, s.prevNum) != 0 : !java.util.Objects.equals(text, s.prevText))) {
      s.changes++;
    }
    s.prev = t;
    s.prevNum = num;
    s.prevText = text;
    s.first = Math.min(s.first, t);
    s.last = Math.max(s.last, t);

    final long sec = Math.floorDiv(t, 1_000_000L), min = Math.floorDiv(t, 60_000_000L), hour = Math.floorDiv(t, 3_600_000_000L);
    if (sec != s.secBucket) { s.secBucket = sec; s.secCount = 0; }
    if (min != s.minBucket) { s.minBucket = min; s.minCount = 0; }
    if (hour != s.hourBucket) { s.hourBucket = hour; s.hourCount = 0; }
    s.maxSec = Math.max(s.maxSec, ++s.secCount);
    s.maxMin = Math.max(s.maxMin, ++s.minCount);
    s.maxHour = Math.max(s.maxHour, ++s.hourCount);

    if ((samples & ((1 << 24) - 1)) == 0) {
      System.err.printf("  %,d samples, %.0f s%n", samples, (System.nanoTime() - startNanos) / 1e9);
    }
  }

  static void run(Path file, Path out) throws Exception {
    final var p = new Profile();
    final var t0 = System.nanoTime();
    try (final var in = Inputs.open(file)) {
      new TolAdapter().read(in, p);
    }
    final double secs = (System.nanoTime() - t0) / 1e9;
    try (final var w = new PrintStream(Files.newOutputStream(out))) {
      w.println("key\tcategory\tdataType\tinterp\tcount\tnulls\tchanges\toutOfOrder\tsameTime\tfirst\tlast\tmaxPerSec\tmaxPerMin\tmaxPerHour");
      for (final var s : p.stats) {
        w.printf("%s\t%s\t%s\t%s\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d\t%d%n",
            s.decl.key(), s.decl.category(), s.decl.dataType(), s.decl.interpolation(), s.count, s.nulls, s.changes,
            s.outOfOrder, s.sameTime, s.count == 0 ? 0 : s.first, s.count == 0 ? 0 : s.last, s.maxSec, s.maxMin, s.maxHour);
      }
    }
    long first = Long.MAX_VALUE, last = Long.MIN_VALUE, ooo = 0, same = 0, empty = 0;
    for (final var s : p.stats) {
      if (s.count == 0) { empty++; continue; }
      first = Math.min(first, s.first);
      last = Math.max(last, s.last);
      ooo += s.outOfOrder;
      same += s.sameTime;
    }
    System.out.printf(
        "resources=%d (empty %d) samples=%,d outOfOrder=%,d sameTime=%,d coverage=%s..%s%n"
        + "manifest after %.2f s; total %.1f s; %.2f M samples/s; peak heap %d MiB%n",
        p.stats.size(), empty, p.samples, ooo, same,
        java.time.Instant.EPOCH.plusNanos(first * 1000), java.time.Instant.EPOCH.plusNanos(last * 1000),
        (p.manifestAtNanos - t0) / 1e9, secs, p.samples / secs / 1e6,
        (Runtime.getRuntime().totalMemory()) >> 20);
  }
}
