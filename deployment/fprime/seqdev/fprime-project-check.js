// SeqDev Action "F Prime project check": bring a Cargo project created before the current
// toolchain conventions up to date, showing every change first.
//
//   Managed files. Files fprime-wasm generated and nobody has changed are marked
//     `user.managedBy: "fprime-wasm"` (hidden in SeqDev unless "Show managed files" is on;
//     Cargo.toml, build.rs, .cargo/ and the dictionary copy also read-only). "Generated and
//     unchanged" is decided by comparing each file with what `fprime-wasm init` produces today for
//     this project (same crate name, dictionary file name and profiles), never by file name alone:
//     a lib.rs with helper modules, an edited profile or README stays an ordinary file.
//   [[bin]] entries. Sequences no longer need them (Cargo discovers src/bin/*.rs); entries of the
//     exact form fprime-wasm wrote are removed, so renaming or deleting a sequence cannot leave a
//     stale one that breaks every build. Hand-written entries (a `path`, other settings) stay.
//   Dictionary copy. The file build.rs names is what rust-analyzer, builds, tests and external IDEs
//     read; it is replaced by the parcel's dictionary when they differ. Builds and tests refuse to
//     run until it matches, so this is the one place it is updated.
//
// With `apply` off (the default) nothing changes: the report lists what would. Run it again with
// `apply` on to make exactly those changes. Other user metadata on a file is kept.
import { b64, callToolchain, dictionaryPathOf, filesUnder, GENERATED_BIN, nodeAt, readParcelDictionary, sha256 } from './project.js';

export const parameterDefinitions = {
  project: { defaultValue: 'rust', description: 'Workspace folder of the Cargo project', required: true, type: 'string' },
  apply: { defaultValue: false, description: 'Make the listed changes (off: only report them)', type: 'boolean' },
};
export const settingDefinitions = {
  toolchainUrl: { type: 'string' },
};

const MANAGED_BY = 'fprime-wasm';
const isToolControlled = rel => /^(Cargo\.toml|build\.rs|\.cargo\/.+|dictionary\/.+)$/.test(rel);

export function withoutGeneratedBins(manifest) {
  const names = [...manifest.matchAll(GENERATED_BIN)].map(m => m[1]);
  return { manifest: manifest.replace(GENERATED_BIN, ''), names };
}

function metadataOf(node, rel) {
  let children = node;
  const parts = rel.split('/');
  for (const name of parts.slice(0, -1)) children = children?.find(c => c.name === name && c.type === 'DIRECTORY')?.contents;
  return children?.find(c => c.name === parts[parts.length - 1])?.metadata ?? {};
}

