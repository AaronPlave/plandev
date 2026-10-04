# Simulation profile storage: does it need to change?

[`HUGE_SOURCE_DATA.md`](HUGE_SOURCE_DATA.md) built a dense chunk store, `pg_chunks_v1`, for imported products.
This note asks whether simulation profiles (`merlin.dataset`, `merlin.profile`, `merlin.profile_segment`) should
move to it, or to something like it.

**Short answer: no, not now.** Keep `profile_segment` as the authoritative store. Make large simulations
interactive the way imported sources already are: bounded window queries that include the boundary segment,
plus display reduction on the server (approach **A**). Add a derived summary table only for large, completed
simulations, when whole-extent views of profiles with hundreds of thousands of segments become a real need
(approach **B**). Pluggable dense storage for simulations (approach **C**) has no supporting evidence yet, and
semantic and lifecycle costs count against it.

Each section below marks its claims as **Measured** (run for this note), **Read** (from the code) or
**Inferred** (reasoned from the measurements).

## 1. Semantic compatibility: can the chunk model hold every simulation profile without loss?

**Not without loss as it stands.** Several of the gaps are fundamental, not cosmetic. (Read.)

| Profile feature | How `profile_segment` stores it | Chunk model (`pg_chunks_v1`) | Lossless? |
|---|---|---|---|
| Real dynamics (piecewise linear) | One segment `{initial, rate}` (rate per second) per change. The value may jump at a segment boundary. | Samples with `interpolation = linear` between neighbours. A jump needs two samples at the same time (allowed). The rate becomes implicit, `(v1 − v0)/Δt`. | **No.** Rate and end value are recomputed in float64, so they are not bit-exact. Storing `{initial, rate}` would need a new column. |
| Discrete values that are arbitrary JSON (structs, arrays, variants, durations) | `dynamics` is jsonb. The type comes from `profile.type = {"type": "real"\|"discrete", "schema": ValueSchema}`. | Numbers go in float64; everything else is UTF-8 text. | Only if stored as canonical JSON text with the schema in the catalog. Summaries compare text equality, so key order and number formatting must be canonical. |
| Discrete integers (`int` is a Java `long`) | jsonb number, exact | float64 | **No** above 2^53 |
| Valid null (discrete `SerializedValue` null) | `dynamics = null`, `is_gap = false` | kind `NULL` | Yes |
| Gap | `is_gap = true`. Written only by external datasets (`PostProfileSegmentsAction`) and the scheduler. The simulation worker always writes `false` (`PostgresProfileQueryHandler`). | kind `GAP` | Yes |
| End of profile | `profile.duration`: the last segment runs until then | Coverage end or a trailing sample | Yes, with an explicit end sample |
| Same-time / zero-duration segments | **Not representable.** The key is unique on `(dataset_id, profile_id, start_offset)`. The engine emits at most one update per resource per batch, but several batches can share one time (`SimulationEngine.step`), so a second update at the same offset would violate the key. Not observed in these runs. | Allowed; file order is kept | The chunk model is a superset here |
| Repeated equal values | Kept, one segment each. For example, `/flag` gets `"A"` at 0 h and again at 7 h. | Kept | Yes |
| Time basis | `interval` offset from simulation start. Absolute time = `simulation_dataset.simulation_start_time` (or, for external datasets, plan start + `plan_dataset.offset_from_plan_start`) + offset. Moving the plan shifts these bases (`plan.sql`). | Absolute µs since the Unix epoch, as float64 | Only by fixing the basis at write time, or by making the basis a provider concern. Otherwise relative data would be rewritten whenever a basis moves. |

So the chunk *encoding* could be extended to cover simulations: add a linear `{initial, rate}` column, text
JSON with canonical form, int64 values and a relative time basis. But that is a new format, not
`pg_chunks_v1` as it is.

## 2. Lifecycle compatibility: everything that depends on the tables today

**`pg_chunks_v1` is write-once.** A revision loads into standalone tables and is attached when it is
published. **Simulation datasets are the opposite:** the dataset row (and its partitions) is created when
the request is made (`simulation_dataset.sql`, `set_revisions_and_initialize_dataset_on_insert`), before the
simulation runs. Segments are then streamed while it runs (Read):

