package gov.nasa.ammos.plandev.sources;

import java.io.InputStream;
import java.util.List;

/**
 * Reads one source file format into typed resource and activity records.
 *
 * An adapter only parses. Validation, batching, persistence and publication belong to the
 * importer ({@link SourceImporter}), so a new format never touches storage code.
 */
public interface SourceAdapter {
  String name();

  String version();

  /** Whether this adapter understands a file, from its first few kilobytes. */
  boolean probe(byte[] head);

  /**
   * Streams the whole file into the sink: every {@link Sink#declare} first, then
   * {@link Sink#manifestComplete}, then samples and activities. Memory must not grow with file size.
   */
  void read(InputStream in, Sink sink) throws Exception;

  interface Sink {
    /** Declares a resource. Its ordinal is the number of declarations before it. */
    void declare(ResourceDecl decl);

    /** All declarations are in; the catalog can be published before any sample arrives. */
    void manifestComplete() throws Exception;

    /** One record. {@code text} is set for discrete resources, {@code num} for numeric ones. */
    void sample(int resource, long tMicros, double num, String text, byte kind) throws Exception;

    /** One activity instance, complete with its end. Sources without activities never call it. */
    default void activity(ActivityRecord activity) throws Exception {}
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
