"""
F Prime sequencing toolchain service for SeqDev (optional; see ../README.md).

Runs rust-analyzer, cargo, fprime-wasm and fprime-seqgen in its own container, never in a PlanDev
service process: Rust builds execute project code (build scripts, proc macros).

  ws://:9257/lsp?workspaceId=<id>&path=<file>   rust-analyzer for the Cargo project holding <file>.
      Auth: the SeqDev `user` cookie or an Authorization header. The project is read from the
      workspace service with that token, so workspace permissions decide access.
  POST http://:9258/build                       build/verify sources sent by the F Prime compile
      Action, authorized with the requesting user's token. Internal port: not for browsers.
  POST http://:9258/scaffold                    `fprime-wasm init`/`add` for the "F Prime new
      sequence" Action: new project or new sequence in a project, with a restriction profile.
  GET  http://:9258/status                      toolchain versions, sessions, memory.

Isolation: every PlanDev user gets their own Unix uid inside the container. Their sessions,
builds and caches are private to that uid (mode 0700, umask 077), their processes cannot open
network sockets (seccomp), and are limited in count and lifetime. Files the service writes into or
reads from a user's directories are opened without following symlinks.
"""
import asyncio
import base64
import errno
import hashlib
import json
import os
import re
import resource
import select
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def env_int(name, default):
    return int(os.environ.get(name, default))


WORKSPACE_URL = os.environ.get('WORKSPACE_URL', 'http://plandev_workspace:28000').rstrip('/')
SESSIONS = os.environ.get('FPRIME_SESSIONS_DIR', '/sessions')
USERS = os.environ.get('FPRIME_USERS_DIR', '/cache/users')
# rust-analyzer holds ~0.9 GB per session on an fprime-wasm project (measured), so 5 fit the default 6 GB.
MAX_SESSIONS = env_int('FPRIME_MAX_SESSIONS', 5)
MAX_SESSIONS_PER_USER = env_int('FPRIME_MAX_SESSIONS_PER_USER', 3)
IDLE_SECONDS = env_int('FPRIME_IDLE_SECONDS', 900)
RESYNC_SECONDS = env_int('FPRIME_RESYNC_SECONDS', 10)
MAX_BUILDS = env_int('FPRIME_MAX_BUILDS', 2)
BUILD_TIMEOUT = env_int('FPRIME_BUILD_TIMEOUT_SECONDS', 600)
MAX_PROJECT_FILES = env_int('FPRIME_MAX_PROJECT_FILES', 2000)
MAX_PROJECT_BYTES = env_int('FPRIME_MAX_PROJECT_BYTES', 32 * 1024 * 1024)
# Threads count too (rust-analyzer and rustc are heavily threaded).
USER_MAX_PROCESSES = env_int('FPRIME_USER_MAX_PROCESSES', 2048)
# Per process heap/private memory (RLIMIT_DATA); 0 = only the container's memory limit applies.
PROCESS_MAX_DATA_BYTES = env_int('FPRIME_PROCESS_MAX_DATA_BYTES', 0)
MAX_FILE_BYTES = env_int('FPRIME_MAX_FILE_BYTES', 512 * 1024 * 1024)
# Per-user build caches (~0.4 GB each) unused this long are deleted at startup.
CACHE_DAYS = env_int('FPRIME_CACHE_DAYS', 14)
FIRST_UID = 20000
SKIP_DIRS = {'target', 'out'}  # build output: never inputs


class Refused(Exception):
    """A request the service turns down; `code` is the WebSocket close code / HTTP status basis."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


# ─── Toolchain identity ────────────────────────────────────────────────────────────────────
def toolchain_versions():
    def v(*cmd):
        try:
            return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.strip().splitlines()[0]
        except Exception as e:  # noqa: BLE001
            return f'unavailable: {e}'
    # A list, not a map: workspace metadata keys may not contain '.'.
    patches = []
    for name in filter(None, os.environ.get('FPRIME_TOOLCHAIN_PATCHES', '').split(',')):
        try:
            patches.append({'name': name, 'sha256': hashlib.sha256(open(f'/opt/fprime/patches/{name}', 'rb').read()).hexdigest()})
        except OSError as e:
            patches.append({'name': name, 'error': str(e)})
    return {'rustc': v('rustc', '--version'), 'fprime-wasm': v('fprime-wasm', '--version'),
            'wasm-opt': v('wasm-opt', '--version'),
            'fprime-gds': v('python3', '-c', 'import importlib.metadata as m; print(m.version("fprime-gds"))'),
            'patches': patches}


TOOLCHAIN = None


# ─── Workspace access ──────────────────────────────────────────────────────────────────────
def credentials_from_headers(headers):
    """(token, active role). The role is the one the user has active in SeqDev, so workspace access
    is checked as SeqDev checks it, not as the token's (often broader) default role."""
    role = headers.get('x-hasura-role')
    auth = headers.get('Authorization') or ''
    if auth.lower().startswith('bearer '):
        return auth[7:], role
    cookies = dict(part.strip().partition('=')[::2] for part in (headers.get('Cookie') or '').split(';') if '=' in part)
    if 'user' not in cookies:
        raise Refused(4401, 'no SeqDev credentials (user cookie or Authorization header)')
    try:
        token = json.loads(base64.b64decode(urllib.parse.unquote(cookies['user']) + '==='))['token']
    except (ValueError, KeyError) as e:
        raise Refused(4401, 'unreadable SeqDev credentials') from e
    active = urllib.parse.unquote(cookies.get('activeRole', ''))
    return token, role or (active if active and active != 'deleted' else None)