- `StreamingSimulationResourceManager` flushes all completed segments whenever any resource holds 1,024 of
  them. `PostgresProfileStreamer` and `PostgresProfileQueryHandler` batch-insert those segments and update
  `profile.duration`.
- The UI shows partial results: `stores/profile.ts` refetches the tail (`GET_PROFILE_SINCE`, `start_offset >
  sinceOffset`) each time `simulation_extent` advances.
- **Measured:** the 1M-activity run streamed all 2.0M segments (through 8,759:59 of 8,760 h), then failed
  with `OutOfMemoryError` in `SimulationEngine.spanToSimulatedActivities`. Spans are built in memory and
  written at the end. Profiles were not the bottleneck: span results were.

Direct dependents (Read; paths relative to each repo):

| Area | Dependency |
|---|---|
| Schema | `tables/merlin/dataset/{dataset,profile,profile_segment}.sql`: partition allocate and drop triggers; cascade triggers that act as foreign keys; unique key. `simulation_dataset.sql` creates the dataset; `plan_dataset.sql` handles create, offset and garbage collection; `plan.sql` shifts offsets; `scheduling_request.sql` has a foreign key to `dataset`. |
| Views / functions | `views/merlin/resource_profile.sql` uses the **plan** start, not the simulation start, and ignores `is_gap`. `functions/hasura/hasura_functions.sql` has `get_resources_at_start_offset`. |
| Simulation write | merlin-worker: `MerlinWorkerAppDriver`, `PostgresProfileStreamer`, `PostgresProfileQueryHandler` (streamed). merlin-server: `ProfileRepository`, `Post/AppendProfileSegmentsAction`, `PostProfilesAction`, `UpdateProfileDurationAction`. |
| Constraints | merlin-server `ConstraintAction` → `PostgresResultsCellRepository` → `ProfileRepository.getProfiles` / `GetProfileSegmentsAction`, which loads **all** profiles. `ProfileSet.unwrapOptional` would throw on a gap in simulation profiles. External datasets go through `PostgresPlanRepository.getExternalDatasets` → `LinearProfile`/`DiscreteProfile.fromExternalProfile`. EDSL codegen reads `profile.type` (`TypescriptCodeGenerationServiceAdapter`). The `resourceSamples` action uses `GetSimulationResultsAction`. |
| Scheduler | `GraphQLMerlinDatabaseService`: `storeSimulationResults` writes `profile` and `profile_segment` through Hasura in one batch after the run. `getProfilesWithSegments` reads them with no `order_by`, although the parser assumes order. External profiles come from `plan_dataset`. |
| External datasets | merlin-server `addExternalDataset`/`extendExternalDataset` (append). Gateway `src/packages/plan/plan.ts` `POST /uploadDataset` (CSV/JSON, in chunks). |
| Hasura | Tables `dataset`, `profile`, `profile_segment`, `resource_profile_view`, `plan_dataset` and `simulation_dataset` (relationships `profiles` and `profile_segments`). Function `getResourcesAtStartOffset`. Actions `addExternalDataset`, `extendExternalDataset`, `resourceSamples` and `constraintViolations`. |
| UI | `gql.ts`: `GET_PROFILE_SINCE`, `GET_EXTERNAL_PROFILE_SEGMENTS_SINCE`, `SUB_PLAN_DATASET`, `SUB_SIMULATION_DATASET_PROFILES`, `GET_ANALYSIS_SIMULATION_DATASETS`. Stores `profile.ts`, `externalResource.ts`, `timelineSources.ts`, `analysis.ts`. `utilities/resources.ts` `sampleProfiles` turns `{initial, rate}` into points and `start_offset` into absolute time. |
| Sequencing | None. It reads spans only. |
| Plan import/export, snapshots, merge, duplication | None. They do not copy datasets. Deleting a plan cascades to the dataset and drops its partitions. |
| Tests | e2e `ExternalDatasetsTest`, `SimulationTests`, the EDSL tests and `GQL.java`; db-tests `MerlinDatabaseTests`; `load-tests/src/requests.ts`. |

Moving simulations to another physical store would touch the worker, merlin-server (constraints and
external datasets), the scheduler, Hasura metadata, the UI and the tests. It would also need incremental
visibility, which `pg_chunks_v1` deliberately does not have.

## 3. Real scale: measured

