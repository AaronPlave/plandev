// SeqDev Action "F Prime compile": build a sequence with F Prime's own tools.
//   .seq → dictionary check → fprime-seqgen → .bin            (next to the source)
//   .rs  → fprime-wasm build (restriction profile) + verify → .wasm (in <cargo project>/out/)
// The tools run in the F Prime toolchain service, never in the action server. The parcel's F Prime
// dictionary is authoritative: `.seq` builds use it directly; a Cargo project builds against its own
// copy (what rust-analyzer reads too) and is refused when that copy differs from the parcel's.
// Built by `npm run build` into dist/fprime-compile.js (bundling the shared `.seq` validator).
import { fprimeSeqParser, validateFprimeSeq } from '@nasa-jpl/plandev-sequence-languages';
import { b64, callToolchain, readCargoProject, readParcelDictionary, sha256 } from './project.js';

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
    'Stages: *dictionary* = checked against the parcel dictionary before compiling (`.seq`: the commands; Rust: the project\'s copy); *compile* = compiler error; ' +
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
  // Parcel dictionary: the same one the editor uses for completion and linting.
  const dictionary = await readParcelDictionary(actionsAPI);
  const { info: dictionaryInfo, row: dictionaryRow } = dictionary;

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
    files['dictionary.json'] = b64(dictionary.text);
    artifactDir = source.path.split('/').slice(0, -1).join('/');
  } else {
    // Read from a revision, the source is sent as it was there; everything else as it is now.
    const project = await readCargoProject(actionsAPI, source.path, dictionary, { [source.path]: sourceText });
    if (project.dictionaryProblem) {
      const diagnostics = [{ column: 1, file: project.projectDictionary.path, line: 1, message: project.dictionaryProblem, severity: 'error', stage: 'dictionary' }];
      const result = { diagnostics, notes: project.notes, ok: false, source, verify: null, written: [] };
      return { data: { diagnostics, projectDictionary: project.projectDictionary }, report: report({ ...result, dictionaryInfo, toolchain: null }), status: 'FAILED' };
    }
    Object.assign(files, project.files);
    notes.push(...project.notes);
    const prefix = project.prefix;
    target = source.path.slice(prefix.length);
    artifactDir = `${prefix}out`;
  }

  const response = await callToolchain(settings, actionsAPI, 'build', {
    files,
    kind: isRust ? 'rust' : 'seq',
    target,
    timebase: settings.seqTimeBase ?? null,
  });
  if (!response.ok) throw new Error(`Toolchain service: HTTP ${response.status} ${response.result.error ?? ''}`);
  const build = response.result;
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
      const verified = build.verify?.modules?.[0];
      await actionsAPI.setFileMetadata(path, {
        readOnly: true,
        user: {
          fprimeBuild: {
            ...provenance,
            bytes: bytes.length,
            sha256: sha256(bytes),
            // Rust: the module loaded in spacewasm within sequencer.toml limits (`.seq` has no verify step).
            verify: verified ? { ok: !!verified.passed, totalBytes: verified.sizes?.total ?? null } : null,
          },
        },
      });
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
