package gov.nasa.ammos.plandev.sources;

import org.junit.jupiter.api.Test;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

final class AdapterRegistryTest {
  private static final byte[] TOL = "<?xml version=\"1.0\"?>\n<XML_TOL>".getBytes(StandardCharsets.UTF_8);
  private static final byte[] CSV = "# csv-activities\ntype,name,start,end".getBytes(StandardCharsets.UTF_8);
  private static final byte[] TEXT = "just some text".getBytes(StandardCharsets.UTF_8);

  /** Recognizes everything, so it makes any file ambiguous. */
  private static SourceAdapter greedy(String id) {
    return new SourceAdapter() {
      @Override public Descriptor descriptor() { return new Descriptor(id, id, "1", List.of(), List.of(), List.of(), null); }
      @Override public boolean probe(byte[] head) { return true; }
      @Override public void read(InputStream in, Sink sink, String config) {}
    };
  }

  @Test
  void discoversEveryAdapterOnTheClasspath() {
    assertEquals(List.of("csv_activities", "xml_tol"), AdapterRegistry.load().adapters.keySet().stream().sorted().toList());
  }

  @Test
  void rejectsTwoAdaptersWithOneId() {
    final var e = assertThrows(IllegalStateException.class, () -> new AdapterRegistry(List.of(new TolAdapter(), greedy("xml_tol"))));
    assertTrue(e.getMessage().startsWith("Two adapters have id xml_tol"), e.getMessage());
  }

  @Test
  void autoPicksTheOnlyAdapterThatRecognizesTheFile() {
    final var registry = AdapterRegistry.load();
    assertEquals("xml_tol", registry.select("auto", TOL).descriptor().id());
    assertEquals("csv_activities", registry.select("auto", CSV).descriptor().id());
  }

  @Test
  void autoFailsWhenNoneOrSeveralRecognizeTheFile() {
    final var none = assertThrows(IllegalArgumentException.class, () -> AdapterRegistry.load().select("auto", TEXT));
    assertTrue(none.getMessage().startsWith("No installed adapter recognizes this file (installed: "), none.getMessage());
    assertTrue(none.getMessage().contains("xml_tol") && none.getMessage().contains("csv_activities"), none.getMessage());
    final var several = assertThrows(IllegalArgumentException.class,
        () -> new AdapterRegistry(List.of(new TolAdapter(), greedy("any"))).select("auto", TOL));
    assertEquals("Several adapters recognize this file, choose one explicitly: [xml_tol, any]", several.getMessage());
  }

  @Test
  void anExplicitIdMustBeInstalledAndRecognizeTheFile() {
    final var registry = AdapterRegistry.load();
    assertEquals("No adapter kml is installed (installed: [xml_tol])",
        assertThrows(IllegalArgumentException.class, () -> new AdapterRegistry(List.of(new TolAdapter())).select("kml", TOL)).getMessage());
    assertEquals("File is not readable by adapter xml_tol",
        assertThrows(IllegalArgumentException.class, () -> registry.select("xml_tol", CSV)).getMessage());
    assertEquals("csv_activities", registry.select("csv_activities", CSV).descriptor().id());
  }
}
