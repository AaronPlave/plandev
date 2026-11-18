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

/** The parcel's F Prime dictionary: the one the editor uses, authoritative for builds and tests. */
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

/**
 * The Cargo project holding `path`, read for the toolchain service, with the parcel's dictionary in
 * place of the project's copy (the file build.rs names). Builds and tests both go through here, so
 * they compile against the same dictionary as each other and as the editor's `.seq` support; a
 * stale project copy is reported in `notes` (rust-analyzer reads that copy), never used.
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
  const dictionaryPath = dictionaryPathOf(files['build.rs'] && Buffer.from(files['build.rs'], 'base64').toString());
  if (!dictionaryPath) throw new Error(`${prefix}build.rs does not call fprime_build::generate("<dictionary>")`);
  const notes = [];
  const copy = files[dictionaryPath] && Buffer.from(files[dictionaryPath], 'base64').toString();
  const projectDictionary = { path: prefix + dictionaryPath, sha256: copy === undefined ? null : sha256(copy) };
  if (copy !== dictionary.text) {
    notes.push(
      copy === undefined
        ? `\`${prefix}${dictionaryPath}\` (named by build.rs) is missing; used the parcel dictionary (${dictionary.info.version}).`
        : `\`${prefix}${dictionaryPath}\` differs from the parcel dictionary; used the parcel's (${dictionary.info.version}). ` +
            'The editor (rust-analyzer) reads the project copy: run **F Prime project check** to update it.',
    );
  }
  files[dictionaryPath] = b64(dictionary.text);
  return { files, prefix, project, projectDictionary, notes, rels };
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
