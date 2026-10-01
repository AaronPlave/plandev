package gov.nasa.ammos.plandev.sources;

import java.nio.file.Path;

public final class SourceIngestCli {
  public static void main(String[] args) throws Exception {
    if (args.length == 0) usage();
    switch (args[0]) {
      case "profile" -> Profile.run(Path.of(args[1]), Path.of(args[2]));
      case "register" -> {
        // register <name> <path> [planId] [user]
        SourceWorker.register(SourceWorker.Config.fromEnv(), args[1], "xml_tol", Path.of(args[2]),
            args.length > 3 ? Integer.valueOf(args[3]) : null, args.length > 4 ? args[4] : null);
      }
      case "work" -> new SourceWorker(SourceWorker.Config.fromEnv()).run(args.length > 1 && args[1].equals("--once"));
      case "bench-segments" -> {
        // bench-segments <file> <originMicros>: load into merlin.profile_segment, the existing representation
        final var config = SourceWorker.Config.fromEnv();
        try (final var conn = config.connect(false); final var copyConn = config.connect(true)) {
          final var bench = new ProfileSegmentBench(conn, copyConn);
          bench.origin(Long.parseLong(args[2]));
          final long t0 = System.currentTimeMillis();
          try (final var in = Inputs.open(Path.of(args[1]))) {
            new TolAdapter().read(in, bench);
          }
          bench.finish();
          System.out.printf("dataset %d: %,d samples (%,d same-time records dropped) in %.1f s%n",
              bench.datasetId(), bench.samples, bench.sameTimeDropped, (System.currentTimeMillis() - t0) / 1e3);
        }
      }
      default -> usage();
    }
  }

  private static void usage() {
    System.err.println("""
        usage:
          profile <file> <out.tsv>               one streaming pass; per-resource shape statistics
          register <name> <path> [planId] [user] queue a server-side file as a new source revision
          work [--once]                          run ingest jobs (--once: until none are pending)

        Database: PLANDEV_DB_URL, PLANDEV_DB_USER, PLANDEV_DB_PASSWORD. Uploaded files: PLANDEV_FILE_STORE.
        """);
    System.exit(2);
  }
}