def username_of(token):
    """The token's user. Only call after the workspace service has accepted the token."""
    payload = token.split('.')[1]
    return json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))['username']


def workspace_get(credentials, workspace_id, path='', query=''):
    token, role = credentials
    url = f'{WORKSPACE_URL}/ws/{int(workspace_id)}/{urllib.parse.quote(path)}{query}'
    headers = {'Authorization': f'Bearer {token}', **({'x-hasura-role': role} if role else {})}
    try:
        return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60).read()
    except urllib.error.HTTPError as e:
        if e.code == 401:
            raise Refused(4401, 'SeqDev credentials rejected (expired?)') from e
        if e.code in (403, 404):
            raise Refused(4403, f'no access to workspace {workspace_id}') from e
        raise


def workspace_tree(credentials, workspace_id):
    return json.loads(workspace_get(credentials, workspace_id, '', '?withMetadata=true'))


def find_cargo_project(tree, file_path):
    """Nearest ancestor directory of file_path containing a Cargo.toml, from the workspace tree."""
    parts = [p for p in file_path.strip('/').split('/') if p]
    for depth in range(len(parts) - 1, -1, -1):
        node = tree
        for name in parts[:depth]:
            node = next((c.get('contents', []) for c in node if c['name'] == name and c['type'] == 'DIRECTORY'), None)
            if node is None:
                break
        if node is not None and any(c['name'] == 'Cargo.toml' and c['type'] != 'DIRECTORY' for c in node):
            return '/'.join(parts[:depth])
    return None


def project_files(tree, project):
    """{relative path: lastEditedAt} for the project's files, within the size/count limits."""
    node = tree
    for name in [p for p in project.split('/') if p]:
        node = next(c.get('contents', []) for c in node if c['name'] == name and c['type'] == 'DIRECTORY')
    out = {}

    def walk(children, rel):
        for c in children:
            if c['type'] == 'DIRECTORY':
                if c['name'] not in SKIP_DIRS:
                    walk(c.get('contents', []), f'{rel}{c["name"]}/')
            else:
                out[f'{rel}{c["name"]}'] = (c.get('metadata') or {}).get('lastEditedAt')
    walk(node, '')
    if len(out) > MAX_PROJECT_FILES:
        raise Refused(4413, f'project has {len(out)} files; the limit is {MAX_PROJECT_FILES}')
    return out


def fetch_files(credentials, workspace_id, project, rels):
    files, total = {}, 0
    for rel in rels:
        files[rel] = workspace_get(credentials, workspace_id, f'{project}/{rel}' if project else rel)
        total += len(files[rel])
        if total > MAX_PROJECT_BYTES:
            raise Refused(4413, f'project is larger than {MAX_PROJECT_BYTES} bytes')
    return files


# ─── Files in user-owned directories ───────────────────────────────────────────────────────
def check_relpath(rel):
    parts = rel.split('/')
    if not rel or rel.startswith('/') or any(p in ('', '.', '..') for p in parts):
        raise Refused(4400, f'invalid path: {rel!r}')
    return parts


@contextmanager
def dir_fd(root, rel_dir_parts, create=False, uid=None):
    """An fd for root/<parts>, walking without following symlinks (and creating dirs as uid)."""
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in rel_dir_parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                    if uid is not None:
                        os.chown(part, uid, uid, dir_fd=fd, follow_symlinks=False)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def write_file(root, rel, data, uid=None):
    parts = check_relpath(rel)
    # The workspace service does not keep the executable bit; fprime-wasm projects need this one.
    mode = 0o700 if rel == '.cargo/wasm-link' else 0o600
    with dir_fd(root, parts[:-1], create=True, uid=uid) as d:
        fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode, dir_fd=d)
        if uid is not None:
            os.fchown(fd, uid, uid)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)


def read_file(root, rel):
    parts = check_relpath(rel)
    with dir_fd(root, parts[:-1]) as d:
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=d)
        with os.fdopen(fd, 'rb') as f:
            return f.read(MAX_PROJECT_BYTES + 1)


def delete_file(root, rel):
    parts = check_relpath(rel)
    with dir_fd(root, parts[:-1]) as d:
        os.unlink(parts[-1], dir_fd=d)


