// node --test project-check.test.mjs  (plan() of the "F Prime project check" Action)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
globalThis.require = createRequire(import.meta.url);
const { plan, withoutGeneratedBins } = await import('./fprime-project-check.js');

const bin = n => `[[bin]]\nname = "${n}"\nrequired-features = ["wasm"]\ntest = false\nbench = false\n\n`;
const cargo = '[package]\nname = "rust"\n\n[lib]\ntest = false\n\n';
const reference = {
  'Cargo.toml': cargo, 'build.rs': 'generate("dictionary/D.json")', 'README.md': 'readme', 'src/lib.rs': 'lib',
  'profile_restrict.toml': 'p', 'src/bin/startup.rs': 'seq',
};
const run = (current, metadata = {}) => Object.fromEntries(plan({
  current, dictionaryPath: 'dictionary/D.json', metadata: rel => metadata[rel] ?? {}, parcelDictionary: 'NEW',
  reference, sequences: new Set(['a']),
}).map(r => [r.rel, r]));

test('generated files are marked, edited ones are left alone', () => {
  const rows = run({
    'Cargo.toml': cargo + bin('a') + bin('gone'), 'build.rs': reference['build.rs'], 'README.md': 'edited',
    'src/lib.rs': 'lib', 'profile_restrict.toml': 'p', 'dictionary/D.json': 'OLD', 'notes.md': 'x',
  }, { 'src/lib.rs': { user: { managedBy: 'fprime-wasm' } } });
  assert.deepEqual(rows['Cargo.toml'].changes, { content: cargo, managed: true, readOnly: true });
  assert.match(rows['Cargo.toml'].finding, /stale, no src\/bin source: gone/);
  assert.deepEqual(rows['build.rs'].changes, { managed: true, readOnly: true });
  assert.deepEqual(rows['README.md'].changes, {}); // edited: stays ordinary
  assert.deepEqual(rows['src/lib.rs'].changes, {}); // already managed
  assert.deepEqual(rows['profile_restrict.toml'].changes, { managed: true }); // editable
  assert.deepEqual(rows['dictionary/D.json'].changes, { content: 'NEW', managed: true, readOnly: true });
  assert.equal(rows['notes.md'], undefined); // not generated: not considered
});

test('a hand-edited Cargo.toml loses only generated [[bin]] entries and is not marked', () => {
  const custom = '[[bin]]\nname = "x"\npath = "src/x.rs"\n';
  const rows = run({ 'Cargo.toml': cargo + '[dependencies]\nfoo = "1"\n' + bin('a') + custom });
  assert.equal(rows['Cargo.toml'].changes.managed, undefined);
  assert.ok(rows['Cargo.toml'].changes.content.includes(custom));
  assert.deepEqual(withoutGeneratedBins(bin('a') + custom).names, ['a']);
});
