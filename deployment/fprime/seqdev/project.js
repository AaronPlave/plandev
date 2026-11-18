// Shared by the F Prime Actions (bundled into each): finding a sequence's Cargo project in the
// workspace, and preparing what the toolchain service builds or tests.

export const b64 = s => Buffer.from(s).toString('base64');
// `require` at the call: a top-level `crypto` binding would shadow the action context's global `crypto` getter.
export const sha256 = s => require('crypto').createHash('sha256').update(s).digest('hex');

export function nodeAt(tree, dir) {
  let node = tree;
  for (const name of dir.split('/').filter(Boolean)) {
    node = node?.find(c => c.name === name && c.type === 'DIRECTORY')?.contents;
  }
  return node ?? null;
}

/** Project-relative paths of the files under a tree node; build output (target/, out/) is never an input. */
export function filesUnder(node) {
  const out = [];
  const walk = (children, rel) => {
    for (const c of children) {
      if (c.type === 'DIRECTORY') {
        if (!['target', 'out'].includes(c.name)) walk(c.contents ?? [], `${rel}${c.name}/`);
      } else out.push(`${rel}${c.name}`);
    }
  };
  walk(node ?? [], '');
  return out;
}

/** Folder of the nearest Cargo.toml above `path` ('' for the workspace root), or null. */
export function cargoProjectOf(tree, path) {
  const parts = path.split('/').filter(Boolean);
  for (let depth = parts.length - 1; depth >= 0; depth--) {
    if (nodeAt(tree, parts.slice(0, depth).join('/'))?.some(c => c.name === 'Cargo.toml')) {
      return parts.slice(0, depth).join('/');
    }
  }
  return null;
}

/** The parcel's F Prime dictionary: authoritative; `.seq` builds use it, Cargo projects must carry a copy equal to it. */
export async function readParcelDictionary(actionsAPI) {
  const parcel = await actionsAPI.readParcel();
  const row = await actionsAPI.readCommandDictionary(parcel.command_dictionary_id);
  if (!row.dictionary_file_path) {
    throw new Error('The parcel dictionary was uploaded without its source file; re-upload it with "persist" enabled.');
  }
  const text = await actionsAPI.readDictionaryFile(row.dictionary_file_path);
  return { info: { mission: row.mission, sha256: sha256(text), version: row.version }, row, text };
}

/** The dictionary path build.rs passes to `fprime_build::generate`, relative to the project. */
export function dictionaryPathOf(buildRs) {
  return /generate\("([^"]+)"\)/.exec(buildRs ?? '')?.[1] ?? null;
}

/** The `[[bin]]` entry fprime-wasm used to write per sequence; Cargo now discovers src/bin/*.rs itself. */
export const GENERATED_BIN = /\[\[bin\]\]\nname = "([a-z][a-z0-9_]*)"\nrequired-features = \["wasm"\]\ntest = false\nbench = false\n\n?/g;

/**
 * The Cargo project holding `path`, read for the toolchain service exactly as it is in the workspace:
 * builds and tests compile against the project's own dictionary copy (the file build.rs names), the
 * same file rust-analyzer and an external IDE read. That copy must equal the parcel's dictionary;
 * when it doesn't, `dictionaryProblem` says why and the caller refuses to build (nothing is
 * rewritten here: **F Prime project check** updates the copy, explicitly).
 * `overrides`: {workspace path: text} to send instead of the stored file (e.g. a source revision).
 */
export async function readCargoProject(actionsAPI, path, dictionary, overrides = {}) {
  const tree = JSON.parse(await actionsAPI.listFiles(''));
  const project = cargoProjectOf(tree, path);
  if (project === null) throw new Error(`${path} is not inside a Cargo project (no Cargo.toml above it)`);
  const prefix = project ? `${project}/` : '';
  const rels = filesUnder(nodeAt(tree, project));
  const files = {};
  for (const rel of rels) files[rel] = b64(overrides[prefix + rel] ?? (await actionsAPI.readFile(prefix + rel)));
  const text = rel => (files[rel] === undefined ? undefined : Buffer.from(files[rel], 'base64').toString());
  const dictionaryPath = dictionaryPathOf(text('build.rs'));
  if (!dictionaryPath) throw new Error(`${prefix}build.rs does not call fprime_build::generate("<dictionary>")`);
  const copy = text(dictionaryPath);
  const projectDictionary = { path: prefix + dictionaryPath, sha256: copy === undefined ? null : sha256(copy) };
  const check = `run **F Prime project check** (project \`${project || '/'}\`, then again with **apply** on) to update it`;
  const dictionaryProblem =
    copy === undefined
      ? `The project's dictionary \`${projectDictionary.path}\` (named by build.rs) is missing: ${check}.`
      : copy !== dictionary.text
        ? `The project's dictionary \`${projectDictionary.path}\` (sha256 \`${projectDictionary.sha256.slice(0, 12)}…\`) ` +
          `differs from the parcel dictionary ${dictionary.info.mission} ${dictionary.info.version} ` +
          `(sha256 \`${dictionary.info.sha256.slice(0, 12)}…\`). The editor, builds and tests all use the project's copy, ` +
          `so nothing was built against a dictionary the editor isn't showing: ${check}.`
        : null;
  const notes = [];
  const bins = [...(text('Cargo.toml') ?? '').matchAll(GENERATED_BIN)].map(m => m[1]);
  if (bins.length) {
    notes.push(
      `\`${prefix}Cargo.toml\` still declares ${bins.length} sequence(s) the old way (\`[[bin]]\` ${bins.join(', ')}); ` +
        'renaming or deleting one of them breaks every build. **F Prime project check** removes these entries.',
    );
  }
  return { dictionaryProblem, files, notes, prefix, project, projectDictionary, rels };
}

export async function callToolchain(settings, actionsAPI, endpoint, body) {
  const authorization = actionsAPI.config.SECRETS?.authorization;
  if (!authorization) throw new Error('No user credentials for this run; the toolchain service requires them.');
  if (!settings.toolchainUrl) throw new Error('Set the "toolchainUrl" setting of this action (see deployment/fprime/README.md).');
  const response = await fetch(`${settings.toolchainUrl.replace(/\/$/, '')}/${endpoint}`, {
    body: JSON.stringify({ ...body, workspaceId: actionsAPI.workspaceId }),
    // The user's token and active role: the toolchain checks workspace access as SeqDev would.
    headers: { Authorization: authorization, 'Content-Type': 'application/json', 'x-hasura-role': actionsAPI.config.USER_ROLE || '' },
    method: 'POST',
  }).catch(e => {
    throw new Error(`The F Prime toolchain service is unreachable at ${settings.toolchainUrl} (${e.cause?.code ?? e.message}). Ask an administrator to start it (deployment/fprime/README.md).`);
  });
  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  return { ok: response.ok, result, status: response.status };
}