def materialize(root, files, uid):
    """Write {relpath: bytes} under root (a fresh dir only the service can write yet), owned by uid."""
    for rel, data in files.items():
        write_file(root, rel, data, uid)


# ─── Users, sandboxing, limits ─────────────────────────────────────────────────────────────
class Users:
    """PlanDev user → private uid and home (caches), plus what each user is running."""

    def __init__(self):
        self.lock = threading.Lock()
        self.uids, self.active = {}, {}

    def home(self, username):
        return f'{USERS}/{hashlib.sha256(username.encode()).hexdigest()[:24]}'

    def enter(self, username):
        with self.lock:
            if username not in self.uids:
                uid = FIRST_UID + len(self.uids)
                home = self.home(username)
                os.makedirs(home, mode=0o700, exist_ok=True)
                # Caches outlive the service; uids don't. Re-own this user's caches for this run.
                for dirpath, dirnames, filenames in os.walk(home):
                    for name in dirnames + filenames:
                        os.lchown(os.path.join(dirpath, name), uid, uid)
                os.chown(home, uid, uid)
                os.chmod(home, 0o700)
                self.uids[username] = uid
            os.utime(self.home(username))  # last use, for cache eviction
            self.active[username] = self.active.get(username, 0) + 1
            return self.uids[username], self.home(username)

    def leave(self, username):
        with self.lock:
            self.active[username] -= 1
            idle = self.active[username] == 0
        if idle:
            kill_uid(self.uids[username])  # anything a build script left running


USERS_STATE = Users()


def kill_uid(uid):
    for pid in os.listdir('/proc'):
        if pid.isdigit():
            try:
                if os.stat(f'/proc/{pid}').st_uid == uid:
                    os.kill(int(pid), signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError):
                pass


def uid_rss_mb(uid):
    total = 0
    for pid in os.listdir('/proc'):
        if pid.isdigit():
            try:
                if os.stat(f'/proc/{pid}').st_uid == uid:
                    with open(f'/proc/{pid}/status') as f:
                        total += next((int(l.split()[1]) for l in f if l.startswith('VmRSS:')), 0)
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                pass
    return round(total / 1024)


def sandbox():
    """Runs in each user process after the uid switch, before exec."""
    os.umask(0o077)
    resource.setrlimit(resource.RLIMIT_NPROC, (USER_MAX_PROCESSES, USER_MAX_PROCESSES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE_BYTES, MAX_FILE_BYTES))
    if PROCESS_MAX_DATA_BYTES:
        resource.setrlimit(resource.RLIMIT_DATA, (PROCESS_MAX_DATA_BYTES, PROCESS_MAX_DATA_BYTES))
    import seccomp  # Debian python3-seccomp
    f = seccomp.SyscallFilter(seccomp.ALLOW)
    for family in (socket.AF_INET, socket.AF_INET6, socket.AF_NETLINK, socket.AF_PACKET):
        f.add_rule(seccomp.ERRNO(errno.EACCES), 'socket', seccomp.Arg(0, seccomp.EQ, family))
    for call in ('io_uring_setup', 'ptrace', 'process_vm_readv', 'process_vm_writev'):
        f.add_rule(seccomp.ERRNO(errno.EPERM), call)
    f.load()  # also sets no_new_privs


def sandbox_env(home):
    return {'PATH': os.environ['PATH'], 'HOME': home, 'CARGO_HOME': f'{home}/cargo',
            'RUSTUP_HOME': os.environ.get('RUSTUP_HOME', '/usr/local/rustup'), 'TMPDIR': f'{home}/tmp',
            'CARGO_NET_OFFLINE': 'true', 'LANG': 'C.UTF-8'}


def sandbox_dirs(home, uid):
    for sub in ('cargo', 'tmp'):
        with dir_fd(home, [sub], create=True, uid=uid):
            pass


def spawn_kwargs(uid, home, cwd):
    return {'cwd': cwd, 'env': sandbox_env(home), 'user': uid, 'group': uid, 'extra_groups': [],
            'preexec_fn': sandbox, 'start_new_session': True}


def kill_group(proc):
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


# ─── rust-analyzer sessions ────────────────────────────────────────────────────────────────
SESSIONS_STATE = {}  # id → {'user', 'uid', 'started', 'last'}
SESSIONS_LOCK = threading.Lock()


def claim_session(session_id, username):
    with SESSIONS_LOCK:
        if len(SESSIONS_STATE) >= MAX_SESSIONS:
            raise Refused(4429, f'all {MAX_SESSIONS} Rust language server sessions are in use')
        if sum(s['user'] == username for s in SESSIONS_STATE.values()) >= MAX_SESSIONS_PER_USER:
            raise Refused(4429, f'you already have {MAX_SESSIONS_PER_USER} Rust project(s) open; close one')
        SESSIONS_STATE[session_id] = {'user': username, 'started': time.time(), 'last': time.time()}


