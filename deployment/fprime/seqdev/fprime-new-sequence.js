// SeqDev Action "F Prime new sequence": start a Rust/WASM sequence from fprime-wasm's own scaffolding.
//   Cargo project does not exist yet → `fprime-wasm init` with the parcel's dictionary, plus the
//                                       restriction profile files
//   Cargo project exists              → `fprime-wasm add <sequence>`
// The new `src/bin/<sequence>.rs` gets the chosen profile in its `#[fprime_main(..)]` attribute,
// which stays the authoritative profile (edit it there to change profiles later).
export const parameterDefinitions = {
  project: {
    defaultValue: 'rust',
    description: 'Workspace folder of the Cargo project (created if it has no Cargo.toml yet)',
    required: true,
    type: 'string',
  },
  sequence: { description: 'Sequence name: lowercase letters, digits and _', required: true, type: 'string' },
  profile: {
    defaultValue: 'restrict',
    type: 'variant',
    variants: [
      { key: 'restrict', label: 'restrict: a list of steps (commands, telemetry, let/const, if)' },
      { key: 'recommended', label: 'recommended: restrict plus loops, helpers and reassignment' },
      { key: '', label: 'none: unrestricted Rust' },
    ],
  },
};
export const settingDefinitions = {
  toolchainUrl: { type: 'string' },
};

const b64 = s => Buffer.from(s).toString('base64');

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
  const request = { files, profile: parameters.profile ?? '', sequence, workspaceId: actionsAPI.workspaceId };
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
    await actionsAPI.writeFile(path, Buffer.from(data, 'base64').toString(), true);
    written.push(path);
  }
  const source = `${project ? `${project}/` : ''}src/bin/${sequence}.rs`;
  return {
    data: { source, written },
    report: [
      `## Created \`${source}\``,
      '',
      exists ? `Added to the Cargo project \`${project}\`.` : `New Cargo project \`${project}\` using the parcel's dictionary.`,
      `Profile: **${parameters.profile || 'none (unrestricted)'}**, set by \`#[fprime_main(..)]\` in the source.`,
      '',
      'Files written:',
      ...written.map(w => `- \`${w}\``),
      '',
      'Open the sequence to edit it; build it with the **F Prime compile** action.',
    ].join('\n'),
    status: 'SUCCESS',
  };
}
