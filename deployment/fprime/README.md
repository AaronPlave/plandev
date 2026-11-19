# F Prime sequencing for SeqDev (optional)

Author, check and build [F Prime](https://github.com/nasa/fprime) sequences in SeqDev, against one
F Prime JSON dictionary shared by two languages in the same parcel:

| Language | Editor | Build (Action "F Prime compile") |
|---|---|---|
| Standard `.seq` (`fprime-seqgen` syntax) | highlighting, dictionary completion/hover/linting, command panel | dictionary check, then `fprime-seqgen` → `.bin` next to the source |
| Rust/WASM `src/bin/<name>.rs` ([fprime-wasm](https://github.com/fprime-community/fprime-wasm)) | rust-analyzer (completion, hover, go-to-definition, restriction-profile diagnostics) | `fprime-wasm build` (profile enforced) + `verify` → `<project>/out/<name>.wasm` |

Built artifacts are read-only workspace files with a revision and provenance metadata
(`fprimeBuild`: source and revision, input hashes, dictionary hash, artifact hash and size, verify
result, toolchain versions and patches). SeqDev's Metadata panel compares those hashes with the saved
files ("source changed since this build" means rebuilt output would differ, not that the artifact is
invalid) and finds the built source among the file's saved versions to diff it. The Action "F Prime new sequence" starts a Rust sequence, and its Cargo project if
needed, from fprime-wasm's own scaffolding with a chosen restriction profile; "F Prime test" runs a
project's behaviour tests (`fprime-wasm test`); "F Prime project check" brings an existing project up
to the conventions below, previewing every change first.

## Authoring workflow

- **New File** offers the adaptation's file starters (`adaptation.js`): *F Prime sequence* (`.seq`),
  *F Prime Rust sequence* (restrict profile), *F Prime Rust sequence (unrestricted)*, and *F Prime
  sequence test*. The Rust starters run "F Prime new sequence" in the workspace's Cargo project
  (chosen automatically when there is one, offered as a choice when there are several; with none, a
  new project `rust/` is set up in the chosen folder) and open the new file. A mission picks the
  profiles it offers by editing these starters; the profile stays in the source's
  `#[fprime_main(..)]`.
- **Sequences are just files.** Every `src/bin/<name>.rs` is a sequence: Cargo discovers it, nothing
  is declared in `Cargo.toml` (see the host-stub patch below). Create, rename, move, copy, delete and
  restore sequences with the ordinary workspace operations; no project file has to follow. A `.rs`
  moved out of `src/bin/` is no longer a sequence. Share code between sequences through `src/lib.rs`
  modules (or a `src/bin/<dir>/` module without `main.rs`), not a top-level `src/bin/common.rs`,
  which Cargo would take for a sequence.
- **Managed files.** The project infrastructure the toolchain writes is marked
  `user.managedBy: "fprime-wasm"`; SeqDev hides such files unless *Show managed files* (eye icon in
  the file list) is on. Toolchain-controlled ones (`Cargo.toml`, `.cargo/`, `build.rs`,
  `dictionary/`) are also read-only; `src/lib.rs` (where a mission adds helper modules), profiles,
  `sequencer.toml` and `README.md` stay editable. Sequences, tests, helper modules users add and
  built `out/*.wasm` are ordinary, visible files. Remove the `managedBy` key (file metadata panel) to
  treat a file as ordinary. Restoring a revision of a file keeps its current `managedBy` (it says who
  maintains the file now, not part of its history); copies keep it (generic copy semantics), a path
  deleted and created again is ordinary. Projects created before these conventions: run **F Prime
  project check** (see below).
- **F Prime project check** (`project`, `apply`). Compares each infrastructure file with what
  `fprime-wasm init` produces today for that project (same crate name, dictionary file name,
  profiles): files generated and unchanged are marked managed (read-only where toolchain-controlled),
  edited ones stay ordinary; `[[bin]]` entries of the exact form fprime-wasm wrote are removed (a
  stale one, left by a renamed or deleted sequence, fails every build); the dictionary copy is
  replaced by the parcel's when they differ. With `apply` off (default) it only reports; with it on
  it makes exactly the listed changes, keeping other user metadata.
- **Tests are optional.** Upstream `fprime-wasm add` writes a test stub with every sequence; the
  service drops it unless a test is asked for (*F Prime sequence test*, or the Action's `test`
  parameter), and never overwrites an existing test. "F Prime test" on any file of a project runs
  that project's tests (`fprime-wasm test`): every `tests/*.rs`, whatever it is called and however
  many sequences it covers (each `#[fprime_test(sequence = "..")]` names its sequence). Which tests
  exercise a sequence is only known to the Rust code, so the Action does not guess; the optional
  `filter` narrows by test function name, as upstream's own filter does. No tests, or none matching
  the filter, reports **Not run: … 0 tests executed** and runs nothing (status SUCCESS: Actions have
  no neutral status). Builds and tests prepare the project the same way (`seqdev/project.js`).
- **One project dictionary.** A Cargo project's dictionary copy (the file `build.rs` names) is what
  rust-analyzer, builds, tests and an external IDE all read. Builds and tests compare it with the
  parcel's dictionary first and refuse to run when they differ, naming **F Prime project check**,
  which previews the replacement and writes it only with `apply` on. Nothing rewrites it as a side
  effect; once saved, the editor's language server picks it up like any other saved file. `.seq`
  builds use the parcel dictionary directly. A build of a project that still has old generated
  `[[bin]]` entries succeeds and says project check can remove them.
- **Existing modules.** **F Prime verify** checks a `.wasm` (a build output, an imported module, or
  any revision of one) with `fprime-wasm verify`, without building or changing it, against the
  `limits` file given, else the `sequencer.toml` of the Cargo project it sits in, else fprime-wasm's
  stock limits; the report names which, lists each budget, and compares the bytes with the file's
  `fprimeBuild` metadata (editable metadata: a consistency check, not proof of origin). It loads and
  sizes the module; it does not run it. **F Prime view WAT** shows a module as WebAssembly text
  (binaryen `wasm-dis`, which reads the custom page sizes fprime-wasm uses) in the run report,
  read-only, cut off at `FPRIME_MAX_WAT_BYTES` (512 KiB); nothing is written to the workspace.
- **Editor.** "Preparing code help…" shows while rust-analyzer loads (ready = its
  `experimental/serverStatus` reports quiescent, not just a connected socket). Dictionary command
  completion works until then and when the service is down. Right-click in the editor: Go to
  definition (F12; Fn+F12 on most Mac keyboards), Find references, Rename, at the clicked symbol, plus
  Cut/Copy/Paste/Select All. Definitions in other workspace files open
  in the editor (*Back* returns); definitions in the API generated from the dictionary or in library
  crates open read-only in a panel below the editor (the service serves only those sources, see
  `read_source`). *Format document* (Shift+Alt+F) uses rustfmt through rust-analyzer.
- **Mission editor rules.** `adaptation.js` passes `lint` to `getFprimeAdaptation`: an example rule
  rejects `FileHandling.fileManager.ShellCommand`. Mission rules and rust-analyzer diagnostics are
  separate CodeMirror lint sources, shown together with their source (`[mission rules]`, `[rustc]`);
  mission rules run without the language server too. Editor guidance only: builds do not enforce them.

## Pieces

| Path | What |
|---|---|
| `toolchain/` | Container image and service: rust-analyzer over WebSockets (port 9257, for browsers) and builds (port 9258, internal) |
| `docker-compose-fprime.yml` | Compose override adding the service to a deployment or development stack |
| `seqdev/` | Builds the SeqDev adaptation and the Action bundles from `@nasa-jpl/plandev-sequence-languages` (`project.js`: shared by the Actions; `npm test`: project check, project reading) |
| `setup.py` | Installs dictionary, adaptation, Actions, parcel and workspace into a running PlanDev |

The editor languages live in `plandev-sequence-languages` (`fprime-seq`, `fprime-rust`); the dictionary
parser (`sequencing-server/plugins/fprime-dictionary-parser`) and the Rust template helpers
(`sequencing-server/src/lib/mustache/util/rust.ts`) in this repository.

## Setup from a fresh checkout

Needs Docker, Node ≥ 20, Python ≥ 3.9 and a running PlanDev (here: the development stack from the
repository root; for `deployment/docker-compose.yml` use the same files from `deployment/`).

```sh
# 1. Toolchain image (pinned versions; compiles fprime-wasm, a few minutes the first time)
docker build -t plandev-fprime-toolchain:dev deployment/fprime/toolchain
deployment/fprime/toolchain/test/run.sh        # offline regression tests, optional

# 2. Start it with the stack
docker compose -f docker-compose.yml -f deployment/fprime/docker-compose-fprime.yml up -d

# 3. Adaptation and Action bundles
cd deployment/fprime/seqdev && npm ci && npm run build && cd -

# 4. Install into PlanDev (defaults: localhost ports of the development stack, user test/test)
python3 deployment/fprime/setup.py \
  --dictionary sequencing-server/plugins/fprime-dictionary-parser/test/dictionary/MathDeploymentTopologyDictionary.json
```

Then open the workspace "F Prime" in SeqDev:

1. `sequences/startup.seq` — edit with the command panel; run **F Prime compile** → `sequences/startup.bin`.
   `sequences/invalid.seq` fails at the *dictionary* stage with located errors.
2. Run **F Prime new sequence** (project `rust`, sequence `startup`, profile `restrict`) →
   `rust/src/bin/startup.rs`. Open it: rust-analyzer completes `CdhCore.cmdDisp.` etc.
   Add `loop {}`: the profile violation appears in the editor and fails the build at the *profile* stage.
3. Run **F Prime compile** on it → `rust/out/startup.wasm`, verified.
4. Templates: add `seqdev/examples/BakeBananaBread.rs.hbs` as a sequence template (language `text`)
   for the banananation model's `BakeBananaBread`, expand a simulated activity, save the result as
   `rust/src/bin/<name>.rs` (create it with **F Prime new sequence** first) and build it. The template's
   `use rust::*;` names the crate, i.e. the project folder.

`npm ci` builds `@nasa-jpl/plandev-sequence-languages` from its git dependency (its `prepare`
script); it does not work with `--ignore-scripts`. Until that package is published with the F Prime
languages, this is the supported way to get it.

Another dictionary: pass it to `setup.py` (re-running is safe: it re-parses the dictionary, updates the
adaptation and adds new Action versions). The dictionary is persisted so Actions build against the
exact file the editor parsed.

## Configuration

Service environment (`docker-compose-fprime.yml`):

| Variable | Default | Meaning |
|---|---|---|
| `FPRIME_MAX_SESSIONS` | 5 | rust-analyzer sessions in the container. Each holds ~0.9 GB once indexed (measured on the Math example). |
| `FPRIME_MAX_SESSIONS_PER_USER` | 3 | Sessions per PlanDev user. One per Cargo project open in their editors, across tabs. |
| `FPRIME_IDLE_SECONDS` | 900 | A session with no editor activity this long is closed; the editor resumes it on the next edit. |
| `FPRIME_MAX_BUILDS` | 2 | Concurrent builds; more wait (up to the build timeout) and then fail as busy. |
| `FPRIME_BUILD_TIMEOUT_SECONDS` | 600 | A build, with everything it started, is killed after this. |
| `FPRIME_PROCESS_MAX_DATA_BYTES` | 0 (off) | Per-process heap limit for user processes; the container limit always applies. |
| `FPRIME_CACHE_DAYS` | 14 | Per-user build caches (~0.4 GB each) unused this long are deleted when the service starts. |
| `FPRIME_TOOLCHAIN_MEMORY` / `_CPUS` | 6g / 4 | Container limits. Size memory as sessions × ~1 GB + builds × ~0.5 GB. |
| `FPRIME_LSP_PORT` | 9257 | Published port for the browser connection. |

Tradeoffs: a session per (user, Cargo project) gives every user their own unsaved text and caches,
at ~0.9 GB each; the limits trade concurrency for memory. Sessions start in 3–8 s (empty per-user
cache ~7 s, warm ~3 s) and answer in 0.3–0.5 s afterwards; no sessions are kept warm in advance.
When limits are reached the editor says so and retries when the user edits.

Action settings (set by `setup.py`): `toolchainUrl` (default `http://fprime_toolchain:9258`), and for
**F Prime compile** an optional `seqTimeBase`, passed to `fprime-seqgen --timebase` (default: none,
i.e. `TB_DONT_CARE`).

Adaptation (`seqdev`, at build time): `FPRIME_LSP_URL`. Default: `ws(s)://<SeqDev host>:9257/lsp`.
The browser must send its SeqDev cookies with the connection, so the service has to be on the same
host as SeqDev (any port), e.g. behind the deployment's reverse proxy. An empty value disables the
language server: `.rs` files then get highlighting and dictionary completion only.

No secrets: the service authenticates every request with the user's own SeqDev token and active role
(cookie for the editor, forwarded by the Action for builds) by asking the workspace service.

## Security model

Rust builds and rust-analyzer run project code: build scripts and procedural macros. So:

- They run only in this container, never in a PlanDev service. Its own network is shared with just
  the workspace service and the action server. The build port is not published.
- Every request is authorized by the workspace service with the user's token and active role. Files
  come from the workspace service, read with those credentials, and only from the requested project.
  Access is re-checked whenever a session resynchronizes (on file open, save, and while editing). A
  read-access revocation closes the session. Note that PlanDev's default role permissions let every
  user read every workspace, and this service follows whatever the deployment configures.
- Each PlanDev user gets their own uid in the container. Sessions, builds and caches are mode 0700 and
  umask 077 under that uid. User processes cannot create network sockets (seccomp: `AF_INET`,
  `AF_INET6`, netlink and packet sockets, `io_uring`, `ptrace` are refused), and are limited in
  process count, file size, run time and (optionally) heap.
- The service runs as root inside the container only to switch uids. All capabilities are dropped
  except `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `KILL`, `SETGID` and `SETUID`, with `no-new-privileges`
  and a read-only root filesystem. Files it writes into or reads from user directories are opened
  without following symlinks. Paths from requests are checked against traversal.
- Crates come only from the image: vendored, read-only, offline. Build caches are per user, so a
  user can only ever execute cached output of their own builds.
- Every process a session or build started is killed when it ends (process group, then everything
  owned by the user's uid once they have nothing running). Restarting the container kills everything.
- Request size, file count and project size are limited (`FPRIME_MAX_PROJECT_*`).

Not provided: per-user memory quotas (the container limit applies to all sessions together),
disk quotas beyond the cache eviction above, and isolation stronger than uids plus seccomp in one
container. Deployments that need more should run the image under gVisor or similar.

## Time semantics in templates

- `{{rust-epoch-us startTime epoch="<ISO-8601>"}}` renders microseconds from the given epoch for
  `asleep(..)`. fprime-wasm defines `asleep`'s argument as microseconds "from system epoch", which
  depends on the flight software's time base, so the epoch is required. The difference is counted
  as POSIX time (UTC without leap seconds). A clock counting SI seconds across leap seconds needs a
  mission-specific conversion, which these helpers do not provide.
- `{{rust-duration-us d}}` renders microseconds for `rsleep(..)`: non-negative, whole microseconds,
  days or shorter.
- `.seq` absolute time tags (`A2026-321T12:00:00`) are converted by `fprime-seqgen` as UTC seconds
  since the Unix epoch. The binary records the time base given by `seqTimeBase` (default `0xFFFF`,
  "don't care"), which the sequencer compares with its own.
- Other helpers: `rust-string`, `rust-int [type]`, `rust-float ["f32"|"f64"]`, `rust-bool`,
  `rust-ident`, `rust-array <element kind> [type]`. Each produces a literal or fails the expansion
  with the template id and activity, never code. Integers beyond ±2^53 are refused, because activity
  values are JavaScript numbers by the time they reach templates.

## Toolchain versions and the local patch

Pinned in `toolchain/`: Rust 1.100.0 (rust-analyzer from the same toolchain), fprime-wasm 0.1.10 (CLI
and crates, `vendor-manifest/Cargo.lock`), binaryen `wasm-opt` 133 (checksummed), fprime-gds 4.4.1 and
its Python dependencies (`requirements.txt`), and restriction profiles from fprime-wasm `v0.1.10`
(checksummed). All of them, and the patches below, are reported in each build's provenance.

`fprime_macros-0.1.10-command-hygiene.patch`: fprime_macros 0.1.10 calls `command(..)` unhygienically
in generated code. Any dictionary command with an argument named `command` therefore fails to
compile (`E0618: expected function, found &str`), and every F Prime v4 deployment has one in
`Svc.FileManager.ShellCommand`. The patch calls `::fprime_core::command(..)`. It is applied at image
build to a copy of the vendored release, used through `[patch.crates-io]`. `toolchain/test/smoke.sh`
reproduces the failure against the unpatched release and fails once upstream fixes it, so the patch
can be dropped then. It has not been reported upstream yet.

`fprime_macros-0.1.10-host-stub.patch`: `#[fprime_main]` built for the host is an empty program. A
host `cargo test` (which `fprime-wasm test` runs) builds every binary target for the host, also for
integration tests only (`CARGO_BIN_EXE_*`); a `#![no_std] #![no_main]` sequence cannot link there
(`unwinding panics are not supported without std`). Upstream avoids that with a `[[bin]]
required-features = ["wasm"]` entry per sequence, which every create/rename/delete must keep in step
(a stale entry fails every build). With this patch Cargo's own `src/bin/*.rs` discovery is enough;
the `.wasm` output is byte-identical (checked on fprime-wasm's example crate), and the host stub
costs ~0.1 s per sequence in a test build. The scaffold leaves the entries out. Not reported
upstream yet; `smoke.sh` builds and tests a project without entries.

To move to another fprime-wasm release: update the versions in `vendor-manifest/Cargo.toml` and the
Dockerfile ARG, regenerate `vendor-manifest/Cargo.lock` (`cargo generate-lockfile`), update or drop
the patch, update the profile checksums, rebuild, and run `toolchain/test/run.sh`.

## Working outside SeqDev (VS Code, command line)

A Rust sequence project is a conventional Cargo project: `src/bin/<name>.rs` sequences auto-discovered,
the dictionary copy and restriction profiles as plain files, nothing generated or rewritten only for
SeqDev. Download the folder (or upload one with Import) and edit it with rust-analyzer as usual;
SeqDev reads whatever is saved. Two things differ from stock tooling:

- `fprime-wasm build` and `verify` work with stock fprime-wasm 0.1.10. `fprime-wasm test` does not:
  without the host-stub patch above, a host `cargo test` cannot link `#![no_std]` sequences unless
  each has a `[[bin]] required-features = ["wasm"]` entry. Run the tests through the "F Prime test"
  Action, apply `toolchain/fprime_macros-0.1.10-host-stub.patch` to your vendored fprime_macros, or add the entries.
- Artifacts built outside SeqDev carry no `fprimeBuild` metadata, so SeqDev shows no provenance for
  them rather than guessing; rebuild with the "F Prime compile" Action to record it.

## Known limitations

- `fprime-seqgen` (fprime-gds 4.4.1) accepts missing and extra command arguments and crashes on
  out-of-range F32 values. The F Prime compile Action applies the editor's dictionary check first,
  so such sequences fail at the *dictionary* stage. The check also follows seqgen in accepting only
  bare enum constants. Operational argument ranges are not in F Prime dictionaries and are not checked.
- A file's named revisions are reachable only while the file exists: there is no way in SeqDev to
  bring back a deleted file from its revisions (the restore API needs an existing file). Deleting a
  sequence does not delete its built `out/<name>.wasm` (or its revisions); their provenance still
  names the old source path.
- rust-analyzer can answer *content modified* to Go to definition while it is still processing an
  edit; the editor then shows "Find definition failed: content modified" (retry works).
- `fprime-wasm test [FILTERS]...` (0.1.10) passes every filter to `cargo test`, which accepts only
  one, so the Action takes a single name filter. Upstream reports a run with no tests, or no
  matching tests, as success; the Action reports those as such instead.
- Restriction profiles reject calls to helper functions, so helper modules only help unrestricted
  (`#[fprime_main]`) sequences.
- Deleting a Cargo project folder needs its read-only managed files unlocked first (workspace rule).
- Only crates vendored in the image are available. Projects needing others need a custom image.
- One activity → one Rust sequence file; multi-activity Rust programs are not composed.
