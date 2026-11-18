// SeqDev Action "F Prime verify": check an existing .wasm module (a build output, an imported module,
// or any revision of one) against the on-board interpreter's limits with `fprime-wasm verify`,
// without building or changing it. "F Prime compile" runs the same check after every build.
//
// Limits: the `limits` file when given; else the `sequencer.toml` of the Cargo project the module
// sits in (<project>/out/<name>.wasm); else fprime-wasm's stock sequencer. The report says which.
// Verification loads the module and sizes it; it does not run it (stack use is measured by
// "F Prime test"), and passing it says nothing about what the sequence does.
import { callToolchain, cargoProjectOf } from './project.js';

export const parameterDefinitions = {
  module: { description: 'The .wasm module to check (any revision)', pattern: '*.wasm', required: true, type: 'file', withRevision: true },
  limits: {
    description: "Optional sequencer.toml to check against (default: the module's Cargo project's, else fprime-wasm's stock limits)",
    pattern: '*.toml',
    required: false,
    type: 'file',
  },
};
export const settingDefinitions = {
  toolchainUrl: { type: 'string' },
};

/** Which sequencer.toml applies to `path`: [workspace path, text] or [null, null] for the stock limits. */
export async function limitsFor(actionsAPI, path, explicit) {
  if (explicit) return [explicit, await actionsAPI.readFile(explicit)];
  const project = cargoProjectOf(JSON.parse(await actionsAPI.listFiles('')), path);
  if (project === null) return [null, null];
  const candidate = `${project ? `${project}/` : ''}sequencer.toml`;
  const text = await actionsAPI.readFile(candidate).catch(() => null);
  return text === null ? [null, null] : [candidate, text];
}

const fileRef = p => (typeof p === 'string' ? { path: p } : p);
const LIMIT_NAMES = {
  guest_memory: 'guest memory (B)', heap_pages: 'heap pages', max_code_pages: 'code pages', max_guest_modules: 'guest modules',
  page_size: 'page size (B)', stack_size: 'operand stack (words)',
};

export async function main(parameters, settings, actionsAPI) {
  const module = fileRef(parameters.module);
  const limitsPath = parameters.limits ? fileRef(parameters.limits).path : null;
  const [limitsFile, limitsText] = await limitsFor(actionsAPI, module.path, limitsPath);
  const { ok, result, status } = await callToolchain(settings, actionsAPI, 'inspect', {
    limits: limitsText === null ? null : Buffer.from(limitsText).toString('base64'),
    mode: 'verify',
    path: module.path,
    revision: module.revision ?? null,
  });
  if (!ok) throw new Error(`Toolchain service: ${result.error ?? `HTTP ${status}`}`);
  const verify = result.verify;
  const m = verify?.modules?.[0];
  const recorded = (await actionsAPI.getFileMetadata(module.path).catch(() => null))?.user?.fprimeBuild;
  const where = `\`${module.path}\`${module.revision ? ` @ revision ${module.revision}` : ' (working copy)'}`;
  const lines = [
    `## ${result.ok ? 'Fits' : verify ? 'Does not fit' : 'Could not verify'}: ${where}`,
    '',
    `Module: ${result.bytes} bytes, sha256 \`${result.sha256.slice(0, 16)}…\`` +
      (m ? `; code ${m.sizes.code} B, data ${m.sizes.data} B` : '') + '.',
    recorded?.sha256
      ? recorded.sha256 === result.sha256
        ? `Same bytes as the build recorded in this file's \`fprimeBuild\` metadata (from \`${recorded.source}\`). The metadata is editable, so this is a consistency check, not proof of origin.`
        : `**Not** the bytes the working copy's \`fprimeBuild\` metadata records (\`${recorded.sha256.slice(0, 16)}…\`)` +
          (module.revision ? ': expected for an older revision.' : '.')
      : 'No build provenance recorded for this file (imported, or built elsewhere).',
    '',
    `Limits: ${limitsFile ? `\`${limitsFile}\`` : "fprime-wasm's stock sequencer (no `sequencer.toml` found; pass **limits** to choose one)"}` +
      (verify?.limits ? ': ' + Object.entries(verify.limits).map(([k, v]) => `${LIMIT_NAMES[k] ?? k} ${v}`).join(', ') : ''),
    '',
  ];
  if (m) {
    lines.push(
      '| Budget | Needed | Configured | Fits |',
      '|---|---|---|---|',
      ...m.budgets.map(b => `| ${b.setting} (${b.unit}) | ${b.needed} | ${b.configured} | ${b.fits ? 'yes' : '**no**'} |`),
      `| page size (B) | ${m.page_size.required} | ${m.page_size.configured} | ${m.page_size.fits ? 'yes' : '**no**'} |`,
      '',
      ...m.failures.map(f => `- **${typeof f === 'string' ? f : (f.message ?? JSON.stringify(f))}**`),
    );
  }
  for (const e of verify?.errors ?? []) lines.push(`- **${typeof e === 'string' ? e : (e.message ?? JSON.stringify(e))}**`);
  if (!verify) lines.push('fprime-wasm verify gave no result:', '', '~~~', result.log ?? '', '~~~');
  lines.push(
    '',
    `\`fprime-wasm ${result.command}\` (${result.toolchain?.['fprime-wasm'] ?? '?'}). ` +
      '_Verification loads and sizes the module on the interpreter; it does not run it (stack use is measured by **F Prime test**) ' +
      'and is not a check of behaviour or operational validity._',
  );
  return {
    data: { bytes: result.bytes, limits: limitsFile, ok: result.ok, sha256: result.sha256, verify },
    report: lines.join('\n'),
    status: result.ok ? 'SUCCESS' : 'FAILED',
  };
}
