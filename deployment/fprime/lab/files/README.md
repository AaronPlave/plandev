# F Prime Sequencing Lab

Sequences for the MathDeployment example (dictionary `MathProject.MathDeployment.20260706T1030` v4.2.0),
built with the real F Prime toolchain. Seeded by `deployment/fprime/lab/seed_lab.py`; rerunning it
does not duplicate files, builds or revisions.

## What is here

| Path | What it shows |
|---|---|
| `rust/` | The healthy Cargo project (conventional layout; managed files hidden unless "Show managed files" is on). |
| `rust/src/bin/restricted_checkout.rs` | `#[fprime_main(restrict)]`: a list of steps. Built and verified; nothing has changed since (**fresh build**). |
| `rust/src/bin/recommended_math.rs` | `#[fprime_main(recommended)]`: `if` on a parameter, a `message` event. **Edited after its build** (the wait went from 2 s to 3 s), so its `.wasm` is out of date. |
| `rust/src/bin/unrestricted_sweep.rs` | `#[fprime_main]`, no profile: a `for` loop that restrict and recommended both reject. |
| `rust/src/bin/factor_campaign.rs` + `rust/src/helpers.rs` | A sequence built from reusable helpers in the project's library (`pub mod helpers;` in `src/lib.rs`), each helper checked with `#[fprime(restrict)]`. |
| `rust/src/bin/bake_bread_from_plan.rs` | Generated from a plan by sequence template expansion; the banner links back to the plan and activity. |
| `rust/tests/behavior.rs` | Behaviour tests: `factor_campaign` sets FACTOR then runs two operations; `recommended_math` resets FACTOR only when it is not 1.0. |
| `rust/out/*.wasm` | Build outputs. Each records its source, saved version, input hashes, toolchain and verify result. |
| `failing/` | A **separate** Cargo project for the intentional Rust failure, so it can't break `rust/`'s builds, tests or code help. |
| `failing/src/bin/profile_violation.rs` | `#[fprime_main(recommended)]` with a `for` loop: the build fails at line 11 with the profile's message. |
| `sequences/startup.seq` → `startup.bin` | A valid F Prime `.seq`, compiled by `fprime-seqgen`. |
| `sequences/invalid.seq` | Three commands with wrong arguments: the editor and the build both report them against the dictionary. |

## Expected failures

- `failing/src/bin/profile_violation.rs`: *loops are not allowed: write the steps out, or ask for a waiver*, at the `for`.
- `sequences/invalid.seq`: missing argument, extra argument, and an F32 value out of range. No `.bin` is written.

Failed builds write no artifact; their diagnostics are in the Actions panel → run history.

## Where to click

1. Open `rust/src/bin/restricted_checkout.rs`, then the **Metadata** tab (or the "1 build" link in the
   banner): **Builds** lists `rust/out/restricted_checkout.wasm` as up to date. Open it; its **Build**
   section links back to the source.
2. Open `rust/src/bin/recommended_math.rs`: Builds says the saved source changed since the build.
   **Compare with build** shows the edit. Run **F Prime compile** on it to rebuild.
3. Type in any built source without saving: Builds reports unsaved edits separately from the saved state.
4. Run **F Prime test** on any file in `rust/` to run the behaviour tests; **F Prime verify** on a
   `.wasm` checks it against `sequencer.toml` without rebuilding.
5. Open `rust/src/bin/bake_bread_from_plan.rs`: "Generated from plan …" opens the plan with the activity selected.

A successful build means the sequence compiles, satisfies its profile and loads within the
sequencer limits. It is not a check of operational validity.
