package gov.nasa.ammos.plandev.sources;

import javax.xml.stream.XMLInputFactory;
import javax.xml.stream.XMLStreamConstants;
import javax.xml.stream.XMLStreamException;
import javax.xml.stream.XMLStreamReader;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * XML_TOL state files: a {@code ResourceMetadata} block of {@code ResourceSpec}s, then
 * {@code TOLrecord}s of type {@code RES_VAL} / {@code RES_FINAL_VAL} (resources) and
 * {@code ACT_START} / {@code ACT_END} (activities).
 *
 * A resource is identified by its name plus its {@code Index} levels, so arrayed resources
 * such as {@code Voltage[A]} and {@code Voltage[B]} stay distinct. A record for a resource the
 * metadata does not declare is an error.
 *
 * An activity is an {@code ACT_START} {@code Instance} (ID, Name, Type, Attributes, Parameters, and
 * provenance such as Parent and Visibility), closed by the {@code ACT_END} naming its ID. Its duration is
 * its {@code span} attribute: in the products seen so far most ACT_END records carry the time they were
 * emitted (often the start itself), not when the activity ends, so ACT_END is only the end of an activity
 * without a span, and is otherwise kept as provenance ({@code metadata.actEnd}). Typed values become
 * JSON: lists arrays, structs objects, durations milliseconds, times their TOL text.
 * Other record types are skipped.
 */
public final class TolAdapter implements SourceAdapter {
  private static final Set<String> NUMERIC_TYPES = Set.of("float", "integer", "duration");
  private static final Set<String> VALUE_TAGS =
      Set.of("DoubleValue", "IntegerValue", "StringValue", "BooleanValue", "DurationValue", "TimeValue");

  @Override public String name() { return "xml_tol"; }

  @Override public String version() { return "1"; }

  @Override
  public boolean probe(byte[] head) {
    return new String(head, StandardCharsets.UTF_8).contains("<XML_TOL");
  }

  @Override
  public void read(InputStream in, Sink sink) throws Exception {
    final var factory = XMLInputFactory.newInstance();
    factory.setProperty(XMLInputFactory.SUPPORT_DTD, false);
    factory.setProperty(XMLInputFactory.IS_COALESCING, true);
    final var r = factory.createXMLStreamReader(in, "UTF-8");

    final Map<String, Integer> ordinals = new HashMap<>();
    final List<ResourceDecl> decls = new ArrayList<>();
    // ponytail: started activities are held until their ACT_END. In the products seen so far an ACT_END
    // directly follows its ACT_START (never more than one open); spill to a table if a product interleaves many.
    final Map<String, OpenActivity> open = new LinkedHashMap<>();
    boolean manifestDone = false;

    while (r.hasNext()) {
      if (r.next() != XMLStreamConstants.START_ELEMENT) continue;
      switch (r.getLocalName()) {
        case "ResourceSpec" -> {
          final var decl = readSpec(r);
          if (ordinals.putIfAbsent(decl.key(), decls.size()) == null) {
            decls.add(decl);
            sink.declare(decl);
          }
        }
        case "TOLrecord" -> {
          final var type = r.getAttributeValue(null, "type");
          final boolean resource = type != null && type.startsWith("RES_");
          if (!resource && !"ACT_START".equals(type) && !"ACT_END".equals(type)) {
            skipElement(r);
            continue;
          }
          if (!manifestDone) {
            manifestDone = true;
            sink.manifestComplete();
          }
          if (resource) {
            readRecord(r, sink, ordinals, decls);
          } else if ("ACT_START".equals(type)) {
            final var activity = readActivityStart(r);
            open.put(activity.key, activity);
          } else {
            final var end = readActivityEnd(r);
            // An end for an activity never started carries nothing to keep.
            final var activity = open.remove(end.key());
            if (activity != null) sink.activity(activity.ended(end));
          }
        }
        default -> {}
      }
    }
    if (!manifestDone) sink.manifestComplete();
    // Never ended: they keep the end their span attribute gave, else their start.
    for (final var activity : open.values()) sink.activity(activity.ended(null));
    r.close();
  }

  private record ActivityEnd(String key, long time, String text) {}

