package gov.nasa.ammos.plandev.workspace.server;

import gov.nasa.ammos.plandev.workspace.server.postgres.RenderType;

import javax.json.Json;
import javax.json.JsonObject;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

/**
 * "Find in workspace": case-insensitive plain-text search of the saved files under a workspace folder.
 * Files that are not UTF-8 text (a NUL byte, or undecodable) and files over {@link #MAX_FILE_BYTES} are skipped and
 * counted. Results are capped per file and in total; {@code truncated} says when a cap was hit.
 * ponytail: walks and reads every file on each request, no index; add one only if large workspaces measure too slow.
 */
public final class WorkspaceSearch {
  private WorkspaceSearch() {}

  static final int MAX_MATCHES = 500;
  static final int MAX_MATCHES_PER_FILE = 50;
  static final long MAX_FILE_BYTES = 2L * 1024 * 1024;
  static final int SNIPPET_CHARS = 200;

  /**
   * @param root the workspace root
   * @param directory the folder to search, already resolved and validated against the root
   */
  public static JsonObject search(final Path root, final Path directory, final String query) throws IOException {
    final var needle = query.toLowerCase(Locale.ROOT);
    final var matches = Json.createArrayBuilder();
    int total = 0, filesSearched = 0, filesSkipped = 0;
    boolean truncated = false;
    final var files = WorkspacePaths.walk(directory, Integer.MAX_VALUE).stream()
        .filter(p -> Files.isRegularFile(p) && !RenderType.isAerieMetadataFile(p.getFileName().toString()))
        .sorted()
        .toList();
    for (final var file : files) {
      if (total >= MAX_MATCHES) {
        truncated = true;
        break;
      }
      final var text = readText(file);
      if (text == null) {
        filesSkipped++;
        continue;
      }
      filesSearched++;
      final var path = root.relativize(file).toString().replace('\\', '/');
      int inFile = 0, lineNumber = 0;
      for (final var line : text.split("\n", -1)) {
        lineNumber++;
        final int at = line.toLowerCase(Locale.ROOT).indexOf(needle);
        if (at < 0) continue;
        if (inFile == MAX_MATCHES_PER_FILE || total == MAX_MATCHES) {
          truncated = true;
          break;
        }
        final int from = Math.max(0, Math.min(at - SNIPPET_CHARS / 4, line.length() - SNIPPET_CHARS));
        matches.add(Json.createObjectBuilder()
                        .add("path", path)
                        .add("line", lineNumber)
                        .add("column", at + 1)
                        .add("snippet", line.substring(from, Math.min(line.length(), from + SNIPPET_CHARS)).stripTrailing())
                        .add("snippetStart", from));
        inFile++;
        total++;
      }
    }
    return Json.createObjectBuilder()
               .add("matches", matches)
               .add("filesSearched", filesSearched)
               .add("filesSkipped", filesSkipped)
               .add("truncated", truncated)
               .build();
  }

  /** The file as UTF-8 text, or null when it is too large or not text. */
  static String readText(final Path file) throws IOException {
    if (Files.size(file) > MAX_FILE_BYTES) return null;
    final var bytes = Files.readAllBytes(file);
    for (final byte b : bytes) {
      if (b == 0) return null;
    }
    try {
      return StandardCharsets.UTF_8.newDecoder()
                                   .onMalformedInput(CodingErrorAction.REPORT)
                                   .onUnmappableCharacter(CodingErrorAction.REPORT)
                                   .decode(ByteBuffer.wrap(bytes))
                                   .toString();
    } catch (CharacterCodingException e) {
      return null;
    }
  }
}