The tool is in `deployment/benchmarks/simulation_profiles/` (see [How to run](#how-to-run)). It ran on the
local `tol` stack: Postgres 16.14 in Docker with stock settings, on an Apple M4 Max.

- Times are the median of 3–5 warm runs. "SQL" is wall time in psql.
- "Hasura" is client wall time for the UI's real query shape through `:31140`. Raw is plain JSON; gzip is
  the same request with `accept-encoding: gzip`.
- The windows are centred in the largest profile and include the one segment before the window.

The datasets:

- **Scratch simulations** of banananation plans `profile-bench-*`: a round robin of BiteBanana, GrowBanana,
  PickBanana and ChangeProducer, over 30 days (1k) or 1 year (the others). Banananation has only 7
  resources, so these test segments per profile, not profile count.
- **Dataset 5** is the real 4.35-year mission-tour product from the huge-source benchmark, loaded into
  `profile_segment` by `ProfileSegmentBench`, one segment per sample. It is the realistic large case for
  profile count and density.

| Dataset | Plan (activities) | Profiles | Segments | Segments per profile, min / p50 / p95 / max | On disk (heap + indexes) | Bytes per segment |
|---|---|---:|---:|---|---|---:|
| 8 | profile-bench-1000 (1k, 30 d) | 7 | 2,004 | 1 / 250 / 750 / 750 | 312 kB (176 kB + 96 kB) | 159 |
| 9 | profile-bench-10000 (10k, 1 y) | 7 | 20,004 | 1 / 2,500 / 7,500 / 7,500 | 3.0 MB (1.7 + 1.3) | 154 |
| 10 | profile-bench-100000 (100k, 1 y) | 7 | 200,004 | 1 / 25,000 / 75,000 / 75,000 | 30 MB (17 + 13) | 155 |
| 11 | profile-bench-1000000 (1M, 1 y)¹ | 7 | 1,999,994 | 1 / 250,000 / 749,995 / 749,995 | 306 MB (174 + 132) | 161 |
| 5 | mission-tour product loaded as segments | 3,705 | 275,707,860 | 2 / 116 / 433,457 / 926,646 | 41 GB (31 + 10) | 161 |

¹ The simulation failed with OOM in span results after all profile segments had been streamed (see §2).

Reads of the largest profile:

| Dataset | Whole profile, SQL | Whole profile reduced to 2k buckets on the fly, SQL | UI whole-profile fetch (Hasura): time, raw / gzip | 1-day window: segments, SQL, Hasura, gzip | 7-day window | 30-day window | Same window × 10 largest profiles, SQL |
|---|---|---|---|---|---|---|---|
| 8 | 0.9 ms | 1.3 ms | 3 ms, 96 KB / 6 KB | 25, 0.5 ms, 3 ms, 0.4 KB | 175, 0.8 ms, 3 ms, 1.6 KB | — | 1 d: 73 segments, 2 ms |
| 9 | 4.1 ms | 5.6 ms | 16 ms, 987 KB / 70 KB | 22, 0.8 ms, 2 ms, 0.4 KB | 145, 0.6 ms, 3 ms, 1.5 KB | — | 7 d: 391 segments, 0.8 ms |
| 10 | 38 ms | 26 ms | 147 ms, 10.1 MB / 688 KB | 207, 1.3 ms, 4 ms, 2 KB | 1,439, 1.3 ms, 6 ms, 13 KB | — | 7 d: 3,841 segments, 4 ms |
| 11 | 568 ms | 173 ms | 1.8 s, 118 MB / 7.7 MB | 2,056, 1.9 ms, 8 ms, 24 KB | 14,383, 9.9 ms, 27 ms, 169 KB | 61,645, 49 ms, 131 ms, 698 KB (9.7 MB raw) | 30 d: 164,391 segments, 111 ms |
| 5 | 580–1,067 ms | 244–306 ms | 2.1 s, 149 MB / 22 MB | 1,581, 1.7 ms, 6 ms, 41 KB | 8,811, 5.5 ms, 18 ms, 220 KB | 23,798, 15 ms, 40 ms, 577 KB (3.8 MB raw) | 1 d: 15,810 segments, 9.5 ms; 7 d: 88,110, 59 ms; 30 d: 237,980, 140 ms |

Other measurements:

- **Simulation wall time**, from request to `success`: 10k activities ≈ 3 s; 100k ≈ 19 s; 1M failed after 71 s.
- **For comparison, the same product as dataset 5 in `pg_chunks_v1`** (from `HUGE_SOURCE_DATA.md`): 5.4 GB
  instead of 41 GB (20 instead of 161 bytes per sample). Any window of one resource is served within the
  2,000-point budget in 2–6 ms and at most 26 KB.
- **The UI's whole-profile query** now returns about 160 bytes of JSON per segment. That is roughly twice
  the earlier measurement in that document (74 MB for the same 926k-segment resource), because the query
  shape now carries `dataset_id`, `profile_id` and `is_gap` on every segment.
- **The bounded queries use the existing unique index** `(dataset_id, profile_id, start_offset)`: an index
  scan with 56 buffer hits for a 1-day window of dataset 11. The schema's TODO about a range index on
  `start_offset` is already covered in practice.
- **Dataset 4** is an earlier, aborted `ProfileSegmentBench` load: 3,705 profiles, 0 segments, but 3.4 GB of
  index left behind. It was left untouched.

## 4. Query path first: can bounded queries make large simulations interactive?

**Yes, for viewports. Not for whole-extent overviews of very dense profiles without a summary.**

Measured:

- **Window cost depends on the segments in the window, not on dataset size.** A 1-day window costs about
  2 ms in SQL on a 41 GB dataset, the same as on a 300 MB one. Throughput is about 0.6–0.8 µs per returned
  segment in SQL and about 2 µs through Hasura. Raw JSON is about 158 bytes per segment (about 11 bytes
  gzipped).
- **On-the-fly 2k-bucket reduction** scans the profile at about 0.2–0.33 µs per segment: 26 ms at 75k
  segments, 173–306 ms at 750k–930k.
- **Fetching the whole profile, as the UI does today,** is fine up to about 10^4 segments per profile
  (16 ms, 70 KB gzipped). It reaches 147 ms and 10 MB of raw JSON at 75k, and 1.8–2.1 s and 118–149 MB at
  750k–930k, before the browser has parsed or sampled anything.

Inferred decision boundary:

| Work per request | Approach that suffices |
|---|---|
| Up to about 50k segments in the viewport, summed across rows | A bounded window plus the boundary segment, returned raw: under about 150 ms and under about 1 MB gzipped. |
| More segments in the viewport, but each profile under about 200k segments | A, with server-side reduction to the point budget computed on the fly: under about 70 ms per profile. |
| Wide or whole-extent views of profiles with 10^5–10^6 segments or more, across many rows | B: a stored summary pyramid. On-the-fly reduction costs about 0.3 s per 1M-segment profile, so ten rows take seconds. |

The query contract does not need to be invented. The gateway's `/sources/query` already defines one:
`[start, end)`, `fidelity`, `pointBudget`, `before`/`after`, `representation` and `approximate`.
A native `profile_segment` provider can implement it with the windowed SQL that `bench.sh` uses. It
translates offsets with the dataset's time basis, returns `{initial, rate}` faithfully for exact reads, and
reduces for display. That keeps `profile_segment` authoritative and keeps streaming visibility, because a
window over a still-running simulation simply returns what has been written so far.

## 5. When each path makes sense

| Path | When | Notes |
|---|---|---|
| **A. Keep `profile_segment`, add bounded querying** | Now, for every simulation | It covers every dataset measured here for viewport browsing. It needs a windowed read path: a gateway provider or a Hasura query like `profile-window.graphql`, plus reduction. No schema change is needed; the index exists. It also fixes the client cost: the UI stops pulling 100+ MB per dense profile. |
| **B. `profile_segment` stays canonical, plus a read-optimized summary** | Completed simulations whose profiles reach 10^5–10^6+ segments and need fast whole-extent or multi-row overviews | Build it after the simulation succeeds, from the segments. It is derived and rebuildable, keyed by `(dataset_id, profile_id, level, bucket)`, and dropped with the dataset's partitions. Reuse the `source_summary` bucket semantics and the gateway `reduce.ts` code. Until the summary is built (while the simulation runs), fall back to A. |
| **C. Pluggable dataset profile storage with a dense chunk provider** | Only with evidence that storage volume or write cost of simulation results matters. For example, many retained simulations at tens of GB each, or segment writes dominating simulation time. | **Not recommended now.** Nothing measured here needs it. Simulation write was not the bottleneck: 2M segments streamed fine, and spans ran out of memory first. The chunk format would need extending (§1), and every consumer in §2 would need a second code path. |

If chunk storage is ever reused for simulation data:

- **Extract the physical primitive.** That means the chunk and summary encoding, the writer, and the
  windowed reader. Point it at a simulation-owned key such as `(dataset_id, profile_id)`, with its own
  partitions and lifecycle.
- **Do not overload `source_revision` ids or `plan_source`.** Do not register datasets as fake imported
  sources. The revision table's job, lease and publish semantics are wrong for streamed, mutable-until-done
  datasets.

The Analysis resource provider can already hide the physical difference. An imported revision is served by
the `pg_chunks_v1` provider, and a simulation dataset by a native `profile_segment` provider (and later a
summary-backed one), all behind one query contract. Saved views keep binding to logical sources, never to
tables.

## Recommendation

1. **Build A next.** Add a native simulation provider behind the `/sources/query` contract: windowed SQL with
   the boundary segment, on-the-fly reduction, exact reads that keep `{initial, rate}`, and partial results
   while a simulation runs. Move the timeline and Analysis simulation rows to viewport-driven reads, as
   `importedResource.ts` already does. Keep `GET_PROFILE_SINCE` for constraints-sized uses and small
   profiles.
2. **Add B only when a real model's completed simulations exceed the boundary above.** A post-simulation
   summary, derived and disposable.
3. **Do not start C.** Revisit it only with storage or write-cost evidence from real mission models.

## Measured, inferred, and next

- **Measured:** every number in §3 and §4; that simulation profiles stream and survive a later span OOM; that
  the window query uses the existing index.
- **Inferred:** the decision-boundary thresholds, which are extrapolated linearly from per-segment costs; the
  cost of extending the chunk format; and that a gateway provider would add roughly what Hasura adds. The
  gateway's `pg_chunks_v1` path adds 2–6 ms, but a `profile_segment` provider was not built or measured.
- **Not measured:**
  - A real mission model's simulation. Banananation has only 7 resources, and dataset 5 is imported data in
    segment form, not simulation output.
  - Browser-side parse and render cost of large profile payloads.
  - Constraint or scheduler runtime on large datasets.
  - Concurrent readers during a streaming simulation.
  - Same-time segment collisions in practice.
  - Simulations of more than 1M activities, because the worker runs out of memory in span results.
- **Next:**
  - Prototype the native provider (A) and measure it through the gateway on datasets 10, 11 and 5.
  - Profile the browser with a viewport-driven simulation row.
  - Fix the issues found along the way, separately:
    - `resource_profile` uses plan start instead of simulation start.
    - The scheduler reads segments without `order_by`.
    - `ProfileSet.unwrapOptional` throws on gaps.
    - Same-time updates could violate the unique key.
    - Spans are not streamed, which is what caused the 1M-activity OOM.

## How to run

```bash
cd deployment/benchmarks/simulation_profiles
export HASURA_ADMIN_SECRET=...   # pd stack graphql tol
# Optional: make a scratch plan (superuser; fast=1 skips directive triggers, needed above ~10k activities)
psql -h localhost -p 31144 -U postgres_user -d plandev -v n=100000 -v days=365 -v fast=1 -f make-plans.sql
# Simulate it (the action needs a real role and user, not just the admin secret)
curl -s localhost:31140/v1/graphql -H "x-hasura-admin-secret: $HASURA_ADMIN_SECRET" \
  -H 'x-hasura-role: aerie_admin' -H 'x-hasura-user-id: test' -H 'content-type: application/json' \
  -d '{"query":"query{simulate(planId:<id>){simulationDatasetId status}}"}'
# Benchmark one or more datasets (defaults point at the tol stack; RUNS, WINDOWS, PG*, HASURA override)
RUNS=5 WINDOWS="1 day,7 days,30 days" ./bench.sh 8 9 10 11
```

Files:

| File | Purpose |
|---|---|
| `bench.sh` | Runs everything in §3 for each dataset id. |
| `stats.sql` | Shape and on-disk size. |
| `profile-since.graphql` | The UI's whole-profile query. |
| `profile-window.graphql` | The bounded query, expressed in today's Hasura schema. |
| `make-plans.sql` | Builds the scratch plans. |

On dataset 5, the per-profile counts scan 275M rows and take minutes.
