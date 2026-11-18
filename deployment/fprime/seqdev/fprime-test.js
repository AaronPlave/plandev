// SeqDev Action "F Prime test": run a Rust sequence project's behaviour tests (`fprime-wasm test`)
// in the F Prime toolchain service, and report each test with its assertion failures.
//
// It runs the project's tests: every Cargo integration test in tests/, whatever the files are
// called and however many sequences each covers (`#[fprime_test(sequence = "..")]` names the
// sequence per test function). Which tests exercise a given sequence is only known to the Rust
// code, so this Action does not guess; `filter` narrows the run by test function name, as
// upstream's own filter does. The project is prepared as for "F Prime compile", so tests run
// against the same (parcel) dictionary as builds.
//
// Tests are optional: with none, or none matching the filter, nothing runs and the report says
// "Not run". The status stays SUCCESS (Actions have no neutral status), so the report is explicit
// that zero tests executed. This Action never creates tests.
import { callToolchain, readCargoProject, readParcelDictionary } from './project.js';

export const parameterDefinitions = {
  source: {
    description: 'Any file of the Cargo project (a sequence, a test, Cargo.toml): runs that project\'s tests',
    pattern: '*.{rs,toml}',
    required: true,
    type: 'file',
  },
  filter: {
    description: 'Only tests whose function name contains this (optional, one word)',
    required: false,
    type: 'string',
  },
};
export const settingDefinitions = {
  // F Prime toolchain service build endpoint, e.g. http://fprime_toolchain:9258
  toolchainUrl: { type: 'string' },
};

const fence = text => '~~~\n' + text + '\n~~~';

function notRun(scope, reason, dictionary, notes) {
  return {
    data: { dictionary: dictionary.info, executed: 0, outcome: 'not-run', tests: [] },
    report: [
      `## Not run: ${reason}`,
      '',
      `**0 tests executed** in ${scope}. This is not a pass: there is no test result to report.`,
      '',
      ...notes.map(n => `> ${n}`),
      'Tests are optional. To add one, use **New File → F Prime sequence test**, or write any `tests/*.rs` ' +
        'file with `#[fprime_test(sequence = "<name>")]` functions.',
    ].join('\n'),
    status: 'SUCCESS',
  };
}

export async function main(parameters, settings, actionsAPI) {
  const path = (typeof parameters.source === 'string' ? parameters.source : parameters.source?.path) ?? '';
  const filter = (parameters.filter ?? '').trim();
  const dictionary = await readParcelDictionary(actionsAPI);
  const project = await readCargoProject(actionsAPI, path, dictionary);
  const scope = `the project \`${project.project || '/'}\``;
  const testFiles = project.rels.filter(rel => /^tests\/[^/]+\.rs$/.test(rel) || /^tests\/[^/]+\/main\.rs$/.test(rel));
  if (testFiles.length === 0) return notRun(scope, 'no tests defined', dictionary, project.notes);

  const response = await callToolchain(settings, actionsAPI, 'test', { files: project.files, filter });
  const run = response.result;
  if (!response.ok) throw new Error(`Toolchain service: ${run.error ?? `HTTP ${response.status}`}`);
  console.log(run.log ?? '');

  const tests = run.tests ?? [];
  const count = status => tests.filter(t => t.status === status).length;
  const [passed, failed, ignored] = [count('passed'), count('failed'), count('ignored')];
  if (passed + failed === 0 && run.exitCode === 0) {
    return notRun(scope, filter ? `no test name contains \`${filter}\`` : 'no tests found', dictionary, project.notes);
  }
  const harnessFailed = passed + failed === 0;
  const heading = harnessFailed
    ? `Tests did not run for ${scope}: the build or test harness failed`
    : `${failed ? 'Tests failed' : 'Tests passed'} for ${scope}: ${passed} passed, ${failed} failed` +
      (ignored ? `, ${ignored} ignored` : '');
  const ok = run.ok && !harnessFailed;
  const symbol = { failed: '✗', ignored: '–', passed: '✓' };
  return {
    data: {
      dictionary: dictionary.info,
      executed: passed + failed,
      exitCode: run.exitCode,
      outcome: ok ? 'passed' : 'failed',
      projectDictionary: project.projectDictionary,
      tests,
    },
    report: [
      `## ${heading}`,
      '',
      ...project.notes.map(n => `> ${n}`),
      ...tests.map(t => `- ${symbol[t.status]} \`${t.target}::${t.name}\` ${t.status}`),
      '',
      ...tests
        .filter(t => t.status === 'failed')
        .flatMap(t => [`### \`${t.target}::${t.name}\``, '', fence(t.output || '(no output)'), '']),
      ...(harnessFailed || (!run.ok && !failed) ? ['Output:', '', fence((run.log ?? '').split('\n').slice(-60).join('\n')), ''] : []),
      `\`fprime-wasm ${run.command}\`. Dictionary: ${dictionary.info.mission} ${dictionary.info.version} ` +
        `(sha256 \`${dictionary.info.sha256.slice(0, 16)}…\`). Toolchain: ${run.toolchain?.['fprime-wasm'] ?? '?'}, ${run.toolchain?.rustc ?? '?'}.`,
    ].join('\n'),
    status: ok ? 'SUCCESS' : 'FAILED',
  };
}