/** [{rel, finding, changes: {content?, managed?, readOnly?}}] for the project's infrastructure files. */
export function plan({ current, metadata, reference, dictionaryPath, parcelDictionary, sequences }) {
  const rows = [];
  const cargo = current['Cargo.toml'] !== undefined ? withoutGeneratedBins(current['Cargo.toml']) : null;
  const paths = new Set([...Object.keys(reference), ...(dictionaryPath ? [dictionaryPath] : [])]);
  for (const rel of [...paths].sort()) {
    if (/^(src\/bin|tests)\//.test(rel) || current[rel] === undefined) continue;
    const meta = metadata(rel);
    const managedNow = meta.user?.managedBy === MANAGED_BY;
    const changes = {};
    let finding;
    if (rel === dictionaryPath) {
      finding = 'dictionary copy (named by build.rs)';
      if (current[rel] !== parcelDictionary) {
        changes.content = parcelDictionary;
        finding += `; differs from the parcel dictionary (sha256 ${sha256(current[rel]).slice(0, 12)}… → ${sha256(parcelDictionary).slice(0, 12)}…)`;
      }
    } else if (rel === 'Cargo.toml') {
      const stale = cargo.names.filter(n => !sequences.has(n));
      if (cargo.names.length) {
        changes.content = cargo.manifest;
        finding = `${cargo.names.length} generated [[bin]] entr${cargo.names.length === 1 ? 'y' : 'ies'} to remove (${cargo.names.join(', ')})` +
          (stale.length ? `; stale, no src/bin source: ${stale.join(', ')}` : '');
      }
      if (cargo.manifest !== reference[rel]) {
        rows.push({ changes, finding: [finding, 'differs from what fprime-wasm generates: stays an ordinary file'].filter(Boolean).join('; '), rel });
        continue;
      }
      finding = finding ?? 'generated, unchanged';
    } else if (current[rel] === reference[rel]) {
      finding = 'generated, unchanged';
    } else {
      if (!managedNow) rows.push({ changes, finding: 'differs from what fprime-wasm generates: stays an ordinary file', rel });
      else rows.push({ changes, finding: 'already managed (edited since)', rel });
      continue;
    }
    if (!managedNow) changes.managed = true;
    if (isToolControlled(rel) && meta.readOnly !== true) changes.readOnly = true;
    if (managedNow && !Object.keys(changes).length) finding = 'already managed';
    rows.push({ changes, finding, rel });
  }
  return rows;
}

const describe = c =>
  [c.content !== undefined && 'rewrite content', c.managed && 'mark managed', c.readOnly && 'make read-only'].filter(Boolean).join(', ') || '—';

export async function main(parameters, settings, actionsAPI) {
  const project = parameters.project.replace(/^\/+|\/+$/g, '');
  const prefix = project ? `${project}/` : '';
  const tree = JSON.parse(await actionsAPI.listFiles('', { withMetadata: true }));
  const node = nodeAt(tree, project);
  if (!node?.some(c => c.name === 'Cargo.toml')) throw new Error(`\`${project || '/'}\` has no Cargo.toml`);
  const rels = filesUnder(node);
  const current = {};
  for (const rel of rels) if (!/^(src\/bin|tests)\//.test(rel)) current[rel] = await actionsAPI.readFile(prefix + rel);
  const crate = /^\[package\][^[]*?^name\s*=\s*"([^"]+)"/m.exec(current['Cargo.toml'])?.[1];
  const dictionaryPath = dictionaryPathOf(current['build.rs']);
  if (!crate || !dictionaryPath) throw new Error('Not an fprime-wasm project: no package name in Cargo.toml or no fprime_build::generate in build.rs.');

  // What `fprime-wasm init` writes today for this project, from the toolchain itself.
  const dictionary = await readParcelDictionary(actionsAPI);
  const { ok, result } = await callToolchain(settings, actionsAPI, 'scaffold', {
    crate,
    dictionary: b64(dictionary.text),
    dictionaryName: dictionaryPath.split('/').pop(),
    files: {},
    profile: '',
    sequence: 'startup',
  });
  if (!ok) throw new Error(`Toolchain service: ${result.error}`);
  const reference = Object.fromEntries(Object.entries(result.files).map(([rel, data]) => [rel, Buffer.from(data, 'base64').toString()]));
  const sequences = new Set(rels.map(rel => /^src\/bin\/([^/]+)\.rs$/.exec(rel)?.[1]).filter(Boolean));

  const rows = plan({ current, dictionaryPath, metadata: rel => metadataOf(node, rel), parcelDictionary: dictionary.text, reference, sequences });
  const pending = rows.filter(r => Object.keys(r.changes).length);
  if (parameters.apply === true) {
    for (const { rel, changes } of pending) {
      const path = prefix + rel;
      if (changes.content !== undefined) {
        await actionsAPI.setFileMetadata(path, { readOnly: false }).catch(() => undefined);
        await actionsAPI.writeFile(path, changes.content, true);
      }
      const keepReadOnly = metadataOf(node, rel).readOnly === true;
      const metadata = {
        ...(changes.readOnly || (changes.content !== undefined && keepReadOnly) ? { readOnly: true } : {}),
        ...(changes.managed ? { user: { managedBy: MANAGED_BY } } : {}),
      };
      // Deep merge: other keys of `user` stay.
      if (Object.keys(metadata).length) await actionsAPI.setFileMetadata(path, metadata, { mergeBehavior: 'deep' });
    }
  }
  const verb = parameters.apply === true ? 'Changed' : 'Would change';
  return {
    data: { applied: parameters.apply === true, rows },
    report: [
      `## F Prime project check: \`${project || '/'}\``,
      '',
      pending.length
        ? `${verb} ${pending.length} file(s).` + (parameters.apply === true ? '' : ' Nothing has been changed: run again with **apply** on to make these changes.')
        : 'Nothing to change.',
      '',
      '| File | Finding | ' + (parameters.apply === true ? 'Done' : 'Would do') + ' |',
      '|---|---|---|',
      ...rows.map(r => `| \`${prefix}${r.rel}\` | ${r.finding} | ${describe(r.changes)} |`),
      '',
      'Sequences (`src/bin/*.rs`), tests and files fprime-wasm does not generate are not touched.',
    ].join('\n'),
    status: 'SUCCESS',
  };
}
