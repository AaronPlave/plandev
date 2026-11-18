// SeqDev sequence adaptation for F Prime parcels: `.seq` (fprime-seqgen) and `.rs` (fprime-wasm)
// against one F Prime dictionary. Built by `npm run build` into dist/adaptation.js and uploaded
// by setup.py; see ../README.md.
import { getFprimeAdaptation, rustCommandCalls } from '@nasa-jpl/plandev-sequence-languages';
import { lspUrl as configuredLspUrl } from 'fprime:config';

// The toolchain service's rust-analyzer endpoint. Default: same host as SeqDev, port 9257 (the
// browser then sends the SeqDev cookie with the connection). Set FPRIME_LSP_URL at build time
// when the service is published elsewhere, e.g. behind the deployment's reverse proxy. An empty
// value disables it: `.rs` files then get highlighting and dictionary completion only.
const lspUrl =
  configuredLspUrl ??
  (typeof location === 'undefined'
    ? undefined
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:9257/lsp`);

// Mission editor rules: an example. They run in the editor beside rust-analyzer's diagnostics,
// with or without it. They are editor guidance, not flight-rule enforcement.
const DISALLOWED_COMMANDS = {
  'FileHandling.fileManager.ShellCommand': 'runs arbitrary shell commands on board; not allowed in sequences',
};

function missionRules(view) {
  return rustCommandCalls(view.state)
    .filter(call => call.kind === 'command' && DISALLOWED_COMMANDS[call.name])
    .map(call => ({
      from: call.from,
      message: `${call.name} ${DISALLOWED_COMMANDS[call.name]}.`,
      severity: 'error',
      source: 'mission rules',
      to: call.to,
    }));
}

// Rust sequences are created by the "F Prime new sequence" Action (fprime-wasm scaffolding) in a
// Cargo project folder; the Action sets up the project if the workspace has none. A mission picks
// its restriction profile here, in the starters it offers.
const SEQUENCE_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const validateName = name =>
  SEQUENCE_NAME.test(name) ? null : 'Use a lowercase Rust identifier: letters, digits and _, starting with a letter.';
const cargoProject = { containing: 'Cargo.toml', label: 'Cargo project' };
const prefix = destination => (destination ? `${destination}/` : '');

const rustSequence = (label, description, profile) => ({
  action: {
    createdFile: ({ destination, name }) => `${prefix(destination)}src/bin/${name}.rs`,
    destination: { ...cargoProject, createIn: true, newFolder: 'rust' },
    name: 'F Prime new sequence',
    parameters: ({ destination, name }) => ({ profile, project: destination, sequence: name, test: false }),
  },
  description,
  fileExtension: '.rs',
  label,
  namePlaceholder: 'startup',
  validateName,
});

const base = getFprimeAdaptation({ lint: missionRules, lspUrl: lspUrl || undefined });

export const adaptation = {
  ...base,
  fileStarters: [
    ...base.fileStarters,
    rustSequence(
      'F Prime Rust sequence',
      'A list of steps: commands, telemetry and parameter checks, let/const, if (restrict profile)',
      'restrict',
    ),
    rustSequence(
      'F Prime Rust sequence (unrestricted)',
      'Any Rust the toolchain compiles, e.g. loops and helper modules; for mission developers',
      '',
    ),
    {
      action: {
        createdFile: ({ destination, name }) => `${prefix(destination)}tests/${name}.rs`,
        destination: cargoProject,
        name: 'F Prime new sequence',
        parameters: ({ destination, name }) => ({ project: destination, sequence: name, test: true }),
      },
      description: 'Behaviour test for an existing Rust sequence: give the sequence name (fprime-wasm test)',
      fileExtension: '.rs',
      label: 'F Prime sequence test',
      namePlaceholder: 'startup',
      validateName,
    },
  ],
};