def ra_options(home):
    """rust-analyzer settings from fprime-wasm's scaffolded .vscode/settings.json, plus the target
    and features `fprime-wasm build` uses, with this user's own target directory."""
    return {
        'cargo': {'features': ['wasm'], 'target': 'wasm32v1-none', 'allTargets': False, 'targetDir': f'{home}/ra-target'},
        'procMacro': {'enable': True},
        'check': {'allTargets': False},
        'completion': {
            'autoimport': {'enable': False}, 'autoself': {'enable': False}, 'postfix': {'enable': False},
            'callable': {'snippets': 'fill_arguments'}, 'addColonsToModule': False,
            'excludeTraits': ['core::convert::TryInto', 'core::convert::Into', 'core::any::Any',
                              'core::cmp::PartialEq', 'core::clone::Clone', 'core::convert::From',
                              'core::convert::TryFrom'],
        },
    }


def apply_change(text, change):
    """Apply one LSP content change (full or ranged; positions in UTF-16 code units)."""
    if 'range' not in change:
        return change['text']

    def offset(pos):
        lines = text.split('\n')
        before = sum(len(l) + 1 for l in lines[:pos['line']])
        line = lines[pos['line']] if pos['line'] < len(lines) else ''
        units = line.encode('utf-16-le')[:pos['character'] * 2].decode('utf-16-le', errors='ignore')
        return before + len(units)
    r = change['range']
    return text[:offset(r['start'])] + change['text'] + text[offset(r['end']):]


def changed_files(snapshot, remote, uncertain_since, keep):
    """What to refetch/delete so the session copy matches the workspace again. lastEditedAt has
    one-second resolution, so files edited at or after the last sync's second are refetched too.
    Files open in this session (`keep`) are the user's own unsaved text and are left alone."""
    changed = [rel for rel, at in remote.items()
               if rel not in keep and (rel not in snapshot or snapshot[rel] != at or (at or '') >= uncertain_since)]
    removed = [rel for rel in snapshot if rel not in remote and rel not in keep]
    return changed, removed


def utc_second(t):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t))


