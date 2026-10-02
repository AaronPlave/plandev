# Huge-scale source data: architecture and benchmark

This phase asked one question: can PlanDev ingest a multi-year, TOL-class product once, and then give
interactive timeline browsing over years of it, including exact narrow-window inspection, without hours of
preprocessing and without loading whole resources into the browser?

**Yes, measured on a real product.** The full file (3.46 GB gzipped, 57.3 GB of XML, 275.7 million resource
samples, 4.35 years) ingests in **3.8 minutes** with **≈490 MB** peak memory into **5.4 GB** of Postgres
storage. Its catalog is browseable **0.2 s** after ingest starts. A years-wide row costs the browser at most
the point budget (≈2k points, 26 KB on the wire) and returns in single-digit milliseconds. Exact queries return
the authoritative samples: they matched the raw file in every one of 45 windows checked.

The recommendation is **B: keep PostgreSQL, with a purpose-built chunked time-series schema** (not
`merlin.profile_segment`, not TimescaleDB). The evidence is in the [benchmark](#benchmark) and [storage decision](#storage-decision) sections.

This builds on the Phase 4 Sources work ([`PLAN_CATALOG_AND_SOURCES.md`](PLAN_CATALOG_AND_SOURCES.md)): an
imported source is one more `TimelineSource`, and its layers are ordinary source-bound resource layers.

## Source and revision model

Four tables in `merlin` (`deployment/postgres-init-db/sql/tables/merlin/sources/`, migration 39):

| Table | Meaning |
|---|---|
| `source` | A stable, logical imported product. Needs no plan. |
| `source_revision` | One immutable import of it. It is also the ingest job: `status` (`util_functions.request_status`), `canceled`, `progress`, `heartbeat_at`, `ingest_attempt` (the lease), `error`, `requested_by`. Its data lives in a storage provider named by `storage_kind` and located by `storage_key`. |
| `source_resource` | The revision's resource catalog: key, name, index, category (a TOL subsystem), data type, units, interpolation, value schema, and once ingest finishes, per-resource sample count, coverage and value bounds. |
| `plan_source` | One plan's use of one revision. Its id is what timeline layers bind to (`imported:<id>`). Deleting it never touches the revision. |

`storage_kind`/`storage_key` are the only coupling to physical storage. Saved views persist only
`imported:<plan_source id>` and a resource key: no revision id, dataset id, table or partition name. Hasura
hides `storage_key` and `original_path` from non-admin roles.

## Query contract

`POST /sources/query` on the gateway (`src/packages/sources/`):

```jsonc
{
  "planSourceId": 1,            // or "revisionId"
  "resources": ["key", ...],    // up to 200
  "start": 1893456000000000,    // [start, end), integer µs since the Unix epoch
  "end":   2019686400000000,
  "fidelity": "display",        // or "exact"
  "pointBudget": 2000,          // display: max points per resource
  "reduction": "m4",            // display, numeric: "m4" | "minmax" | "nth"
  "maxSamples": 100000          // exact: page size
}
```

Each result carries `series` (columnar `t`, `v` or `s`, and `k` for kinds: value / valid null / gap),
`before` (the last sample before `start`), `after` (the first sample at or after `end`), `representation`
(`raw` | `summary`), `approximate`, `bucketWidth`, and for exact pages `next`.

- **display** never returns more than `pointBudget` points per resource. When it returns raw, unreduced
  samples it says `approximate: false`, so the client knows it holds the exact data for that window.
- **exact** never reduces. It pages by `maxSamples`, never splitting samples that share a timestamp, so `next`
  is always a valid start for the following page. Following `next` from `start` returns every sample in
  `[start, end)` exactly once. The provider reads only the chunks that page needs (it counts in-window samples:
  the first chunk, which can begin before `start`, is not counted), so a years-wide exact request costs one
  page, not the whole resource.
- `before`/`after` are always present (null at the resource's own coverage edges). That is what lets a step
  or line be drawn continuously across a window edge, and what a window containing no samples draws from.

Authorization is delegated to Hasura: the gateway resolves the `plan_source` or `source_revision` with the
caller's own token, then reads storage as the gateway service user. Responses over 2 KB are gzipped.

**Who can read what (decided, intentional).** Every role (`viewer`, `user`, `aerie_admin`) can select every
`source`, `source_revision`, `source_resource` and `plan_source`, so any signed-in user can query any revision,
by `revisionId` as well as by `planSourceId`. That is PlanDev's existing model: `plan`, `plan_dataset`,
`dataset` and `external_source` are all readable by every role, and only writes are owner-checked. Writes here
follow suit (a source's owner adds revisions; a plan's owner binds them). Restricting reads would need a new
ACL concept PlanDev does not have yet. `sources.auth.test.ts` (gateway) pins this down: no session or a forged
token is 401, a role the session does not hold is 403, an unknown revision is 404, and each role reads by
revision and by plan source.

Nothing in the contract is SQL. A storage provider is a function from `(revision, resources, query)` to
results, keyed by `storage_kind`. A remote MPS/Raven-like service or an object-backed store would be another
provider behind the same endpoint, not another timeline architecture.

## Storage implementation: `pg_chunks_v1`

Two tables, list-partitioned by revision. Each revision is two standalone tables attached on publish:

- `source_chunk`: 1,024 consecutive samples of one resource, as columnar `bytea` (float64 times in µs,
  float64 values or length-prefixed UTF-8 strings, and a per-sample kind byte only when the chunk has a null
  or gap), with `t0`/`t1`. Index `(resource_id, t1)`. Chunks of a resource never overlap, and a chunk never
  splits samples that share a timestamp: it grows past 1,024 instead. So `t1` is unique per resource and an
  exact page can always end on a chunk boundary.
- `source_summary`: a pyramid of bucket summaries per resource, with buckets of 1 s × 4^level. Only
  non-empty buckets are stored. A level is kept only when it reduces the resource at least 32×, and resources
  under 4,096 samples keep none (any read of them is already bounded).

**What a summary bucket keeps.** Summaries are a bounded display approximation; exact queries read the
chunks and are authoritative. Each bucket stores real samples, with times and kinds:

| | numeric | discrete |
|---|---|---|
| first and last sample | ✓ | ✓ |
| minimum and maximum value | ✓ | |
| first null or gap after the first sample (`nonvalue_*`) | ✓ | ✓ |
| first change of state after the first sample (`change_*`) | | ✓ |

So short state changes and breaks stay visible in common cases: `10 → gap → 10` and
`10 → null → 10` still break the line, and `A → B → A`, `A → null → A`, `A → gap → A` and `A → B → gap → A`
still show the brief state and the gap, even though first and last are equal. What is not kept: further
events in the same bucket (`A → B → C → A` shows B, not C; of several separate nulls or gaps only the first
breaks the line), and the exact duration of a brief state,
which is drawn to within one summary bucket (no wider than one output bucket, so about a pixel).

A display query picks, per resource, the coarsest stored level whose bucket is no wider than one output
bucket. It reads only those buckets, plus the chunks holding the window's edges, and reduces their component
samples (the table above; all real samples) to the budget, with the same reduction raw samples get. If no level is fine enough, it reads
raw chunks, unless the window holds over 250k samples, in which case it uses the finest level. Exact reads
raw chunks only.

## Ingest pipeline

```
file ──▶ gunzip + tar (read-ahead thread) ──▶ XML_TOL adapter (StAX) ──▶ importer ──▶ binary COPY ──▶ publish
                                               parse, declare,             validate, chunk,
                                               typed samples               summarize, resort
```

- **Job model.** A revision row is the job. The `source-ingest` worker (Java, `source-ingest/` in this repo)
  claims a pending revision with `FOR UPDATE SKIP LOCKED`, is woken by `pg_notify`, heartbeats progress every
  5 s, honors `canceled`, and records `failed` with an error. A revision whose heartbeat goes stale for 60 s is
  reclaimed by another worker and restarted from scratch.
- **Lease.** Each claim increments `source_revision.ingest_attempt`; that number is the attempt's lease. Every
  transaction that writes the revision or its catalog starts with `merlin.source_ingest_lease(revision,
  attempt)`, which locks the row and fails if a newer attempt has claimed it. The storage functions take the
  attempt and check it themselves. The heartbeat, the failure transition and the final progress update are
  conditioned on it. Each attempt loads into its own tables (`source_chunk_<revision>_<attempt>`, …), so a
  stalled worker that resumes after being reclaimed can only write tables nothing reads: its next heartbeat
  sees the lost lease and stops it, any guarded write fails, and it drops only its own tables. The attempt
  that publishes attaches its own tables. A newer attempt drops an older attempt's leftovers, skipping (not
  waiting on) any a stalled worker still holds. A final heartbeat runs just before publish, so a cancel or
  reclaim from the last interval still stops it. `SourceWorkerIT` covers reclaim (A claims, stalls mid-COPY,
  B reclaims and publishes, A's heartbeat, publish and failure are all refused, B's data is exactly the
  fixture, A's tables are gone), cancellation, and a live attempt not being reclaimed. The worker
  connects as the merlin service user. DDL runs through `security definer` functions
  (`merlin.source_storage_*`), the same way dataset partitions are allocated. This phase runs the worker as a
  CLI (`source-ingest register|work`); containerizing it is packaging, not architecture.
- **Adapter seam.** `SourceAdapter` has `probe`, plus `read(stream, sink)` with `declare`, `manifestComplete`
  and `sample` callbacks. The adapter only parses. Validation, batching, persistence and publication belong to
  `SourceImporter`. One adapter exists: XML_TOL (`TolAdapter`), which keys resources as `Name[Index]…`.
  The contract is declarations first, then samples; a TOL record for a resource its `ResourceMetadata` does
  not declare is an import error (`TOL record references undeclared resource <key>`). The full real product
  ingests cleanly with this check, so nothing it contains needs late declarations.
- **Catalog first.** The manifest is committed before any sample is read, so the Sources browser lists a
  source while it ingests.
- **Bounded memory.** One open chunk plus one open bucket per summary level per resource. Never a whole
  resource or the file (a run of equal timestamps longer than a chunk is the one exception). Peak RSS was
  494 MB for the full product (JVM `-Xmx512m`).
- **Ordering.** Records may arrive in any order and interleaved across resources. In-order resources are
  written in one pass. A resource found out of order is re-sorted at the end through a temporary table by
  (time, arrival order), so duplicate timestamps keep file order. Non-finite numbers become valid nulls and
  are counted (`progress.nonFiniteAsNull`).
- **Publish.** Kept summary levels are copied out of an unlogged staging table, indexes are built, the tables
  are attached as partitions, and the revision flips to `success`, all in one transaction.

Uploading a 57 GB file through the gateway is not viable today (`multer` buffers uploads in memory), so this
phase registers a file already on the server (`original_path`, admin only). `original_file_id` is there for
uploaded files once a streaming or chunked upload exists.

## Benchmark

### Dataset

A real multi-year flight-project TOL (XML_TOL), not a synthetic stand-in. Resource names are omitted here.

| | |
|---|---|
| Input | 3,715,294,751 bytes gzipped tar; 57,316,983,753 bytes of XML |
| Resources | 3,705 (2,567 float, 749 string, 174 boolean, 118 time, 65 integer, 32 duration); 1,006 linear, the rest step |
| Samples | 275,708,601 |
| Coverage | 4.35 years |
| Shape | 173 resources over 500k samples (max 926,649); 394 with 100k–500k; 1,801 with fewer than 100. Peak cadence 31 samples/s in one resource. 741 samples share a timestamp with their predecessor. File is grouped by resource, so it is not time-ordered across resources. |

Environment: Apple M4 Max (16 cores, 48 GB). Postgres 16.14 in Docker (31 GB VM) with stock settings
(`shared_buffers` 128 MB, `work_mem` 4 MB, `max_wal_size` 1 GB, pglz TOAST). Ingest worker, gateway, Postgres
and browser all ran on the same machine.

### Ingest

| | `pg_chunks_v1` | `merlin.profile_segment` (today) |
|---|---:|---:|
| Wall time | **225.6 s** | 1,420.6 s |
| Catalog browseable after | **0.18 s** | n/a (no catalog before data) |
| Client CPU (user) | 248 s | 277 s |
| Client peak RSS | 494 MB | 513 MB |
| Postgres container peak CPU / memory | 116 % / 597 MiB (first run) | 204 % / 4.8 GiB |
| Stored | **5.42 GB** (chunks 4.06 GB incl. TOAST and index; summaries 1.37 GB incl. 250 MB index) | 44.4 GB (33 GB heap, 11 GB index) |
| Bytes per sample | 20 | 161 |
| Stored size vs. XML / vs. gzip input | 0.10× / 1.5× | 0.78× / 12× |
| Fidelity | every sample kept | 741 same-time samples dropped (unique on `(profile, start_offset)`) |

The baseline is the best case for today's schema: the same streaming parser, one binary COPY straight into
the dataset's partition, its existing unique index and trigger in place, one segment per sample with the
existing `{initial, rate}` / discrete / gap encoding.

**Where ingest time goes.** A parse-only pass (gunzip + tar + StAX, no database) takes 180.8 s (1.52M samples/s,
single parser thread). So about four fifths of the 226 s is decompression and XML parsing, and only ≈45 s is
chunking, summarizing, COPY, indexing and publish. Further ingest speedups would come from the parser (e.g.
splitting work by resource block, which this file's layout allows), not from storage.

These are from the re-ingest after the correctness cleanup (lease, richer summaries, chunks that never split a
timestamp). The first run measured 240.8 s, 554 MB and 5.5 GB. The new summary samples did not grow storage:
summaries went from 1,356 MiB to 1,303 MiB (the per-bucket change count they replace was a non-null integer;
the new columns are null in most buckets), and chunks are unchanged at 3,870 MiB.

### Reads

`scripts/bench-sources.mjs` in the gateway. Each scenario ran 5 times at random positions in the coverage,
against the 1, 10, 50 or 100 largest resources, through the full gateway (auth, JSON, gzip), with point budget
2,000 (≈ a 1–2k px timeline). p50/p95 are client-observed. Wire size is gzipped.

| Window | 1 resource | 10 resources | 50 resources | 100 resources |
|---|---|---|---|---|
| 4.4 y | 6 ms · 24 KB · 1,515 pts | 34 ms · 176 KB | 166 ms · 940 KB | 337 ms · 1.9 MB |
| 1 y | 5 ms · 16 KB | 27 ms · 140 KB | 122 ms · 751 KB | 226 ms · 1.5 MB |
| 30 d | 4 ms · 9 KB | 17 ms · 67 KB | 80 ms · 265 KB | 146 ms · 625 KB |
| 7 d | 6 ms · 4 KB (raw) | 19 ms · 22 KB | 79 ms · 150 KB | 127 ms · 189 KB |
| 1 d | 4 ms · 2 KB (raw) | 10 ms · 53 KB | 60 ms · 229 KB | 237 ms · 1.3 MB |
| 1 h – 1 s | 2–3 ms | 6–7 ms | 22–23 ms | 38–61 ms |

(Re-run after the cleanup. Windows are random, so a row varies with where it lands; the first run was in the same
range, e.g. 4.4 y × 100 resources 386 ms.)

- **Bounded.** The largest per-resource response in any display query was 1,967 points (budget 2,000).
  Response size tracks resource count × budget, never resource size.
- Wide windows read summaries. From about a week down, these resources' windows fall under the budget and
  are served raw and complete (`approximate: false`).
- **Exact** (raw, unreduced): 1 resource, 1 s – 1 d windows: p50 2–4 ms. 10 resources, 1 d (2,990 samples):
  7 ms. **Paging** a 1-year exact window of each of the 3 densest resources (174,293 samples each) with
  `maxSamples` 1,000 and 777: 175 and 225 pages at 2.4–3.1 ms per page, concatenation identical to one
  unpaged read, no instant split across pages. These resources sample every couple of minutes, so sub-hour windows mostly carry only the
  `before`/`after` boundary samples.
- **Concurrency** (10 resources, 30-day windows, each client issuing back-to-back queries): 1 client 25 ms
  p50 / 40 q/s; 4 clients 61 ms / 63 q/s; 8 clients 101 ms / 75 q/s; 16 clients 203 ms / 75 q/s. One gateway
  process; the JSON encoding and gzip are on its event loop.
- **Today's path, for comparison.** The UI fetches every `profile_segment` of a resource through Hasura before
  drawing it. For the densest resource (926,646 segments) that is 74 MB of JSON in 3.9 s, before any
  browser-side parsing and sampling. A step resource with 305k samples: 39 MB, 1.2 s. A 30-day window
  query on `profile_segment` is possible (26k segments, 1.7 MB, 42 ms), but it is unbounded: it grows with
  window width and has no overview.

### Exact correctness against the source

An independent Python parser read the raw records of the 9 complete resources in the first 389 MB of the file
(1.96M records). It compared them sample for sample (time, value, null) with exact queries against the full
revision, over 45 random windows from 1 s to 30 days: **22,998 samples, 0 mismatches** (re-run on the
re-ingested revision with the same result).

### Reduction strategies

All strategies return only real samples, ordered by time.

| Strategy | Points per bucket | Behavior |
|---|---|---|
| `m4` (default) | first, min, max, last, + a null/gap | Draws the same pixels as the full line at one bucket per pixel; keeps spikes and breaks. The null/gap kept is the first one after the bucket's first sample, so a bucket that starts with one and has another still breaks inside. |
| `minmax` | min, max, + a null/gap | 3/5 of m4's points per bucket, so finer buckets at the same budget. Loses the entry/exit values of a bucket, which can misdraw slopes between buckets. |
| `nth` | every k-th sample | Cheapest, but drops spikes: a one-sample excursion 10× the signal is lost (unit-tested). Not suitable as a default. |
| discrete | transitions; then per bucket the first and second transitions, the first null/gap and the final state | Dropping repeats changes nothing drawn. When transitions exceed the budget, a brief state (A → B → A) or gap inside a bucket still appears; further events in that bucket may not. 4 points per bucket, so `pointBudget / 4` buckets. |

Summaries keep enough per bucket (see the table above) for any of these to run on the summary pyramid. A future LTTB or state-aware strategy plugs into the same place in `reduce.ts`.

## Timeline interaction

The imported source's resource subscription is viewport-driven (`src/stores/importedResource.ts` in the UI).
A row reports its viewport (`setViewport`), and the subscription:

1. Fetches a whole-coverage **overview** once (2,000 points). It is never replaced, and is what keeps the row
   drawn anywhere while finer data loads, so a row never goes blank.
2. On viewport change, first looks for a **held window** (an 8-entry cache, plus the overview) that covers the
   view at sufficient resolution. A complete (raw) window serves any zoom inside it.
3. Otherwise waits for the viewport to **settle** (150 ms) and requests the view **overscanned** by half its
   width on each side, at 2 points per pixel (cap 8,000).
4. Rejects **stale responses**. Each request has a sequence number, and a response for a viewport the user
   has left is cached but not drawn.
5. Draws overview samples outside the detail window, the detail's boundary samples, then the detail. Every
   element is a real sample, so lines and steps connect across the seam.

Requests from all rows in the same 10 ms batching window (same window and budget) go out as one HTTP request.

Measured in the browser (full product, 10 rows of numeric, step and discrete resources, 1800×1100 window):

- **Adding a resource:** 2 requests (overview + viewport), 6–81 ms each, 29–72 KB of JSON.
- **Zoom from 4.4 years to sub-millisecond** in 75 steps: 7 requests in total. Requests stopped at a 4-day
  window, once the response was raw and complete; every deeper zoom was drawn locally. The line stayed
  continuous at sub-millisecond zoom from the boundary samples.
- **20 rapid pans:** one settled request round. Rows kept drawing throughout.
- **A 170-action pan/zoom session** across 1 day – 2.5 years: 14 HTTP requests (7–10 resources each), latency
  p50 38 ms / p95 118 ms, at most 2,854 points per resource per response, 5.7 MB JSON total. JS heap afterwards
  was 111 MB.
- **Reload:** the saved view restores all 10 rows. The view stores only `imported:1` plus resource keys.

## Correctness tests

| Case | Where |
|---|---|
| step and linear interpolation across a query boundary | UI `importedResource.test.ts`; gateway `sources.pg-chunks.test.ts` |
| valid discrete null vs gap | adapter `TolAdapterTest`; gateway pg-chunks; UI |
| duplicate timestamps (kept, file order, never split by paging) | adapter; gateway pg-chunks and `sources.reduce.test.ts`; UI |
| out-of-order records | adapter; gateway pg-chunks (stored sorted) |
| resource-specific coverage | gateway pg-chunks |
| window containing no values / beginning / ending between samples | gateway pg-chunks; UI |
| display response point-budget bound | gateway reduce (m4, minmax, nth, discrete) and pg-chunks; benchmark (all scenarios) |
| exact bypasses reduction | gateway pg-chunks |
| stale/cancelled viewport response cannot overwrite newer data | UI `stores/importedResource.test.ts` |
| discrete transition preservation | gateway reduce and pg-chunks |
| summary path: numeric gap / null wholly inside a stored bucket; discrete A→B→A, A→null→A, A→gap→A, A→B→gap→A; budget held | source-ingest `SummaryFixtureIT` (what is stored); gateway pg-chunks, summary fixture (what is returned, `representation: summary`); gateway reduce (components) |
| exact paging across chunk boundaries and equal-timestamp runs, every sample once | gateway pg-chunks, summary fixture; benchmark (real data) |
| chunk never splits a timestamp | `SummaryFixtureIT` |
| stale worker reclaimed: no writes, no storage damage; cancellation | source-ingest `SourceWorkerIT` |
| undeclared resource is an import error | adapter `TolAdapterTest` |
| `/sources/query` authorization | gateway `sources.auth.test.ts` |
| gateway auth cache: one resolution per token, role and target | gateway `sources.auth-cache.test.ts` |
| UI batching never mixes sessions | UI `stores/importedResource.test.ts` |

The database tests are skipped unless pointed at a database:

- `source-ingest`: `SOURCES_IT_DB_URL='jdbc:postgresql://…?user=merlin_user&password=…' ./gradlew :source-ingest:test`.
  `SourceWorkerIT` creates and deletes its own source. `SummaryFixtureIT` writes (and replaces) the source
  `it: summary fixture`: a synthetic revision large enough for stored summary levels and multi-chunk
  resources, with events placed inside buckets. It goes through the importer, since TOL has no gap records.
- gateway: `SOURCES_IT_DB=postgres://… SOURCES_IT_REVISION=<edge-cases revision> npm test` runs the pg-chunks
  tests against `edge-cases.tol.xml` ingested through the worker, and against the summary fixture.
  `SOURCES_IT_GATEWAY`, `SOURCES_IT_JWT_KEY` (and optionally `SOURCES_IT_PLAN_SOURCE`) add the authorization
  tests against a running gateway.

These heads have no CI attached. Everything here was run locally, against the `tol` stack with the database
tests enabled: source-ingest 11/11, gateway 52/52 (none skipped), UI 935/935, plus `svelte-check`, eslint
and prettier (gateway eslint: 0 errors). After the final cleanup the read benchmark was rerun on the full
revision with no regression; its windows are random, so single rows vary from run to run (100 resources
× 4.4 y: 304 ms p50; concurrent 30 d × 10 resources: 108 queries/s at 16 clients; most points per resource
1,967).

## Storage decision

**B: keep PostgreSQL, with a different, purpose-built time-series schema (`pg_chunks_v1`).**

- **Not A (`profile_segment` with changes).** It takes 5.9× longer to ingest and 8.1× more space (161 vs 20
  bytes/sample), and it cannot represent same-time samples. Bounded reads would need a summary structure next
  to it anyway; at that point the row-per-segment table is only overhead.
- **Not C (TimescaleDB).** What it would add here, chunked compressed storage and time-bucketed aggregates,
  is what `pg_chunks_v1` already does in about 600 lines of SQL and Java (`source_storage.sql`, `SourceImporter`), with no new extension to ship, upgrade or
  license-check. With this immutable, write-once data, Timescale's main strengths (continuous aggregates over
  appended data, retention policies) do not apply. Revisit it only if sources become live or appended.
- **Not D/E (object-backed or hybrid) yet.** At 5.4 GB per 4-year product, Postgres holds this comfortably,
  and reads are milliseconds. The ceiling is total volume: dozens of such revisions means hundreds of GB in
  the database, its backups and its replicas. At that point move `source_chunk` payloads to object storage
  (same chunk encoding, catalog and summaries stay in Postgres). That is a new `storage_kind`, with no change
  to the query contract or the UI.

## Known limits

- Data becomes visible only when ingest completes (under 4 min here). The catalog is visible at once.
- One parser thread; ingest is parse-bound (≈1.5M samples/s).
- No browser upload for multi-GB files (server-side `original_path`, admin-only). No UI to attach a revision
  to a plan; `plan_source` is created through GraphQL (Hasura permissions allow plan owners) or
  `source-ingest register … <planId>`.
- No UI for exact export (CSV/table). The API supports it (`fidelity: "exact"` + `next` paging).
- The plan's Sources subscription carries the catalog (3,705 rows here), and Hasura re-polls it. That is
  cheap at this size; a one-shot query per immutable revision would be cheaper.
- Gateway caches are per-process maps. The catalog cache is unbounded by count (tiny per revision); auth
  entries are keyed by a SHA-256 digest of the token, not the token, and expired ones are swept once there
  are 1,000.
- A summary bucket shows at most one brief state and one null/gap besides its edges (see above).
- A stalled worker's tables survive until it resumes or the revision is deleted, if it still held them when
  the newer attempt started.
- Narrow windows across 100 resources cost ≈2 ms per resource (several index probes each); fine for dense
  views, and an obvious place to batch further if needed.
- Times are float64 µs on the wire: exact below 2^53 µs (≈285 years from 1970).

## Next step (not started)

A real KPT/TOL adapter (the remaining TOL record types, KPT metadata) → immutable `SourceRevision` →
`pg_chunks_v1` → Sources browser → existing timeline, plus a streaming upload path and a way to attach a
revision to a plan from the UI. Once the same imported source works cleanly in a Plan, build the standalone
Analysis workspace as its second consumer.
