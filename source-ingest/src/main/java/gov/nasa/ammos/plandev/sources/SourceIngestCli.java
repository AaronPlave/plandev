package gov.nasa.ammos.plandev.sources;

import java.nio.file.Path;

public final class SourceIngestCli {
  public static void main(String[] args) throws Exception {
    if (args.length == 0) usage();
    switch (args[0]) {
      case "profile" -> Profile.run(Path.of(args[1]), Path.of(args[2]));
      case "register" -> {
        // register [--adapter=<id>] <name> <path> [planId] [user]
        final var rest = new java.util.ArrayList<>(java.util.List.of(args).subList(1, args.length));
        final var adapter = rest.stream().filter(a -> a.startsWith("--adapter=")).findFirst();
        adapter.ifPresent(rest::remove);
        SourceWorker.register(SourceWorker.Config.fromEnv(), rest.get(0),
            adapter.map(a -> a.substring("--adapter=".length())).orElse(AdapterRegistry.AUTO), Path.of(rest.get(1)),
            rest.size() > 2 ? Integer.valueOf(rest.get(2)) : null, rest.size() > 3 ? rest.get(3) : null);
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
            new TolAdapter().read(in, bench, null);
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
          register [--adapter=<id>] <name> <path> [planId] [user]
                                                 queue a server-side file as a new source revision
                                                 (adapter: an installed adapter id, default auto)
          work [--once]                          run ingest jobs (--once: until none are pending)

        Database: PLANDEV_DB_URL, PLANDEV_DB_USER, PLANDEV_DB_PASSWORD. Uploaded files: PLANDEV_FILE_STORE.
        """);
    System.exit(2);
  }
}