class LspSession:
    def __init__(self, websocket, credentials, workspace_id, project, username):
        self.ws, self.credentials, self.workspace_id, self.project, self.username = (
            websocket, credentials, workspace_id, project, username)
        self.id = os.urandom(8).hex()
        self.dir = f'{SESSIONS}/{self.id}'
        self.client_root = f'file:///seqdev/{workspace_id}/{project}'.rstrip('/')
        self.server_root = f'file://{self.dir}'
        self.documents, self.snapshot = {}, {}
        self.synced_at, self.last_resync, self.last_message = 0.0, 0.0, time.monotonic()
        self.flycheck_timer, self.resync_task, self.proc, self.closed = None, None, None, False

    # files
    def rel(self, uri):
        return uri[len(self.server_root) + 1:] if uri.startswith(self.server_root + '/') else None

    async def load(self, tree):
        files = project_files(tree, self.project)
        started = time.time()
        data = await asyncio.to_thread(fetch_files, self.credentials, self.workspace_id, self.project, list(files))
        os.mkdir(self.dir, 0o700)
        materialize(self.dir, data, self.uid)
        os.chown(self.dir, self.uid, self.uid)
        self.snapshot, self.synced_at = files, started

    async def resync(self):
        """Bring the copy up to date with the workspace (other users' saves, Cargo.toml, profiles,
        dictionary), and re-check access with the user's token while at it."""
        started = time.time()
        tree = await asyncio.to_thread(workspace_tree, self.credentials, self.workspace_id)
        if find_cargo_project(tree, f'{self.project}/Cargo.toml'.lstrip('/')) != self.project:
            raise Refused(4404, 'the Cargo project was removed or moved')
        remote = project_files(tree, self.project)
        keep = {self.rel(uri) for uri in self.documents}
        changed, removed = changed_files(self.snapshot, remote, utc_second(self.synced_at - 2), keep)
        data = await asyncio.to_thread(fetch_files, self.credentials, self.workspace_id, self.project, changed) if changed else {}
        events = []
        for rel, content in data.items():
            try:
                if read_file(self.dir, rel) == content:
                    continue
            except FileNotFoundError:
                pass
            write_file(self.dir, rel, content, self.uid)
            events.append({'uri': f'{self.server_root}/{rel}', 'type': 2 if rel in self.snapshot else 1})
        for rel in removed:
            try:
                delete_file(self.dir, rel)
            except FileNotFoundError:
                pass
            events.append({'uri': f'{self.server_root}/{rel}', 'type': 3})
        self.snapshot = {**remote, **{rel: self.snapshot.get(rel) for rel in keep if rel in self.snapshot}}
        self.synced_at = started
        if events:
            print(f'lsp {self.id}: resynced {len(events)} file(s)', flush=True)
            self.send({'jsonrpc': '2.0', 'method': 'workspace/didChangeWatchedFiles', 'params': {'changes': events}})
            if self.documents:
                self.schedule_flycheck(next(iter(self.documents)))

    def request_resync(self, force=False):
        now = time.monotonic()
        if (self.resync_task and not self.resync_task.done()) or (not force and now - self.last_resync < RESYNC_SECONDS):
            return
        self.last_resync = now

        async def run():
            try:
                await self.resync()
            except Refused as e:
                print(f'lsp {self.id}: closing ({e.code}): {e}', flush=True)
                await self.ws.close(e.code, str(e)[:120])
            except Exception as e:  # noqa: BLE001  (workspace briefly unreachable: try again later)
                print(f'lsp {self.id}: resync failed: {e}', flush=True)
        self.resync_task = asyncio.ensure_future(run())

    # rust-analyzer
    def send(self, data):
        body = json.dumps(data).encode()
        self.proc.stdin.write(b'Content-Length: %d\r\n\r\n' % len(body) + body)

    def mirror(self, uri):
        """rust-analyzer's flycheck (`cargo check`: where profile errors come from) reads the disk,
        so open documents are written to the session copy."""
        rel = self.rel(uri)
        if self.closed or rel is None or uri not in self.documents:
            return
        write_file(self.dir, rel, self.documents[uri].encode(), self.uid)
        self.send({'jsonrpc': '2.0', 'method': 'textDocument/didSave', 'params': {'textDocument': {'uri': uri}}})

    def schedule_flycheck(self, uri):
        if self.flycheck_timer:
            self.flycheck_timer.cancel()
        self.flycheck_timer = asyncio.get_running_loop().call_later(1.0, self.mirror, uri)

    def track(self, data):
        method, params = data.get('method'), data.get('params') or {}
        uri = (params.get('textDocument') or {}).get('uri', '')
        if self.rel(uri) is None:
            return
        if method == 'textDocument/didOpen':
            self.documents[uri] = params['textDocument']['text']
            self.request_resync(force=True)
        elif method == 'textDocument/didChange' and uri in self.documents:
            for change in params['contentChanges']:
                self.documents[uri] = apply_change(self.documents[uri], change)
            self.request_resync()
        elif method == 'textDocument/didSave':
            self.request_resync(force=True)
            return
        elif method == 'textDocument/didClose':
            self.documents.pop(uri, None)
            return
        else:
            return
        self.schedule_flycheck(uri)

    def to_server(self, message):
        message = message.replace(self.client_root, self.server_root)
        data = json.loads(message)
        self.track(data)
        if data.get('method') == 'initialize':
            p = data['params']
            p['rootUri'] = self.server_root
            p['workspaceFolders'] = [{'uri': self.server_root, 'name': self.project or 'project'}]
            p['initializationOptions'] = ra_options(self.home)
            message = json.dumps(data)
        body = message.encode()
        return b'Content-Length: %d\r\n\r\n' % len(body) + body

    async def run(self, tree):
        self.uid, self.home = USERS_STATE.enter(self.username)
        try:
            claim_session(self.id, self.username)
            try:
                await self.load(tree)
                sandbox_dirs(self.home, self.uid)
                self.proc = await asyncio.create_subprocess_exec(
                    'rust-analyzer', stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL, **spawn_kwargs(self.uid, self.home, self.dir))
                print(f'lsp {self.id}: workspace {self.workspace_id} project "{self.project}" '
                      f'({len(self.snapshot)} files), {len(SESSIONS_STATE)} session(s)', flush=True)
                await self.pump()
            finally:
                self.closed = True
                if self.flycheck_timer:
                    self.flycheck_timer.cancel()
                if self.resync_task:
                    self.resync_task.cancel()
                with SESSIONS_LOCK:
                    SESSIONS_STATE.pop(self.id, None)
                if self.proc:
                    kill_group(self.proc)
                    await self.proc.wait()
                shutil.rmtree(self.dir, ignore_errors=True)
                print(f'lsp {self.id}: closed, {len(SESSIONS_STATE)} session(s)', flush=True)
        finally:
            USERS_STATE.leave(self.username)

    async def pump(self):
        async def client_to_server():
            async for message in self.ws:
                self.last_message = time.monotonic()
                SESSIONS_STATE[self.id]['last'] = time.time()
                self.proc.stdin.write(self.to_server(message))
                await self.proc.stdin.drain()

        async def server_to_client():
            while True:
                length = None
                while True:
                    line = await self.proc.stdout.readline()
                    if not line:
                        await self.ws.close(1011, 'rust-analyzer exited')
                        return
                    if line in (b'\r\n', b'\n'):
                        break
                    if line.lower().startswith(b'content-length:'):
                        length = int(line.split(b':')[1])
                body = (await self.proc.stdout.readexactly(length)).decode()
                await self.ws.send(body.replace(self.server_root, self.client_root))

        async def idle():
            while True:
                await asyncio.sleep(min(60, IDLE_SECONDS))
                if time.monotonic() - self.last_message > IDLE_SECONDS:
                    await self.ws.close(4408, 'idle')
                    return

        tasks = [asyncio.create_task(t()) for t in (client_to_server, server_to_client, idle)]
        try:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for t in tasks:
                t.cancel()


