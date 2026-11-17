// SeqDev Action "F Prime compile": build a sequence with F Prime's own tools.
//   .seq → dictionary check → fprime-seqgen → .bin            (next to the source)
//   .rs  → fprime-wasm build (restriction profile) + verify → .wasm (in <cargo project>/out/)
// The tools run in the F Prime toolchain service, never in the action server. The parcel's F Prime
// dictionary is authoritative for both languages: it replaces whatever copy a Cargo project carries.
// Built by `npm run build` into dist/fprime-compile.js (bundling the shared `.seq` validator).
import { fprimeSeqParser, validateFprimeSeq } from '@nasa-jpl/plandev-sequence-languages';

export const parameterDefinitions = {
  source: {
    description: 'A .seq sequence, or a Rust sequence (src/bin/<name>.rs in a Cargo project)',
    pattern: '*.{seq,rs}',
    required: true,
    type: 'file',
    withRevision: true,
  },
};
export const settingDefinitions = {
  // F Prime toolchain service build endpoint, e.g. http://fprime_toolchain:9258
  toolchainUrl: { type: 'string' },
  // Optional `.seq` header time base (fprime-seqgen --timebase); default: TB_DONT_CARE (0xFFFF).
  seqTimeBase: { type: 'int', required: false },
};

const b64 = s => Buffer.from(s).toString('base64');
// `require` at the call: a top-level `crypto` binding would shadow the action context's global `crypto` getter.
const sha256 = s => require('crypto').createHash('sha256').update(s).digest('hex');

