// SeqDev Action "F Prime test": run a Rust sequence project's behaviour tests (`fprime-wasm test`)
// in the F Prime toolchain service, and report each test with its assertion failures.
//   src/bin/<name>.rs or tests/<name>.rs → that sequence's tests (`tests/<name>.rs`, a cargo test target)
//   any other .rs in the project          → every test in the project
// Tests are optional: a sequence without tests reports "No tests defined" and runs nothing. This
// Action never creates tests (create one with New File → "F Prime sequence test").
export const parameterDefinitions = {
  source: {
    description: 'A Rust sequence (src/bin/<name>.rs), its test (tests/<name>.rs), or any project file to run all tests',
    pattern: '*.rs',
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

function cargoProjectOf(tree, path) {
  const parts = path.split('/').filter(Boolean);
  for (let depth = parts.length - 1; depth >= 0; depth--) {
    if (nodeAt(tree, parts.slice(0, depth).join('/'))?.some(c => c.name === 'Cargo.toml')) {
      return parts.slice(0, depth).join('/');
    }
  }
  return null;
}

const fence = text => '~~~\n' + text + '\n~~~';

export async function main(parameters, settings, actionsAPI) {
  const path = (typeof parameters.source === 'string' ? parameters.source : parameters.source?.path) ?? '';
  const authorization = actionsAPI.config.SECRETS?.authorization;
  if (!authorization) throw new Error('No user credentials for this run; the toolchain service requires them.');
  if (!settings.toolchainUrl) throw new Error('Set the "toolchainUrl" setting of this action (see deployment/fprime/README.md).');

  const tree = JSON.parse(await actionsAPI.listFiles(''));
  const project = cargoProjectOf(tree, path);
  if (project === null) throw new Error(`${path} is not inside a Cargo project (no Cargo.toml above it)`);
  const prefix = project ? `${project}/` : '';
  const rels = filesUnder(nodeAt(tree, project));
  const sequence = /^(?:src\/bin|tests)\/([^/]+)\.rs$/.exec(path.slice(prefix.length))?.[1] ?? null;
  const testFiles = rels.filter(rel => /^tests\/[^/]+\.rs$/.test(rel));
  const scope = sequence ? `\`${sequence}\`` : `the project \`${project || '/'}\``;

  // Nothing to run is not a pass: say so instead of reporting an empty green run.
  if (sequence ? !testFiles.includes(`tests/${sequence}.rs`) : testFiles.length === 0) {
    return {
      data: { outcome: 'no-tests', tests: [] },
      report: [
        `## No tests defined for ${scope}`,
        '',
        'Nothing was run. Tests are optional; to add one, use **New File → F Prime sequence test**' +
          (sequence ? ` with the name \`${sequence}\`` : '') +
          `, which writes \`${prefix}tests/${sequence ?? '<name>'}.rs\`.`,
      ].join('\n'),
      status: 'SUCCESS',
    };
  }

  const files = {};
  for (const rel of rels) files[rel] = b64(await actionsAPI.readFile(prefix + rel));
  const response = await fetch(`${settings.toolchainUrl.replace(/\/$/, '')}/test`, {
    body: JSON.stringify({ files, filter: parameters.filter || '', target: sequence, workspaceId: actionsAPI.workspaceId }),
    // The user's token and active role: the toolchain checks workspace access as SeqDev would.
    headers: { Authorization: authorization, 'Content-Type': 'application/json', 'x-hasura-role': actionsAPI.config.USER_ROLE || '' },
    method: 'POST',
  }).catch(e => {
    throw new Error(`The F Prime toolchain service is unreachable at ${settings.toolchainUrl} (${e.cause?.code ?? e.message}). Ask an administrator to start it (deployment/fprime/README.md).`);
  });
  const run = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(`Toolchain service: ${run.error ?? `HTTP ${response.status}`}`);
  console.log(run.log ?? '');

  const tests = run.tests ?? [];
  const count = status => tests.filter(t => t.status === status).length;
  const [passed, failed, ignored] = [count('passed'), count('failed'), count('ignored')];
  let heading;
  if (tests.length === 0 && run.exitCode !== 0) {
    heading = `Tests did not run for ${scope}: the build or test harness failed`;
  } else if (tests.length === 0 || passed + failed === 0) {
    heading = `No tests ran for ${scope}${parameters.filter ? ` matching \`${parameters.filter}\`` : ''}`;
  } else {
    heading = `${failed ? 'Tests failed' : 'Tests passed'} for ${scope}: ${passed} passed, ${failed} failed` +
      (ignored ? `, ${ignored} ignored` : '');
  }
  const ok = run.ok && tests.length > 0 && passed + failed > 0;
  const symbol = { failed: '✗', ignored: '–', passed: '✓' };
  return {
    data: { exitCode: run.exitCode, outcome: ok ? 'passed' : failed ? 'failed' : 'not-run', tests },
    report: [
      `## ${heading}`,
      '',
      ...tests.map(t => `- ${symbol[t.status]} \`${t.target}::${t.name}\` ${t.status}`),
      '',
      ...tests
        .filter(t => t.status === 'failed')
        .flatMap(t => [`### \`${t.target}::${t.name}\``, '', fence(t.output || '(no output)'), '']),
      ...(tests.length === 0 ? ['Output:', '', fence((run.log ?? '').split('\n').slice(-60).join('\n')), ''] : []),
      `\`fprime-wasm ${run.command}\`. Toolchain: ${run.toolchain?.['fprime-wasm'] ?? '?'}, ${run.toolchain?.rustc ?? '?'}.`,
    ].join('\n'),
    status: ok ? 'SUCCESS' : 'FAILED',
  };
}