  /** A started activity, until its ACT_END (or the end of the file) closes it. */
  private record OpenActivity(
      String key, String type, String name, String category, long start, Long span,
      Map<String, Object> attributes, Map<String, Object> parameters, Map<String, Object> metadata)
  {
    ActivityRecord ended(ActivityEnd end) {
      if (end != null) metadata.put("actEnd", end.text());
      final long endMicros = span != null ? start + span : end != null ? Math.max(start, end.time()) : start;
      return new ActivityRecord(key, type, name, category, start, endMicros,
          Json.write(attributes), Json.write(parameters), Json.write(metadata));
    }
  }

  private static OpenActivity readActivityStart(XMLStreamReader r) throws XMLStreamException {
    String time = null, id = null, name = null, type = null;
    final Map<String, Object> attributes = new LinkedHashMap<>();
    final Map<String, Object> parameters = new LinkedHashMap<>();
    final Map<String, Object> metadata = new LinkedHashMap<>();
    while (r.hasNext()) {
      final int ev = r.next();
      if (ev == XMLStreamConstants.END_ELEMENT && r.getLocalName().equals("TOLrecord")) break;
      if (ev != XMLStreamConstants.START_ELEMENT) continue;
      switch (r.getLocalName()) {
        case "TimeStamp" -> time = r.getElementText();
        case "Instance" -> {}
        case "ID" -> id = r.getElementText();
        case "Name" -> name = r.getElementText();
        case "Type" -> type = r.getElementText();
        case "Attributes" -> readNamedValues(r, "Attributes", attributes);
        case "Parameters" -> readNamedValues(r, "Parameters", parameters);
        // Parent, Visibility and anything else the instance carries is provenance.
        default -> metadata.put(lowerFirst(r.getLocalName()), readValue(r));
      }
    }
    if (time == null || id == null) throw new IllegalArgumentException("ACT_START without TimeStamp or ID");
    // The span attribute is the duration, in ms.
    final Long span = attributes.get("span") instanceof Number ms ? Math.round(ms.doubleValue() * 1000) : null;
    final var category = attributes.get("subsystem") instanceof String subsystem ? subsystem : null;
    return new OpenActivity(id, type == null ? "" : type, name == null ? id : name, category, parseTime(time), span,
        attributes, parameters, metadata);
  }

  private static ActivityEnd readActivityEnd(XMLStreamReader r) throws XMLStreamException {
    String time = null, id = null;
    while (r.hasNext()) {
      final int ev = r.next();
      if (ev == XMLStreamConstants.END_ELEMENT && r.getLocalName().equals("TOLrecord")) break;
      if (ev != XMLStreamConstants.START_ELEMENT) continue;
      switch (r.getLocalName()) {
        case "TimeStamp" -> time = r.getElementText();
        case "ActivityID" -> id = r.getElementText();
        default -> skipElement(r);
      }
    }
    if (time == null || id == null) throw new IllegalArgumentException("ACT_END without TimeStamp or ActivityID");
    return new ActivityEnd(id, parseTime(time), time);
  }

  /** {@code <Attribute|Parameter><Name>n</Name><XValue>…</XValue></…>} entries of {@code container}, in order. */
  private static void readNamedValues(XMLStreamReader r, String container, Map<String, Object> out)
      throws XMLStreamException
  {
    String name = null;
    Object value = null;
    while (r.hasNext()) {
      final int ev = r.next();
      if (ev == XMLStreamConstants.END_ELEMENT) {
        if (r.getLocalName().equals(container)) break;
        if (r.getLocalName().equals("Attribute") || r.getLocalName().equals("Parameter")) {
          if (name != null) out.put(name, value);
          name = null;
          value = null;
        }
      } else if (ev == XMLStreamConstants.START_ELEMENT) {
        switch (r.getLocalName()) {
          case "Attribute", "Parameter" -> {}
          case "Name" -> name = r.getElementText();
          default -> value = readValue(r);
        }
      }
    }
  }

