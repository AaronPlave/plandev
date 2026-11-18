// node --test  (readCargoProject: builds and tests use the project's dictionary copy, refused when it differs)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
globalThis.require = createRequire(import.meta.url);
const { readCargoProject } = await import('./project.js');

const file = name => ({ name, type: 'FILE' });
const dir = (name, contents) => ({ contents, name, type: 'DIRECTORY' });
const tree = [dir('rust', [file('Cargo.toml'), file('build.rs'), dir('dictionary', [file('D.json')]), dir('src', [dir('bin', [file('a.rs')])])])];
const api = files => ({ listFiles: async () => JSON.stringify(tree), readFile: async p => files[p] });
const base = { 'rust/Cargo.toml': '[package]\nname = "rust"\n', 'rust/build.rs': 'fprime_build::generate("dictionary/D.json")', 'rust/src/bin/a.rs': 'fn main(){}' };
const parcel = { info: { mission: 'M', sha256: 'x', version: '1' }, text: 'NEW' };

test('a matching copy is sent unchanged', async () => {
  const p = await readCargoProject(api({ ...base, 'rust/dictionary/D.json': 'NEW' }), 'rust/src/bin/a.rs', parcel);
  assert.equal(p.dictionaryProblem, null);
  assert.equal(Buffer.from(p.files['dictionary/D.json'], 'base64').toString(), 'NEW');
});

test('a stale copy is refused, not replaced', async () => {
  const p = await readCargoProject(api({ ...base, 'rust/dictionary/D.json': 'OLD' }), 'rust/src/bin/a.rs', parcel);
  assert.match(p.dictionaryProblem, /differs from the parcel dictionary.*F Prime project check/s);
  assert.equal(Buffer.from(p.files['dictionary/D.json'], 'base64').toString(), 'OLD');
});

test('old [[bin]] entries are pointed out', async () => {
  const cargo = base['rust/Cargo.toml'] + '[[bin]]\nname = "a"\nrequired-features = ["wasm"]\ntest = false\nbench = false\n';
  const p = await readCargoProject(api({ ...base, 'rust/Cargo.toml': cargo, 'rust/dictionary/D.json': 'NEW' }), 'rust/src/bin/a.rs', parcel);
  assert.match(p.notes[0], /\[\[bin\]\]` a.*project check/);
});
