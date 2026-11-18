// SeqDev Action "F Prime new sequence": start a Rust/WASM sequence from fprime-wasm's own scaffolding.
//   Cargo project does not exist yet → `fprime-wasm init` with the parcel's dictionary, plus the
//                                       restriction profile files
//   Cargo project exists              → `fprime-wasm add <sequence>`
//   `test` set                        → also (or, for an existing sequence, only) tests/<sequence>.rs
// The new `src/bin/<sequence>.rs` gets the chosen profile in its `#[fprime_main(..)]` attribute,
// which stays the authoritative profile (edit it there to change profiles later).
//
// Project infrastructure the toolchain writes (Cargo.toml, .cargo/, build.rs, src/lib.rs, the
// dictionary copy, profiles, sequencer.toml, README.md) is marked `user.managedBy`: SeqDev hides
// such files unless "Show managed files" is on. Those the tool rewrites or that must match the
// toolchain are also read-only; lib.rs (helper modules), profiles and sequencer.toml are mission
// configuration and stay editable. Sequences and tests are ordinary files.
export const parameterDefinitions = {
  project: {
    defaultValue: 'rust',
    description: 'Workspace folder of the Cargo project (created if it has no Cargo.toml yet)',
    required: true,
    type: 'string',
  },
  sequence: { description: 'Sequence name: lowercase letters, digits and _', required: true, type: 'string' },
  test: {
    defaultValue: false,
    description: 'Also write tests/<sequence>.rs; for an existing sequence, only its test',
    type: 'boolean',
  },
  profile: {
    defaultValue: 'restrict',
    type: 'variant',
    variants: [
      { key: 'restrict', label: 'restrict: a list of steps (commands, telemetry, let/const, if)' },
      { key: 'recommended', label: 'recommended: fprime-wasm\'s recommended rules (see profile_recommended.toml)' },
      { key: '', label: 'none: unrestricted Rust' },
    ],
  },
};
export const settingDefinitions = {
  toolchainUrl: { type: 'string' },
};

const b64 = s => Buffer.from(s).toString('base64');
const MANAGED_BY = 'fprime-wasm';
/** What authors write: sequences and tests. Everything else the scaffold writes is infrastructure. */
const isAuthored = rel => /^(src\/bin|tests)\/[^/]+\.rs$/.test(rel);
const isToolControlled = rel => /^(Cargo\.toml|build\.rs|\.cargo\/.+|dictionary\/.+)$/.test(rel);

function nodeAt(tree, dir) {
  let node = tree;
  for (const name of dir.split('/').filter(Boolean)) {
    node = node?.find(c => c.name === name && c.type === 'DIRECTORY')?.contents;
  }
  return node ?? null;
}

function filesUnder(node) {
  const out = [];
  const walk = (children, rel) => {
    for (const c of children) {
      if (c.type === 'DIRECTORY') {
        if (!['target', 'out'].includes(c.name)) walk(c.contents ?? [], `${rel}${c.name}/`);
      } else out.push(`${rel}${c.name}`);
    }
  };
  walk(node, '');
  return out;
}

export async function main(parameters, settings, actionsAPI) {
  const authorization = actionsAPI.config.SECRETS?.authorization;
  if (!authorization) throw new Error('No user credentials for this run; the toolchain service requires them.');
  if (!settings.toolchainUrl) throw new Error('Set the "toolchainUrl" setting of this action (see deployment/fprime/README.md).');
  const project = parameters.project.replace(/^\/+|\/+$/g, '');
  const sequence = parameters.sequence.trim();

  const tree = JSON.parse(await actionsAPI.listFiles(''));
  const projectNode = nodeAt(tree, project);
  const exists = projectNode?.some(c => c.name === 'Cargo.toml');
  const files = {};
  const wantTest = parameters.test === true;
  const request = { files, profile: parameters.profile ?? '', sequence, test: wantTest, workspaceId: actionsAPI.workspaceId };
  if (exists) {
    for (const rel of filesUnder(projectNode)) files[rel] = b64(await actionsAPI.readFile(`${project}/${rel}`));
  } else {
    const parcel = await actionsAPI.readParcel();
    const dictionaryRow = await actionsAPI.readCommandDictionary(parcel.command_dictionary_id);
    if (!dictionaryRow.dictionary_file_path) {
      throw new Error('The parcel dictionary was uploaded without its source file; re-upload it with "persist" enabled.');
    }
    request.dictionary = b64(await actionsAPI.readDictionaryFile(dictionaryRow.dictionary_file_path));
    request.dictionaryName = `${dictionaryRow.mission || 'dictionary'}.json`.replace(/[^\w.-]/g, '_');
    request.crate = (project.split('/').pop() || 'sequences').toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^[^a-z]+/, '') || 'sequences';
  }

  const response = await fetch(`${settings.toolchainUrl.replace(/\/$/, '')}/scaffold`, {
    body: JSON.stringify(request),
    // The user's token and active role: the toolchain checks workspace access as SeqDev would.
    headers: { Authorization: authorization, 'Content-Type': 'application/json', 'x-hasura-role': actionsAPI.config.USER_ROLE || '' },
    method: 'POST',
  }).catch(e => {
    throw new Error(`The F Prime toolchain service is unreachable at ${settings.toolchainUrl} (${e.cause?.code ?? e.message}). Ask an administrator to start it (deployment/fprime/README.md).`);
  });
  const result = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) {
    return { data: result, report: `## Could not create \`${sequence}\`\n\n${result.error}`, status: 'FAILED' };
  }

  const written = [];
  for (const [rel, data] of Object.entries(result.files)) {
    const path = project ? `${project}/${rel}` : rel;
    const managed = !isAuthored(rel);
    const readOnly = isToolControlled(rel);
    // A read-only file the tool rewrites (Cargo.toml gains a [[bin]]) is unlocked for the write.
    if (readOnly && exists) await actionsAPI.setFileMetadata(path, { readOnly: false }).catch(() => undefined);
    await actionsAPI.writeFile(path, Buffer.from(data, 'base64').toString(), true);
    if (managed) await actionsAPI.setFileMetadata(path, { readOnly, user: { managedBy: MANAGED_BY } });
    written.push({ managed, path });
  }
  const prefix = project ? `${project}/` : '';
  const created = `${prefix}${wantTest && exists && files[`src/bin/${sequence}.rs`] ? 'tests' : 'src/bin'}/${sequence}.rs`;
  const authored = written.filter(w => !w.managed);
  const managed = written.filter(w => w.managed);
  return {
    data: { created, source: `${prefix}src/bin/${sequence}.rs`, written: written.map(w => w.path) },
    report: [
      `## Created \`${created}\``,
      '',
      exists ? `Added to the Cargo project \`${project}\`.` : `New Cargo project \`${project}\` using the parcel's dictionary.`,
      created.includes('/src/bin/') || created.startsWith('src/bin/')
        ? `Profile: **${parameters.profile || 'none (unrestricted)'}**, set by \`#[fprime_main(..)]\` in the source.`
        : 'Run it with the **F Prime test** action.',
      '',
      ...authored.map(w => `- \`${w.path}\``),
      managed.length
        ? `- ${managed.length} project file(s) maintained by the toolchain (hidden unless "Show managed files" is on): ` +
          managed.map(w => `\`${w.path.slice(prefix.length)}\``).join(', ')
        : '',
      '',
      'Build it with the **F Prime compile** action.',
    ].join('\n'),
    status: 'SUCCESS',
  };
}