function filesUnder(tree, dir) {
  let node = tree;
  for (const name of dir.split('/').filter(Boolean)) node = node.find(c => c.name === name).contents;
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

function cargoProjectOf(tree, path) {
  const parts = path.split('/').filter(Boolean);
  for (let depth = parts.length - 1; depth >= 0; depth--) {
    let node = tree;
    for (const name of parts.slice(0, depth)) node = node?.find(c => c.name === name && c.type === 'DIRECTORY')?.contents;
    if (node?.some(c => c.name === 'Cargo.toml')) return parts.slice(0, depth).join('/');
  }
  return null;
}

/** 1-based line/column of an offset. */
function location(text, offset) {
  const before = text.slice(0, offset).split('\n');
  return { column: before[before.length - 1].length + 1, line: before.length };
}

const stageOf = d =>
  d.stage ?? (/\b(not allowed|forbidden|disallowed) in \w+ mode|\bprofile\b/i.test(d.message) ? 'profile' : 'compile');

function report({ source, ok, diagnostics, written, verify, notes, dictionaryInfo, toolchain }) {
  const rows = diagnostics.map(
    d =>
      `| ${stageOf(d)} | ${d.severity} | \`${d.file}:${d.line}:${d.column}\` | ${String(d.message).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`,
  );
  const failedStage = ok ? null : (diagnostics.find(d => d.severity === 'error') ?? {});
  return [
    `## ${ok ? 'Built' : `Build failed (${stageOf(failedStage ?? {})})`}: \`${source.path}\``,
    '',
    ...notes.map(n => `> ${n}`),
    ...written.map(w => `- **${w.path}** (${w.bytes} bytes, sha256 \`${w.sha256.slice(0, 16)}…\`), revision \`${w.revision}\``),
    verify ? `- Verified: loads in spacewasm; ${verify.sizes?.total ?? '?'} bytes, fits \`sequencer.toml\` limits` : '',
    '',
    rows.length ? '| Stage | Level | Location | Message |\n|---|---|---|---|\n' + rows.join('\n') : 'No diagnostics.',
    '',
    'Stages: *dictionary* = checked against the parcel dictionary before compiling; *compile* = compiler error; ' +
      '*profile* = restriction profile violation; *verify* = the module does not load or exceeds `sequencer.toml` limits.',
    '',
    `Dictionary: ${dictionaryInfo.mission} ${dictionaryInfo.version}.` +
      (toolchain
        ? ` Toolchain: ${['rustc', 'fprime-wasm', 'fprime-gds'].map(k => toolchain[k]).join(', ')}` +
          (toolchain.patches?.length ? `; patched: ${toolchain.patches.map(p => p.name).join(', ')}.` : '.')
        : ''),
    '',
    '_A successful build means the sequence compiles, satisfies its restriction profile and loads; it is not a check of operational validity._',
  ].join('\n');
}

export async function main(parameters, settings, actionsAPI) {
  const source = typeof parameters.source === 'string' ? { path: parameters.source } : parameters.source;
  if (!source?.path) throw new Error('Choose the sequence to build (a .seq file, or src/bin/<name>.rs).');
  const isRust = source.path.endsWith('.rs');
  if (isRust && !/(^|\/)src\/bin\/[^/]+\.rs$/.test(source.path)) {
    throw new Error(`${source.path} is not a Rust sequence: sequences are src/bin/<name>.rs in a Cargo project.`);
  }
  const authorization = actionsAPI.config.SECRETS?.authorization;
  if (!authorization) throw new Error('No user credentials for this run; the toolchain service requires them.');
  if (!settings.toolchainUrl) throw new Error('Set the "toolchainUrl" setting of this action (see deployment/fprime/README.md).');

  // Parcel dictionary: the same one the editor uses for completion and linting.
  const parcel = await actionsAPI.readParcel();
  const dictionaryRow = await actionsAPI.readCommandDictionary(parcel.command_dictionary_id);
  if (!dictionaryRow.dictionary_file_path) {
    throw new Error('The parcel dictionary was uploaded without its source file; re-upload it with "persist" enabled.');
  }
  const dictionary = await actionsAPI.readDictionaryFile(dictionaryRow.dictionary_file_path);
  const dictionaryInfo = { mission: dictionaryRow.mission, sha256: sha256(dictionary), version: dictionaryRow.version };

  const sourceText = await actionsAPI.readFile(source);
  const files = {};
  const notes = [];
  let target, artifactDir;
  if (!isRust) {
    // fprime-seqgen accepts missing/extra arguments and crashes on some out-of-range values, so the
    // dictionary check that drives the editor's linting is authoritative here too.
    const problems = validateFprimeSeq(sourceText, fprimeSeqParser.parse(sourceText), dictionaryRow.parsed_json);
    if (problems.some(p => p.severity === 'error')) {
      const diagnostics = problems.map(p => ({
        ...location(sourceText, p.from),
        file: source.path,
        message: p.message,
        severity: p.severity,
        stage: 'dictionary',
      }));
      const result = { diagnostics, notes, ok: false, source, verify: null, written: [] };
      return {
        data: { diagnostics },
        report: report({ ...result, dictionaryInfo, toolchain: null }),
        status: 'FAILED',
      };
    }
    target = source.path.split('/').pop();
    files[target] = b64(sourceText);
    files['dictionary.json'] = b64(dictionary);
    artifactDir = source.path.split('/').slice(0, -1).join('/');
  } else {
    const tree = JSON.parse(await actionsAPI.listFiles(''));
    const project = cargoProjectOf(tree, source.path);
    if (project === null) throw new Error(`${source.path} is not inside a Cargo project (no Cargo.toml above it)`);
    const prefix = project ? `${project}/` : '';
    for (const rel of filesUnder(tree, project)) {
      files[rel] = b64(prefix + rel === source.path ? sourceText : await actionsAPI.readFile(prefix + rel));
    }
    // build.rs names the dictionary; the parcel's replaces it, so .seq and .rs share one dictionary.
    const buildRs = files['build.rs'] && Buffer.from(files['build.rs'], 'base64').toString();
    const dictionaryPath = buildRs && /generate\("([^"]+)"\)/.exec(buildRs)?.[1];
    if (!dictionaryPath) throw new Error('build.rs does not call fprime_build::generate("<dictionary>")');
    if (files[dictionaryPath] && Buffer.from(files[dictionaryPath], 'base64').toString() !== dictionary) {
      notes.push(
        `\`${prefix}${dictionaryPath}\` differs from the parcel dictionary; built against the parcel's (${dictionaryRow.version}). ` +
          'The editor (rust-analyzer) uses the project copy: replace it to keep both in step.',
      );
    }
    files[dictionaryPath] = b64(dictionary);
    target = source.path.slice(prefix.length);
    artifactDir = `${prefix}out`;
  }

  const response = await fetch(`${settings.toolchainUrl.replace(/\/$/, '')}/build`, {
    body: JSON.stringify({
      files,
      kind: isRust ? 'rust' : 'seq',
      target,
      timebase: settings.seqTimeBase ?? null,
      workspaceId: actionsAPI.workspaceId,
    }),
    // The user's token and active role: the toolchain checks workspace access as SeqDev would.
    headers: { Authorization: authorization, 'Content-Type': 'application/json', 'x-hasura-role': actionsAPI.config.USER_ROLE || '' },
    method: 'POST',
  }).catch(e => {
    throw new Error(`The F Prime toolchain service is unreachable at ${settings.toolchainUrl} (${e.cause?.code ?? e.message}). Ask an administrator to start it (deployment/fprime/README.md).`);
  });
  if (!response.ok) {
    throw new Error(`Toolchain service: HTTP ${response.status} ${(await response.text()).slice(0, 500)}`);
  }
  const build = await response.json();
  // Locations relative to the workspace, like the editor's.
  const projectPrefix = isRust ? source.path.slice(0, source.path.length - target.length) : '';
  build.diagnostics = build.diagnostics.map(d => ({ ...d, file: isRust ? projectPrefix + d.file : source.path }));

  const provenance = {
    builtAt: new Date().toISOString(),
    dictionary: dictionaryInfo,
    // Metadata keys may not contain '.', so file names go in values.
    inputs: Object.entries(build.inputs).map(([path, sha]) => ({ path, sha256: sha })),
    source: source.path,
    sourceRevision: source.revision ?? null,
    sourceSha256: sha256(sourceText),
    toolchain: build.toolchain,
  };
  const written = [];
  if (build.ok) {
    for (const [name, data] of Object.entries(build.artifacts)) {
      const path = `${artifactDir ? `${artifactDir}/` : ''}${name}`;
      const bytes = Buffer.from(data, 'base64');
      // Artifacts are read-only between builds; a rebuild replaces its own previous output.
      await actionsAPI.setFileMetadata(path, { readOnly: false }).catch(() => undefined);
      // Binary-safe: the workspace stores the bytes as given (writeFile is typed as string only).
      await actionsAPI.writeFile(path, new Uint8Array(bytes), true);
      await actionsAPI.setFileMetadata(path, { readOnly: true, user: { fprimeBuild: { ...provenance, sha256: sha256(bytes) } } });
      const revision = await actionsAPI.createFileRevision(path, {
        message: `Built from ${source.path}${source.revision ? ` @ ${source.revision}` : ' (working copy)'}`,
      });
      written.push({ bytes: bytes.length, path, revision: revision.name, sha256: sha256(bytes) });
    }
  }

  console.log(build.log);
  const result = { diagnostics: build.diagnostics, notes, ok: build.ok, source, verify: build.verify?.modules?.[0], written };
  return {
    data: { diagnostics: build.diagnostics, provenance, written },
    report: report({ ...result, dictionaryInfo, toolchain: build.toolchain }),
    status: build.ok ? 'SUCCESS' : 'FAILED',
  };
}
