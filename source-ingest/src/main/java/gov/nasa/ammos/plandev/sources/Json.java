package gov.nasa.ammos.plandev.sources;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;

/** The little JSON this module writes: catalog schemas and metadata. Null values are omitted. */
final class Json {
  private Json() {}

  /** The PlanDev value schema for a declared resource. */
  static String schema(SourceAdapter.ResourceDecl d) {
    final Map<String, Object> schema = new LinkedHashMap<>();
    if (d.numeric()) {
      schema.put("type", "real");
    } else if (!d.possibleStates().isEmpty()) {
      schema.put("type", "variant");
      schema.put("variants", d.possibleStates().stream().map(s -> Map.of("key", s, "label", s)).toList());
    } else {
      schema.put("type", "string");
    }
    final String unit = "duration".equals(d.dataType()) ? "ms" : d.units();
    if (unit != null && !unit.isEmpty()) schema.put("metadata", Map.of("unit", Map.of("value", unit)));
    return write(schema);
  }

  static String object(Object... keyValues) {
    final Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < keyValues.length; i += 2) m.put((String) keyValues[i], keyValues[i + 1]);
    return write(m);
  }

  static String write(Object v) {
    final var sb = new StringBuilder();
    write(sb, v);
    return sb.toString();
  }

  private static void write(StringBuilder sb, Object v) {
    if (v == null) {
      sb.append("null");
    } else if (v instanceof String s) {
      string(sb, s);
    } else if (v instanceof Number || v instanceof Boolean) {
      sb.append(v);
    } else if (v instanceof Map<?, ?> m) {
      sb.append('{');
      boolean first = true;
      for (final var e : m.entrySet()) {
        if (e.getValue() == null) continue;
        if (!first) sb.append(',');
        first = false;
        string(sb, e.getKey().toString());
        sb.append(':');
        write(sb, e.getValue());
      }
      sb.append('}');
    } else if (v instanceof Collection<?> c) {
      sb.append('[');
      boolean first = true;
      for (final var e : c) {
        if (!first) sb.append(',');
        first = false;
        write(sb, e);
      }
      sb.append(']');
    } else {
      string(sb, v.toString());
    }
  }

  private static void string(StringBuilder sb, String s) {
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      final char c = s.charAt(i);
      switch (c) {
        case '"' -> sb.append("\\\"");
        case '\\' -> sb.append("\\\\");
        case '\n' -> sb.append("\\n");
        case '\r' -> sb.append("\\r");
        case '\t' -> sb.append("\\t");
        default -> {
          if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
        }
      }
    }
    sb.append('"');
  }
}
