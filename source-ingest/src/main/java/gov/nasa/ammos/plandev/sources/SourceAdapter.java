package gov.nasa.ammos.plandev.sources;

import java.io.InputStream;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Reads one source file format into typed resource and activity records.
 *
 * An adapter only parses. Validation, batching, persistence and publication belong to the
 * importer ({@link SourceImporter}), so a new format never touches storage code. An adapter never creates or
 * changes sources or revisions.
 *
 * Adapters are trusted in-process plugins, discovered with {@link java.util.ServiceLoader} (see
 * {@link AdapterRegistry} and docs/sources/ADAPTERS.md).
 */
public interface SourceAdapter {
  /** What this adapter is, as the {@code merlin.source_adapter} catalog lists it. */
  Descriptor descriptor();

  /** Whether this adapter understands a file, from its first few kilobytes. */
  boolean probe(byte[] head);

  /**
   * Streams the whole file into the sink: every {@link Sink#declare} first, then
   * {@link Sink#manifestComplete}, then samples and activities. Memory must not grow with file size.
   *
   * @param config the revision's {@code adapter_config} (a JSON document), or null when it has none
   */
  void read(InputStream in, Sink sink, String config) throws Exception;

  /**
   * @param id stable; what {@code merlin.source_revision.adapter} names. Never change it once revisions use it.
   * @param extensions file name endings the adapter reads, e.g. ".tol.gz"; a hint for file pickers, not used to select
   * @param capabilities which of "resources" and "activities" the adapter can produce
   * @param configSchema a JSON Schema for {@code adapter_config}, or null when the adapter takes no config
   */
  record Descriptor(
      String id,
      String displayName,
      String version,
      List<String> extensions,
      List<String> mimeTypes,
      List<String> capabilities,
      String configSchema) {}

  /**
   * Facts about the upstream product, all optional.
   *
   * @param generatedAt when the upstream product was generated (not when it was imported)
   * @param mission free mission-specific facts, as a JSON object
   */
  record ProductMetadata(Instant generatedAt, String productVersion, String suggestedName, Map<String, Object> mission) {}

  interface Sink {
    /** Declares a resource. Its ordinal is the number of declarations before it. */
    void declare(ResourceDecl decl);

    /** All declarations are in; the catalog can be published before any sample arrives. */
    void manifestComplete() throws Exception;

    /** One record. {@code text} is set for discrete resources, {@code num} for numeric ones. */
    void sample(int resource, long tMicros, double num, String text, byte kind) throws Exception;

    /** One activity instance, complete with its end. Sources without activities never call it. */
    default void activity(ActivityRecord activity) throws Exception {}

    /** Facts about the product as a whole, at any point; the importer stores the last call's in the revision. */
    default void productMetadata(ProductMetadata product) throws Exception {}
  }

  /** A sample's value is present. */
  byte VALUE = 0;
  /** A sample whose value is a valid null: the resource is defined and has no value. */
  byte NULL = 1;
  /** The start of a gap: the resource is undefined from here to the next sample. */
  byte GAP = 2;

  /**
   * A declared resource.
   *
   * @param key unique within the source; what a timeline layer refers to
   * @param numeric numbers (float, integer, duration in ms) rather than discrete states
   * @param interpolation "linear" or "constant" (step)
   * @param category the source-native grouping, such as a TOL subsystem
   */
  record ResourceDecl(
      String key,
      String name,
      List<String> index,
      String dataType,
      boolean numeric,
      String units,
      String interpolation,
      String category,
      List<String> possibleStates,
      String minimum,
      String maximum) {}

  /**
   * An activity instance as the source recorded it. {@code attributes}, {@code parameters} and {@code metadata}
   * are JSON objects, so nothing the source records about the instance is dropped.
   *
   * @param key the source's own identifier for the instance
   * @param category the source-native grouping, such as a TOL subsystem
   */
  record ActivityRecord(
      String key,
      String type,
      String name,
      String category,
      long startMicros,
      long endMicros,
      String attributes,
      String parameters,
      String metadata) {}
}
