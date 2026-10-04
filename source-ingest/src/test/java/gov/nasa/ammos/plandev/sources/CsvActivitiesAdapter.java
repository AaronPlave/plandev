package gov.nasa.ammos.plandev.sources;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A second adapter, registered through src/test/resources/META-INF/services like any mission adapter, so the
 * tests prove discovery, selection, config and product metadata without TOL. Its format:
 *
 *   # csv-activities
 *   # generatedAt=2030-01-02T00:00:00Z     (also productVersion, suggestedName, mission.<key>)
 *   type,name,start,end                    (ISO-8601 instants)
 *
 * Each activity's metadata carries the revision's adapter_config as {"config": ...}.
 */
public final class CsvActivitiesAdapter implements SourceAdapter {
  @Override
  public Descriptor descriptor() {
    return new Descriptor("csv_activities", "CSV activities (test)", "1", List.of(".csv"), List.of("text/csv"),
        List.of("activities"), "{\"type\":\"object\",\"properties\":{\"label\":{\"type\":\"string\"}}}");
  }

  @Override
  public boolean probe(byte[] head) {
    return new String(head, StandardCharsets.UTF_8).startsWith("# csv-activities");
  }

  @Override
  public void read(InputStream in, Sink sink, String config) throws Exception {
    final var r = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
    final Map<String, String> header = new LinkedHashMap<>();
    final Map<String, Object> mission = new LinkedHashMap<>();
    sink.manifestComplete();
    int n = 0;
    for (String line; (line = r.readLine()) != null; ) {
      if (line.startsWith("# ") && line.contains("=")) {
        final var kv = line.substring(2).split("=", 2);
        if (kv[0].startsWith("mission.")) mission.put(kv[0].substring(8), kv[1]);
        else header.put(kv[0], kv[1]);
      } else if (!line.startsWith("#") && !line.startsWith("type,") && !line.isBlank()) {
        final var f = line.split(",");
        sink.activity(new ActivityRecord("row_" + n++, f[0], f[1], null, micros(f[2]), micros(f[3]),
            "{}", "{}", config == null ? "{}" : "{\"config\":" + config + "}"));
      }
    }
    if (!header.isEmpty() || !mission.isEmpty()) {
      sink.productMetadata(new ProductMetadata(header.containsKey("generatedAt") ? Instant.parse(header.get("generatedAt")) : null,
          header.get("productVersion"), header.get("suggestedName"), mission.isEmpty() ? null : mission));
    }
  }

  private static long micros(String iso) {
    final var t = Instant.parse(iso);
    return t.getEpochSecond() * 1_000_000L + t.getNano() / 1000;
  }
}