async def lsp(websocket):
    request = websocket.request
    if urllib.parse.urlparse(request.path).path != '/lsp':
        await websocket.close(4400, 'unknown path')
        return
    try:
        query = urllib.parse.parse_qs(urllib.parse.urlparse(request.path).query)
        workspace_id, path = int(query['workspaceId'][0]), query['path'][0].strip('/')
        check_relpath(path)
        credentials = credentials_from_headers(request.headers)
        tree = await asyncio.to_thread(workspace_tree, credentials, workspace_id)
        project = find_cargo_project(tree, path)
        if project is None:
            raise Refused(4404, f'{path} is not inside a Cargo project (no Cargo.toml above it)')
        await LspSession(websocket, credentials, workspace_id, project, username_of(credentials[0])).run(tree)
    except Refused as e:
        print(f'lsp: refused ({e.code}): {e}', flush=True)
        await websocket.close(e.code, str(e)[:120])
    except (KeyError, ValueError) as e:
        await websocket.close(4400, f'bad request: {e}'[:120])


# ─── Builds ────────────────────────────────────────────────────────────────────────────────
SEQGEN_LOCATION = re.compile(r'^(?:Parsing error: )?(?P<file>/\S+?):(?P<line>\d+)(?::(?P<col>\d+))?: (?P<msg>.*)$')
BUILD_SLOTS = threading.BoundedSemaphore(MAX_BUILDS)


class Cancelled(Exception):
    pass


def run_sandboxed(cmd, uid, home, cwd, env=None, connection=None, timeout=BUILD_TIMEOUT):
    """Run cmd as uid; killed (with everything it started) on timeout or when the caller hangs up."""
    kwargs = spawn_kwargs(uid, home, cwd)
    kwargs['env'] = {**kwargs['env'], **(env or {})}
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, **kwargs)
    out = {}
    readers = [threading.Thread(target=lambda k=k: out.__setitem__(k, getattr(proc, k).read()), daemon=True)
               for k in ('stdout', 'stderr')]
    for r in readers:
        r.start()
    deadline = time.monotonic() + timeout
    try:
        while proc.poll() is None:
            if time.monotonic() > deadline:
                raise subprocess.TimeoutExpired(cmd, timeout)
            if connection is not None and select.select([connection], [], [], 0)[0] \
                    and not connection.recv(1, socket.MSG_PEEK):
                raise Cancelled()
            time.sleep(0.2)
    finally:
        kill_group(proc)
        proc.wait()
        for r in readers:
            r.join(5)
        proc.stdout.close()
        proc.stderr.close()
    return subprocess.CompletedProcess(cmd, proc.returncode, out.get('stdout', ''), out.get('stderr', ''))


def build_seq(work, target, uid, home, connection, timebase):
    out = os.path.splitext(target)[0] + '.bin'
    cmd = ['fprime-seqgen', '--dictionary', 'dictionary.json', target, out]
    if timebase is not None:
        cmd += ['--timebase', str(int(timebase))]
    run = run_sandboxed(cmd, uid, home, work, connection=connection, timeout=120)
    log = run.stdout + run.stderr
    diagnostics = []
    for line in log.splitlines():
        m = SEQGEN_LOCATION.match(line.strip())
        if m:
            diagnostics.append({'file': target, 'line': int(m['line']), 'column': int(m['col'] or 1),
                                'severity': 'error', 'message': m['msg']})
    # seqgen reports some errors (and crashes) with exit status 0 and no output file.
    try:
        artifacts = {out: read_file(work, out)} if run.returncode == 0 else {}
    except FileNotFoundError:
        artifacts = {}
    ok = run.returncode == 0 and bool(artifacts) and not diagnostics
    if not ok and not diagnostics:
        diagnostics.append({'file': target, 'line': 1, 'column': 1, 'severity': 'error',
                            'message': (log.strip() or 'fprime-seqgen produced no output')[-500:]})
    return ok, diagnostics, artifacts, log, None


