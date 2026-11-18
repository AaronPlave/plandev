// SeqDev Action "F Prime view WAT": an existing .wasm module (any revision) as WebAssembly text,
// disassembled by binaryen's wasm-dis in the toolchain service, shown read-only in the run report.
// Nothing is written to the workspace; very large output is cut off (FPRIME_MAX_WAT_BYTES).
import { callToolchain } from './project.js';

export const parameterDefinitions = {
  module: { description: 'The .wasm module to show (any revision)', pattern: '*.wasm', required: true, type: 'file', withRevision: true },
};
export const settingDefinitions = {
  toolchainUrl: { type: 'string' },
};

export async function main(parameters, settings, actionsAPI) {
  const module = typeof parameters.module === 'string' ? { path: parameters.module } : parameters.module;
  const { ok, result, status } = await callToolchain(settings, actionsAPI, 'inspect', {
    mode: 'wat',
    path: module.path,
    revision: module.revision ?? null,
  });
  if (!ok) throw new Error(`Toolchain service: ${result.error ?? `HTTP ${status}`}`);
  const where = `\`${module.path}\`${module.revision ? ` @ revision ${module.revision}` : ' (working copy)'}`;
  if (!result.ok) {
    return { data: result, report: `## Could not disassemble ${where}\n\n~~~\n${result.error}\n~~~`, status: 'FAILED' };
  }
  return {
    data: { bytes: result.bytes, sha256: result.sha256, watBytes: result.watBytes, watLines: result.watLines },
    report: [
      `## WebAssembly text: ${where}`,
      '',
      `${result.bytes} bytes (sha256 \`${result.sha256.slice(0, 16)}…\`) → ${result.watLines} lines of text` +
        (result.watTruncated ? `, **cut off after ${result.wat.length} characters** of ${result.watBytes} bytes` : '') +
        '. Read-only: binaryen `wasm-dis` output, nothing saved.',
      '',
      '~~~wat',
      result.wat,
      '~~~',
    ].join('\n'),
    status: 'SUCCESS',
  };
}
