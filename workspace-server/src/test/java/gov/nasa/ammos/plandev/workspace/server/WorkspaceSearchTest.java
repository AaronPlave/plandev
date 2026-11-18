package gov.nasa.ammos.plandev.workspace.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WorkspaceSearchTest {
  @Test
  void findsTextSkipsBinaryMetadataAndInternalFiles(@TempDir Path root) throws Exception {
    Files.createDirectories(root.resolve("rust/src/bin"));
    Files.createDirectories(root.resolve(".git"));
    Files.writeString(root.resolve("rust/src/bin/startup.rs"), "fn main() {\n    CdhCore.cmdDisp.CMD_NO_OP();\n}\n");
    Files.writeString(root.resolve("notes.txt"), "no_op is described here\r\n");
    Files.write(root.resolve("rust/out.wasm"), new byte[] {0, 'a', 's', 'm', 'N', 'O', '_', 'O', 'P'});
    Files.writeString(root.resolve("rust/src/bin/.startup.rs.meta.seqdev"), "{\"no_op\": 1}");
    Files.writeString(root.resolve(".git/config"), "no_op");

    final var all = WorkspaceSearch.search(root, root, "No_Op");
    final var matches = all.getJsonArray("matches");
    assertEquals(2, matches.size(), matches.toString());
    assertEquals("notes.txt", matches.getJsonObject(0).getString("path"));
    assertEquals("no_op is described here", matches.getJsonObject(0).getString("snippet"));
    assertEquals("rust/src/bin/startup.rs", matches.getJsonObject(1).getString("path"));
    assertEquals(2, matches.getJsonObject(1).getInt("line"));
    assertEquals(25, matches.getJsonObject(1).getInt("column"));
    assertEquals(1, all.getInt("filesSkipped")); // the binary
    assertFalse(all.getBoolean("truncated"));

    final var scoped = WorkspaceSearch.search(root, root.resolve("rust"), "no_op").getJsonArray("matches");
    assertEquals(1, scoped.size());
  }

  @Test
  void capsMatchesPerFile(@TempDir Path root) throws Exception {
    Files.writeString(root.resolve("big.json"), "x\n".repeat(WorkspaceSearch.MAX_MATCHES_PER_FILE + 10));
    final var result = WorkspaceSearch.search(root, root, "x");
    assertEquals(WorkspaceSearch.MAX_MATCHES_PER_FILE, result.getJsonArray("matches").size());
    assertTrue(result.getBoolean("truncated"));
  }
}