  /** A typed TOL value as JSON (the reader is on its start tag, and is left on its end tag). */
  private static Object readValue(XMLStreamReader r) throws XMLStreamException {
    final var tag = r.getLocalName();
    switch (tag) {
      case "StringValue", "TimeValue" -> { return r.getElementText(); }
      case "BooleanValue" -> { return Boolean.parseBoolean(r.getElementText().trim()); }
      case "IntegerValue" -> {
        final var text = r.getElementText().trim();
        try { return Long.parseLong(text); } catch (NumberFormatException e) { return text; }
      }
      case "DoubleValue" -> { return number(r.getElementText().trim()); }
      case "DurationValue" -> {
        final var ms = r.getAttributeValue(null, "milliseconds");
        final var text = r.getElementText();
        return ms != null ? number(ms) : text;
      }
      case "ListValue", "StructValue" -> {
        final boolean list = tag.equals("ListValue");
        final List<Object> items = new ArrayList<>();
        final Map<String, Object> fields = new LinkedHashMap<>();
        String index = null;
        while (r.hasNext()) {
          final int ev = r.next();
          if (ev == XMLStreamConstants.END_ELEMENT && r.getLocalName().equals(tag)) break;
          if (ev != XMLStreamConstants.START_ELEMENT) continue;
          if (r.getLocalName().equals("Element")) {
            index = r.getAttributeValue(null, "index");
          } else {
            final var value = readValue(r);
            if (list) items.add(value); else fields.put(index == null ? Integer.toString(fields.size()) : index, value);
          }
        }
        return list ? items : fields;
      }
      default -> { return readText(r); }
    }
  }

  /** JSON has no NaN or infinity: those stay text. */
  private static Object number(String text) {
    try {
      final double v = Double.parseDouble(text);
      if (!Double.isFinite(v)) return text;
      return v == Math.rint(v) && Math.abs(v) < 1e15 ? (Object) (long) v : (Object) v;
    } catch (NumberFormatException e) {
      return text;
    }
  }

  /** The text of an element, skipping any nested elements. */
  private static String readText(XMLStreamReader r) throws XMLStreamException {
    final var sb = new StringBuilder();
    int depth = 1;
    while (depth > 0 && r.hasNext()) {
      final int ev = r.next();
      if (ev == XMLStreamConstants.START_ELEMENT) depth++;
      else if (ev == XMLStreamConstants.END_ELEMENT) depth--;
      else if (depth == 1 && (ev == XMLStreamConstants.CHARACTERS || ev == XMLStreamConstants.CDATA)) sb.append(r.getText());
    }
    return sb.toString();
  }

  private static String lowerFirst(String s) {
    return s.isEmpty() ? s : Character.toLowerCase(s.charAt(0)) + s.substring(1);
  }

  private static ResourceDecl readSpec(XMLStreamReader r) throws XMLStreamException {
    String name = null, dataType = "", units = "", interpolation = "", category = "", min = null, max = null;
    final List<String> index = new ArrayList<>();
    final List<String> states = new ArrayList<>();
    while (r.hasNext()) {
      final int ev = r.next();
      if (ev == XMLStreamConstants.END_ELEMENT && r.getLocalName().equals("ResourceSpec")) break;
      if (ev != XMLStreamConstants.START_ELEMENT) continue;
      switch (r.getLocalName()) {
        case "Name" -> name = r.getElementText();
        case "Index" -> index.add(r.getElementText());
        case "DataType" -> dataType = r.getElementText();
        case "Units" -> units = r.getElementText();
        case "Interpolation" -> interpolation = r.getElementText();
        case "Subsystem" -> category = r.getElementText();
        case "PossibleStates" -> states.addAll(readValues(r, "PossibleStates"));
        case "Minimum" -> min = first(readValues(r, "Minimum"));
        case "Maximum" -> max = first(readValues(r, "Maximum"));
        default -> {}
      }
    }
    return new ResourceDecl(
        key(name, index), name, List.copyOf(index), dataType, NUMERIC_TYPES.contains(dataType),
        units, interpolation, category, List.copyOf(states), min, max);
  }