def build_rust(work, target, uid, home, connection):
    """`fprime-wasm build` (profiles enforced by the macros), then `verify` (loads in spacewasm)."""
    name = os.path.splitext(os.path.basename(target))[0]
    env = {'CARGO_TARGET_DIR': f'{home}/target'}
    run = run_sandboxed(['fprime-wasm', 'build', '--', '--bin', name, '--message-format=json'],
                        uid, home, work, env, connection)
    diagnostics, rendered = [], []
    for line in run.stdout.splitlines():
        if not line.startswith('{'):
            continue
        m = json.loads(line)
        if m.get('reason') != 'compiler-message':
            continue
        d = m['message']
        rendered.append(d.get('rendered') or d['message'])
        span = next((s for s in d['spans'] if s['is_primary']), None)
        if span and not span['file_name'].startswith('/'):
            diagnostics.append({'file': span['file_name'], 'line': span['line_start'], 'column': span['column_start'],
                                'endLine': span['line_end'], 'endColumn': span['column_end'],
                                'severity': 'error' if d['level'] == 'error' else 'warning', 'message': d['message']})
        elif d['level'] == 'error':
            diagnostics.append({'file': target, 'line': 1, 'column': 1, 'severity': 'error', 'message': d['message']})
    log = '\n'.join(rendered) + run.stderr
    if run.returncode != 0 and not any(d['severity'] == 'error' for d in diagnostics):
        diagnostics.append({'file': target, 'line': 1, 'column': 1, 'severity': 'error',
                            'message': (run.stderr.strip() or 'fprime-wasm build failed')[-500:]})
    artifacts, verify, ok = {}, None, run.returncode == 0
    if ok:
        artifacts[f'{name}.wasm'] = read_file(home, f'target/wasm32v1-none/release/{name}.wasm')
        v = run_sandboxed(['fprime-wasm', 'verify', '--no-build', '--json'], uid, home, work, env, connection, 120)
        try:
            verify = json.loads(v.stdout[v.stdout.index('{'):])
            verify['modules'] = [m for m in verify['modules'] if m['path'].endswith(f'/{name}.wasm')]
        except ValueError:
            verify = {'error': (v.stdout + v.stderr)[-2000:]}
        if v.returncode != 0 or not verify.get('modules') or any(not m['passed'] for m in verify['modules']):
            ok = False
            diagnostics.append({'file': target, 'line': 1, 'column': 1, 'severity': 'error', 'stage': 'verify',
                                'message': 'fprime-wasm verify: the module does not load or does not fit sequencer.toml limits'})
    return ok, diagnostics, artifacts, log, verify


NAME = re.compile(r'^[a-z][a-z0-9_]{0,63}$')
SCAFFOLD_SKIP = ('.gitignore', '.vscode/')  # the workspace service reserves .gitignore; editor settings


def scaffold(work, body, uid, home, connection):
    """Upstream scaffolding (`fprime-wasm init` / `add`), then the requested restriction profile.
    Returns the files to write into the workspace project: new or changed ones only."""
    sequence, profile = body['sequence'], body.get('profile') or ''
    if not NAME.match(sequence) or not re.match(r'^\w*$', profile):
        raise Refused(400, 'sequence names are lowercase Rust identifiers; profiles are profile_<name>.toml names')
    before = {rel: base64.b64decode(data) for rel, data in body['files'].items()}
    project = f'{work}/project'
    os.mkdir(project, 0o700)
    os.chown(project, uid, uid)
    if before:
        if f'src/bin/{sequence}.rs' in before:
            raise Refused(409, f'src/bin/{sequence}.rs already exists')
        materialize(project, before, uid)
        cmd, cwd = ['fprime-wasm', 'add', sequence], project
    else:
        crate = body['crate']
        dictionary = os.path.basename(body['dictionaryName'])
        if not NAME.match(crate.replace('-', '_')) or not re.match(r'^[\w.-]+\.json$', dictionary):
            raise Refused(400, 'invalid crate or dictionary name')
        materialize(work, {f'input/{dictionary}': base64.b64decode(body['dictionary'])}, uid)
        cmd = ['fprime-wasm', 'init', 'project', '--name', crate, '--sequence', sequence,
               '--dictionary', f'input/{dictionary}']
        cwd = work
    run = run_sandboxed(cmd, uid, home, cwd, connection=connection, timeout=120)
    if run.returncode != 0:
        raise Refused(400, f'fprime-wasm: {(run.stderr or run.stdout).strip()[-500:]}')
    after = {}
    for dirpath, dirnames, filenames in os.walk(project):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            rel = os.path.relpath(os.path.join(dirpath, name), project)
            if not rel.startswith(SCAFFOLD_SKIP):
                after[rel] = read_file(project, rel)
    if not before:
        for name in os.listdir('/opt/fprime/profiles'):
            after[name] = open(f'/opt/fprime/profiles/{name}', 'rb').read()
    if profile and f'profile_{profile}.toml' not in after:
        raise Refused(400, f'the project has no profile_{profile}.toml')
    source = after[f'src/bin/{sequence}.rs'].decode()
    # `todo!()` is a macro, which restriction profiles reject: start from a body that builds.
    source = source.replace('    todo!()\n', '    // Commands, telemetry and parameters of the dictionary: start typing a component name.\n')
    if profile:
        source = source.replace('#[fprime_main]', f'#[fprime_main({profile})]')
    after[f'src/bin/{sequence}.rs'] = source.encode()
    return {rel: data for rel, data in after.items() if before.get(rel) != data}


