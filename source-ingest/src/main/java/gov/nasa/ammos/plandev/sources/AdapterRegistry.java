package gov.nasa.ammos.plandev.sources;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.ServiceLoader;

/**
 * The installed adapters: every {@link SourceAdapter} on the classpath, found through
 * {@code META-INF/services/gov.nasa.ammos.plandev.sources.SourceAdapter}. Loaded once, at startup.
 */
final class AdapterRegistry {
  /** The {@code adapter} value that asks the worker to choose by probing the file. */
  static final String AUTO = "auto";

  final Map<String, SourceAdapter> adapters = new LinkedHashMap<>();

  AdapterRegistry(Iterable<SourceAdapter> found) {
    for (final var a : found) {
      final var previous = adapters.putIfAbsent(a.descriptor().id(), a);
      if (previous != null) {
        throw new IllegalStateException("Two adapters have id " + a.descriptor().id() + ": "
            + previous.getClass().getName() + " and " + a.getClass().getName());
      }
    }
  }

  static AdapterRegistry load() {
    return new AdapterRegistry(ServiceLoader.load(SourceAdapter.class));
  }

  /** The adapter a revision names ({@code auto}: the only installed one that recognizes {@code head}). */
  SourceAdapter select(String id, byte[] head) {
    if (!AUTO.equals(id)) {
      final var adapter = adapters.get(id);
      if (adapter == null) throw new IllegalArgumentException("No adapter " + id + " is installed (installed: " + adapters.keySet() + ")");
      if (!adapter.probe(head)) throw new IllegalArgumentException("File is not readable by adapter " + id);
      return adapter;
    }
    final var matches = adapters.values().stream().filter(a -> a.probe(head)).toList();
    if (matches.size() == 1) return matches.get(0);
    if (matches.isEmpty()) {
      throw new IllegalArgumentException("No installed adapter recognizes this file (installed: " + adapters.keySet() + ")");
    }
    throw new IllegalArgumentException("Several adapters recognize this file, choose one explicitly: "
        + matches.stream().map(a -> a.descriptor().id()).toList());
  }

  /**
   * Upserts every installed descriptor into {@code merlin.source_adapter}, marking it seen now. Rows of adapters
   * no longer installed are kept (old revisions name them) and simply stop being seen.
   */
  void publish(Connection c) throws SQLException {
    try (final var st = c.prepareStatement("""
        insert into merlin.source_adapter (id, display_name, version, extensions, mime_types, capabilities, config_schema)
        values (?, ?, ?, ?, ?, ?, ?::jsonb)
        on conflict (id) do update
          set display_name = excluded.display_name, version = excluded.version, extensions = excluded.extensions,
              mime_types = excluded.mime_types, capabilities = excluded.capabilities,
              config_schema = excluded.config_schema, updated_at = now(), last_seen_at = now()""")) {
      for (final var a : adapters.values()) {
        final var d = a.descriptor();
        st.setString(1, d.id());
        st.setString(2, d.displayName());
        st.setString(3, d.version());
        st.setArray(4, c.createArrayOf("text", d.extensions().toArray()));
        st.setArray(5, c.createArrayOf("text", d.mimeTypes().toArray()));
        st.setArray(6, c.createArrayOf("text", d.capabilities().toArray()));
        st.setString(7, d.configSchema());
        st.addBatch();
      }
      st.executeBatch();
    }
  }
}