  private static void readRecord(
      XMLStreamReader r, Sink sink, Map<String, Integer> ordinals, List<ResourceDecl> decls)
      throws Exception
  {
    String time = null, name = null, valueTag = null, valueText = null, durationMs = null;
    List<String> index = null;
    while (r.hasNext()) {
      final int ev = r.next();
      if (ev == XMLStreamConstants.END_ELEMENT && r.getLocalName().equals("TOLrecord")) break;
      if (ev != XMLStreamConstants.START_ELEMENT) continue;
      final var tag = r.getLocalName();
      switch (tag) {
        case "TimeStamp" -> time = r.getElementText();
        case "Name" -> name = r.getElementText();
        case "Index" -> {
          if (index == null) index = new ArrayList<>(2);
          index.add(r.getElementText());
        }
        default -> {
          if (VALUE_TAGS.contains(tag)) {
            valueTag = tag;
            durationMs = r.getAttributeValue(null, "milliseconds");
            valueText = r.getElementText();
          }
        }
      }
    }
    if (time == null || name == null) throw new IllegalArgumentException("TOLrecord without TimeStamp or Name");

    final var key = key(name, index == null ? List.of() : index);
    final Integer ordinal = ordinals.get(key);
    // The catalog is published before samples, so every resource must be in ResourceMetadata.
    if (ordinal == null) throw new IllegalArgumentException("TOL record references undeclared resource " + key);

    final long t = parseTime(time);
    final var decl = decls.get(ordinal);
    if (valueTag == null) {
      sink.sample(ordinal, t, Double.NaN, null, NULL);
    } else if (decl.numeric()) {
      final double v = "DurationValue".equals(valueTag) && durationMs != null
          ? Double.parseDouble(durationMs)
          : Double.parseDouble(valueText);
      sink.sample(ordinal, t, v, null, VALUE);
    } else {
      sink.sample(ordinal, t, Double.NaN, valueText, VALUE);
    }
  }

  /** The text of each value element directly inside {@code container}. */
  private static List<String> readValues(XMLStreamReader r, String container) throws XMLStreamException {
    final List<String> out = new ArrayList<>();
    while (r.hasNext()) {
      final int ev = r.next();
      if (ev == XMLStreamConstants.END_ELEMENT && r.getLocalName().equals(container)) break;
      if (ev == XMLStreamConstants.START_ELEMENT && VALUE_TAGS.contains(r.getLocalName())) {
        out.add(r.getElementText());
      }
    }
    return out;
  }

  private static void skipElement(XMLStreamReader r) throws XMLStreamException {
    int depth = 1;
    while (depth > 0 && r.hasNext()) {
      final int ev = r.next();
      if (ev == XMLStreamConstants.START_ELEMENT) depth++;
      else if (ev == XMLStreamConstants.END_ELEMENT) depth--;
    }
  }

  private static String first(List<String> values) {
    return values.isEmpty() ? null : values.get(0);
  }

  static String key(String name, List<String> index) {
    if (index.isEmpty()) return name;
    final var sb = new StringBuilder(name);
    for (final var i : index) sb.append('[').append(i).append(']');
    return sb.toString();
  }

  /**
   * {@code YYYY-DDDTHH:MM:SS[.ffffff]} (UTC, day of year) to epoch microseconds.
   * Hand-rolled: it runs once per record, and {@code DateTimeFormatter} is the parse bottleneck.
   */
  static long parseTime(String s) {
    if (s.length() < 17 || s.charAt(4) != '-' || s.charAt(8) != 'T' || s.charAt(11) != ':' || s.charAt(14) != ':') {
      throw new IllegalArgumentException("Unsupported TOL timestamp: " + s);
    }
    final int year = digits(s, 0, 4), doy = digits(s, 5, 8);
    final int hh = digits(s, 9, 11), mm = digits(s, 12, 14), ss = digits(s, 15, 17);
    long micros = 0;
    if (s.length() > 17) {
      if (s.charAt(17) != '.') throw new IllegalArgumentException("Unsupported TOL timestamp: " + s);
      final int n = s.length() - 18;
      if (n < 1 || n > 6) throw new IllegalArgumentException("Unsupported TOL timestamp precision: " + s);
      micros = digits(s, 18, s.length());
      for (int i = n; i < 6; i++) micros *= 10;
    }
    final long days = daysFromCivil(year) + doy - 1;
    return ((days * 86400L + hh * 3600L + mm * 60L + ss) * 1_000_000L) + micros;
  }

  private static int digits(String s, int from, int to) {
    int v = 0;
    for (int i = from; i < to; i++) {
      final int d = s.charAt(i) - '0';
      if (d < 0 || d > 9) throw new IllegalArgumentException("Unsupported TOL timestamp: " + s);
      v = v * 10 + d;
    }
    return v;
  }

  private static final java.util.concurrent.ConcurrentHashMap<Integer, Long> YEAR_START = new java.util.concurrent.ConcurrentHashMap<>();

  /** Days from 1970-01-01 to January 1st of {@code year}. */
  private static long daysFromCivil(int year) {
    return YEAR_START.computeIfAbsent(year, y -> java.time.LocalDate.of(y, 1, 1).toEpochDay());
  }
}