class Builds(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path != '/status':
            return self._send(404, {'error': 'not found'})
        with SESSIONS_LOCK:
            sessions = [{'ageSeconds': round(time.time() - s['started']), 'idleSeconds': round(time.time() - s['last'])}
                        for s in SESSIONS_STATE.values()]
        with USERS_STATE.lock:
            memory = {f'user{i}': uid_rss_mb(uid) for i, uid in enumerate(USERS_STATE.uids.values())}
        self._send(200, {'toolchain': TOOLCHAIN, 'sessions': sessions, 'rssMbByUser': memory,
                         'limits': {'sessions': MAX_SESSIONS, 'sessionsPerUser': MAX_SESSIONS_PER_USER,
                                    'builds': MAX_BUILDS, 'idleSeconds': IDLE_SECONDS}})

    def do_POST(self):
        if self.path not in ('/build', '/scaffold'):
            return self._send(404, {'error': 'not found'})
        try:
            length = int(self.headers.get('Content-Length', 0))
            if length > MAX_PROJECT_BYTES * 2:  # base64
                raise Refused(413, 'request too large')
            body = json.loads(self.rfile.read(length))
            credentials = credentials_from_headers(self.headers)
            workspace_get(credentials, body['workspaceId'])  # valid credentials that may see this workspace
            username = username_of(credentials[0])
            if len(body['files']) > MAX_PROJECT_FILES:
                raise Refused(413, 'too many files')
            for rel in [*body['files'], *([body['target']] if self.path == '/build' else [])]:
                check_relpath(rel)
            files = {rel: base64.b64decode(data) for rel, data in body['files'].items()}
            if not BUILD_SLOTS.acquire(timeout=BUILD_TIMEOUT):
                raise Refused(429, 'the toolchain is busy; try again')
        except Refused as e:
            return self._send(e.code if e.code < 1000 else {4401: 401, 4403: 403, 4400: 400, 4413: 413}.get(e.code, 400),
                              {'error': str(e)})
        except (KeyError, ValueError, TypeError) as e:
            return self._send(400, {'error': f'bad request: {e}'})
        try:
            uid, home = USERS_STATE.enter(username)
            try:
                sandbox_dirs(home, uid)
                work = tempfile.mkdtemp(dir=SESSIONS)
                try:
                    os.chown(work, uid, uid)
                    if self.path == '/scaffold':
                        created = scaffold(work, body, uid, home, self.connection)
                        return self._send(200, {'files': {k: base64.b64encode(v).decode() for k, v in created.items()},
                                                'toolchain': TOOLCHAIN})
                    materialize(work, files, uid)
                    if body['kind'] == 'seq':
                        result = build_seq(work, body['target'], uid, home, self.connection, body.get('timebase'))
                    else:
                        result = build_rust(work, body['target'], uid, home, self.connection)
                finally:
                    shutil.rmtree(work, ignore_errors=True)
            finally:
                USERS_STATE.leave(username)
        except Cancelled:
            print('build: caller went away, cancelled', flush=True)
            return
        except Refused as e:
            return self._send(e.code if e.code < 1000 else 400, {'error': str(e)})
        except subprocess.TimeoutExpired:
            return self._send(200, {'ok': False, 'toolchain': TOOLCHAIN, 'log': '', 'verify': None, 'artifacts': {},
                                    'inputs': {}, 'diagnostics': [{'file': body['target'], 'line': 1, 'column': 1,
                                    'severity': 'error', 'message': f'build timed out after {BUILD_TIMEOUT} s'}]})
        finally:
            BUILD_SLOTS.release()
        ok, diagnostics, artifacts, log, verify = result
        self._send(200, {
            'ok': ok, 'diagnostics': diagnostics, 'log': log[-200000:], 'verify': verify, 'toolchain': TOOLCHAIN,
            'inputs': {rel: hashlib.sha256(data).hexdigest() for rel, data in sorted(files.items())},
            'artifacts': {rel: base64.b64encode(data).decode() for rel, data in artifacts.items()},
        })

    def log_message(self, fmt, *args):
        print('build: ' + fmt % args, flush=True)

    def _send(self, status, payload):
        data = json.dumps(payload).encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass


async def main():
    import websockets
    global TOOLCHAIN
    TOOLCHAIN = toolchain_versions()
    shutil.rmtree(SESSIONS, ignore_errors=True)  # left by a previous run (its processes died with it)
    os.makedirs(SESSIONS, mode=0o711, exist_ok=True)
    os.makedirs(USERS, mode=0o711, exist_ok=True)
    for name in os.listdir(USERS):
        if time.time() - os.stat(f'{USERS}/{name}').st_mtime > CACHE_DAYS * 86400:
            shutil.rmtree(f'{USERS}/{name}', ignore_errors=True)
    threading.Thread(target=ThreadingHTTPServer(('0.0.0.0', 9258), Builds).serve_forever, daemon=True).start()
    async with websockets.serve(lsp, '0.0.0.0', 9257, max_size=16 * 1024 * 1024):
        print('toolchain: lsp ws://:9257/lsp, builds http://:9258/build', json.dumps(TOOLCHAIN), flush=True)
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
