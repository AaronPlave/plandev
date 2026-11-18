"""Unit tests for server.py; run inside the toolchain image as root (see run.sh)."""
import os
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
import server  # noqa: E402

TREE = [
    {'name': 'seqs', 'type': 'DIRECTORY', 'contents': [
        {'name': 'Cargo.toml', 'type': 'TEXT', 'metadata': {'lastEditedAt': '2026-11-17T10:00:00Z'}},
        {'name': 'src', 'type': 'DIRECTORY', 'contents': [
            {'name': 'bin', 'type': 'DIRECTORY', 'contents': [
                {'name': 'a.rs', 'type': 'SEQUENCE', 'metadata': {'lastEditedAt': '2026-11-17T10:00:01Z'}}]}]},
        {'name': 'target', 'type': 'DIRECTORY', 'contents': [{'name': 'junk', 'type': 'BINARY'}]},
        {'name': 'out', 'type': 'DIRECTORY', 'contents': [{'name': 'a.wasm', 'type': 'BINARY'}]},
    ]},
    {'name': 'loose.rs', 'type': 'SEQUENCE'},
]


class Projects(unittest.TestCase):
    def test_finds_the_nearest_cargo_project(self):
        self.assertEqual(server.find_cargo_project(TREE, 'seqs/src/bin/a.rs'), 'seqs')
        self.assertIsNone(server.find_cargo_project(TREE, 'loose.rs'))

    def test_lists_inputs_only(self):
        self.assertEqual(server.project_files(TREE, 'seqs'),
                         {'Cargo.toml': '2026-11-17T10:00:00Z', 'src/bin/a.rs': '2026-11-17T10:00:01Z'})

    def test_file_count_limit(self):
        old, server.MAX_PROJECT_FILES = server.MAX_PROJECT_FILES, 1
        try:
            with self.assertRaises(server.Refused) as e:
                server.project_files(TREE, 'seqs')
            self.assertEqual(e.exception.code, 4413)
        finally:
            server.MAX_PROJECT_FILES = old

    def test_changed_files(self):
        snapshot = {'Cargo.toml': '2026-11-17T10:00:00Z', 'src/a.rs': '2026-11-17T10:00:00Z', 'gone.rs': 'x'}
        remote = {'Cargo.toml': '2026-11-17T10:00:05Z', 'src/a.rs': '2026-11-17T10:00:00Z', 'new.rs': 'y',
                  'open.rs': '2026-11-17T10:00:09Z'}
        changed, removed = server.changed_files(snapshot, remote, '2026-11-17T10:00:03Z', keep={'open.rs'})
        self.assertEqual(sorted(changed), ['Cargo.toml', 'new.rs'])
        self.assertEqual(removed, ['gone.rs'])
        # Same-second edits are not trusted: lastEditedAt has one-second resolution.
        changed, _ = server.changed_files(snapshot, remote, '2026-11-17T10:00:00Z', keep=set())
        self.assertIn('src/a.rs', changed)

    def test_lsp_incremental_changes(self):
        text = 'fn main() {\n    a();\n}\n'
        text = server.apply_change(text, {'range': {'start': {'line': 1, 'character': 4},
                                                    'end': {'line': 1, 'character': 5}}, 'text': 'é'})
        self.assertEqual(text, 'fn main() {\n    é();\n}\n')
        self.assertEqual(server.apply_change(text, {'text': 'x'}), 'x')

    def test_credentials_carry_the_active_role(self):
        import base64
        import json
        import urllib.parse
        user = urllib.parse.quote(base64.b64encode(json.dumps({'token': 't0k'}).encode()).decode())
        self.assertEqual(server.credentials_from_headers({'Cookie': f'a=1; user={user}; activeRole=viewer'}), ('t0k', 'viewer'))
        self.assertEqual(server.credentials_from_headers({'Cookie': f'user={user}; activeRole=deleted'}), ('t0k', None))
        self.assertEqual(server.credentials_from_headers({'Authorization': 'Bearer x', 'x-hasura-role': 'user'}), ('x', 'user'))
        with self.assertRaises(server.Refused):
            server.credentials_from_headers({'Cookie': 'other=1'})

    def test_username_from_token(self):
        import base64
        import json
        payload = base64.urlsafe_b64encode(json.dumps({'username': 'ann'}).encode()).decode().rstrip('=')
        self.assertEqual(server.username_of(f'h.{payload}.s'), 'ann')


class Files(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()

    def test_rejects_escaping_paths(self):
        for bad in ('../x', '/etc/passwd', 'a/../../x', 'a//b', ''):
            with self.assertRaises(server.Refused):
                server.write_file(self.root, bad, b'x')

    def test_never_follows_symlinks(self):
        os.symlink('/etc', os.path.join(self.root, 'link'))
        os.symlink('/etc/passwd', os.path.join(self.root, 'file'))
        with self.assertRaises(OSError):
            server.write_file(self.root, 'link/evil', b'x')
        with self.assertRaises(OSError):
            server.write_file(self.root, 'file', b'x')
        with self.assertRaises(OSError):
            server.read_file(self.root, 'file')

    def test_owner_and_mode(self):
        server.write_file(self.root, 'a/b/c.rs', b'fn', uid=20001)
        server.write_file(self.root, '.cargo/wasm-link', b'#!/bin/sh', uid=20001)
        st = os.stat(os.path.join(self.root, 'a/b/c.rs'))
        self.assertEqual((st.st_uid, st.st_mode & 0o777), (20001, 0o600))
        self.assertEqual(os.stat(os.path.join(self.root, 'a/b')).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(os.path.join(self.root, '.cargo/wasm-link')).st_mode & 0o777, 0o700)


class Sandbox(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.chown(self.home, 20002, 20002)
        server.sandbox_dirs(self.home, 20002)

    def run_py(self, code, **kw):
        return server.run_sandboxed([sys.executable, '-c', code], 20002, self.home, self.home, **kw)

    def test_runs_as_the_user_without_network(self):
        r = self.run_py('import os, socket\nprint(os.getuid(), oct(os.umask(0)))\n'
                        'try:\n socket.socket(); print("net")\nexcept OSError as e: print("blocked", e.errno)\n'
                        's = socket.socket(socket.AF_UNIX); print("unix ok")')
        self.assertEqual(r.stdout.split('\n')[:3], ['20002 0o77', 'blocked 13', 'unix ok'])

    def test_cannot_read_another_users_files(self):
        other = tempfile.mkdtemp()
        server.write_file(other, 'secret', b's', uid=20003)
        os.chmod(other, 0o755)
        r = self.run_py(f'open({os.path.join(other, "secret")!r}).read()')
        self.assertIn('PermissionError', r.stderr)

    def test_timeout_kills_everything_it_started(self):
        start = time.monotonic()
        with self.assertRaises(subprocess.TimeoutExpired):
            self.run_py('import subprocess, time\nsubprocess.Popen(["sleep", "300"])\ntime.sleep(300)', timeout=1)
        self.assertLess(time.monotonic() - start, 10)
        time.sleep(0.2)
        # Killed processes may linger as zombies until init reaps them; none may still be running.
        ps = subprocess.run(['ps', '-o', 'stat=', '-u', '20002'], capture_output=True, text=True).stdout.split()
        self.assertTrue(all(state.startswith('Z') for state in ps), ps)


class Capacity(unittest.TestCase):
    def tearDown(self):
        server.SESSIONS_STATE.clear()

    def test_global_and_per_user_limits(self):
        old = server.MAX_SESSIONS, server.MAX_SESSIONS_PER_USER
        server.MAX_SESSIONS, server.MAX_SESSIONS_PER_USER = 3, 2
        try:
            server.claim_session('1', 'ann')
            server.claim_session('2', 'ann')
            with self.assertRaises(server.Refused) as e:
                server.claim_session('3', 'ann')
            self.assertEqual(e.exception.code, 4429)
            server.claim_session('3', 'bob')
            with self.assertRaises(server.Refused):
                server.claim_session('4', 'cat')
        finally:
            server.MAX_SESSIONS, server.MAX_SESSIONS_PER_USER = old


TEST_OUTPUT = """\
     Running `cargo test --test alpha`
   Compiling proj v0.1.0 (/w)
     Running unittests src/lib.rs (target/debug/deps/proj-1)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/alpha.rs (target/debug/deps/alpha-1)

running 1 test
test runs_to_completion ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running tests/beta.rs (target/debug/deps/beta-1)

running 2 tests
test runs_to_completion ... FAILED
test skipped_one ... ignored

failures:

---- runs_to_completion stdout ----

thread 'runs_to_completion' (10641) panicked at tests/beta.rs:6:1:
sequence `beta`: step missing
step 1 of 1 never happened

note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace


failures:
    runs_to_completion

test result: FAILED. 0 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s
"""


class Tests(unittest.TestCase):
    def test_parses_results_per_target_with_failure_output(self):
        tests = server.parse_tests(TEST_OUTPUT)
        self.assertEqual([(t['target'], t['name'], t['status']) for t in tests], [
            ('alpha', 'runs_to_completion', 'passed'),
            ('beta', 'runs_to_completion', 'failed'),
            ('beta', 'skipped_one', 'ignored')])
        self.assertTrue(tests[1]['output'].startswith("thread 'runs_to_completion'"))
        self.assertIn('step 1 of 1 never happened', tests[1]['output'])
        self.assertNotIn('RUST_BACKTRACE', tests[1]['output'])
        self.assertEqual(tests[0]['output'], '')

    def test_refuses_option_injection(self):
        for body in ({'filter': '--nocapture'}, {'filter': 'a b'}, {'filter': '-q'}):
            with self.assertRaises(server.Refused):
                server.run_tests('/nonexistent', body, 0, '/nonexistent', None)


class Scaffold(unittest.TestCase):
    def test_leaves_the_new_sequence_undeclared(self):
        manifest = ('[package]\nname = "s"\n\n[[bin]]\nname = "old"\nrequired-features = ["wasm"]\ntest = false\n'
                    'bench = false\n\n[[bin]]\nname = "new"\nrequired-features = ["wasm"]\ntest = false\nbench = false\n\n'
                    '[profile.release]\nlto = true\n')
        out = server.without_generated_bin(manifest, 'new')
        self.assertNotIn('name = "new"', out)
        self.assertIn('name = "old"', out)  # existing declarations are the project's business
        self.assertIn('[profile.release]', out)
        custom = '[[bin]]\nname = "new"\npath = "x.rs"\n'
        self.assertEqual(server.without_generated_bin(custom, 'new'), custom)


class ExternalSources(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        os.makedirs(f'{self.home}/ra-target/out')
        with open(f'{self.home}/ra-target/out/dictionary.rs', 'w') as f:
            f.write('pub mod Ref {}')
        os.symlink('/etc/passwd', f'{self.home}/ra-target/out/evil.rs')
        self.session = server.LspSession.__new__(server.LspSession)
        self.session.home = self.home

    def read(self, path):
        return self.session.read_source({'id': 1, 'params': {'uri': f'file://{path}'}})

    def test_reads_generated_and_vendored_sources(self):
        self.assertEqual(self.read(f'{self.home}/ra-target/out/dictionary.rs')['result']['text'], 'pub mod Ref {}')
        vendored = next(f for f in os.listdir('/opt/fprime/vendor') if f.startswith('fprime_core'))
        self.assertIn('result', self.read(f'/opt/fprime/vendor/{vendored}/src/lib.rs'))

    def test_refuses_anything_else(self):
        for path in ('/etc/passwd', f'{self.home}/ra-target/out/evil.rs', f'{self.home}/ra-target/../x',
                     f'{self.home}/cargo/credentials', '/opt/fprime/server.py'):
            self.assertIn('error', self.read(path), path)


if __name__ == '__main__':
    unittest.main()
