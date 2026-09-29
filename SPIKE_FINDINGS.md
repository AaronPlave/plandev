# Spike 1: Standalone `merlin.dataset` on the PlanDev timeline: findings

**Result: it works, and the seam is small.** A standalone `merlin.dataset` opens at `/datasets/:id` with no Plan, mission model, or simulation dataset. The page:

- lists resources taken from `profile.type.schema`;
- draws real and discrete profiles, with gaps and valid nulls shown differently;
- draws spans grouped by `span.type`;
- lets you configure the timeline with the real `TimelineEditorPanel`;
- keeps that configuration across a reload.

The timeline renderer itself did not need rewriting. Nearly every coupling found was *accidental*: a component reading a Plan- or model-flavoured global store for data that is generic in shape.

| | Branch |
|---|---|
| Backend | `AaronPlave/plandev` @ `claude/hopeful-cannon-cki37d` (from `develop`) |
| UI | `AaronPlave/plandev-ui` @ `claude/hopeful-cannon-cki37d` (from `NASA-AMMOS/plandev-ui` `develop` @ `5520951`, v4.4.0) |

All spike code is marked `SPIKE`.

---

## 1. What was built

### Backend (plandev)

- **`merlin.standalone_dataset`** (`id, name, dataset_id, start_time, end_time`). This is spike terminology.
  - **Ownership of the dataset:**
    - On insert, the wrapper allocates its own `merlin.dataset`. Partitions are created by the existing dataset trigger.
    - Deleting the wrapper deletes its dataset through an explicit `AFTER DELETE` trigger. This mirrors `simulation_dataset`.
    - Deleting the dataset directly removes the wrapper through the FK's `ON DELETE CASCADE`. The wrapper's trigger then finds nothing left to delete, so nothing is deleted twice.
  - **Guards on `dataset_id`:**
    - It cannot be changed after insert.
    - The wrapper cannot adopt a dataset that a `simulation_dataset` or `plan_dataset` already owns. Otherwise two owners would both try to delete it.
  - **Other constraints:** `end_time >= start_time` is enforced. There is no owner column; see §8.
- **Where it lives:**
  - `deployment/postgres-init-db/sql/tables/merlin/dataset/standalone_dataset.sql`, included from `init_merlin.sql`.
  - Migration `deployment/hasura/migrations/PlanDev/38_spike_standalone_dataset/` (up/down).
  - Hasura metadata: reads for every role, writes for admin only.
- **Migration number:** I picked **38**, the next contiguous number. `plandev_db_migration.py` rejects gaps, so no truly branch-safe number exists. Four in-flight upstream branches also claim 38:
  - `38_mission_model_executable` (NEP ×3)
  - `38_declared_mission_model` (run-transfer-v0)
  - `38_external_event_derivation_scaling`

  Renumber when rebasing.
- **Fixture** (`deployment/spike/standalone_dataset_fixture.sql`) covers 2029-001 to 2029-003:
  - `/power/load`: real, unit W, with a gap.
  - `/battery/soc`: real, unit %.
  - `/battery/mode`: discrete variant, with **both** a valid null (`dynamics = 'null'::jsonb, is_gap = false`) and a gap (`dynamics = 'null'::jsonb, is_gap = true`, which is exactly how Merlin's `PostProfileSegmentsAction` writes gaps). `is_gap` is the only thing that tells them apart.
  - Six spans: OBSERVE, DOWNLINK, SLEW. One SLEW is a child of an OBSERVE. There are no `activity_type` rows.
- **Tests:**
  - `db-tests/.../StandaloneDatasetTests.java`: 9 tests.
  - `deployment/spike/standalone_dataset_lifecycle_check.sql`: a psql-only equivalent that rolls back.

### UI (plandev-ui)

- **The seam: `TimelineResourceProvider`** (`src/types/timelineSource.ts`).

  ```ts
  interface TimelineResourceProvider {
    readonly key: string;                                  // source identity; change => rows resubscribe
    subscribeResource(name: string, range?: TimeRange): TimelineResourceSubscription;
  }
  ```

  `range` is in the contract but ignored; every fetch pulls the whole profile.
- **`Row.svelte`** no longer decides *plan → active sim → internal vs external*. It asks `resourceProvider.subscribeResource(name)` and resubscribes when `key` changes. Net change: −12 lines (+23 −35).
- **Two providers** (`src/utilities/timelineResourceProviders.ts`):
  - `createPlanTimelineResourceProvider`: the old `Row.svelte` logic moved over **unchanged** (model resource type → sim profile, otherwise `plan_dataset` profile). `TimelinePanel` builds it with the same gating (no sim dataset → no provider; keep the current one while model resource types load).
  - `createStandaloneTimelineResourceProvider`: knows only `dataset_id` and `start_time`. It **reuses `createProfileSubscription` unchanged**, because that fetch is already keyed only by `(dataset_id, name)`.
- **A catalog context** (`src/stores/timelineSourceCatalog.ts`). This is the second, smaller seam. `setContext`/`getContext` supplies `{ resourceTypes, intervalTypes, spans, maxTimeRange }` to editor components that otherwise read mission-model or plan globals:
  - `TimelineLayerEditor` (resource dropdown);
  - `ActivityFilterBuilder` (type pickers, subsystem tags, instance counts);
  - `TimelineEditorPanel` (guide date bounds);
  - `Row` (type metadata for dynamic filters).

  The plan page sets no context, so each consumer falls back to its original store.
- **`/datasets/[id]`**, made of:
  - `StandaloneDatasetTimelinePanel`: the plan-free sibling of `TimelinePanel`, wrapping the same `Timeline.svelte`;
  - `StandaloneTimelineItemsPanel`: `TimelineItemList` for resources and intervals, with no upload or create;
  - the real `TimelineEditorPanel`;
  - a "Selected Interval" panel with raw attributes plus the reused `ActivitySpanForm`.
- **Persistence:** localStorage only. The page synthesizes a `View` (id −1) and uses the normal `view`, `viewIsModified`, and `resetView` stores. Save / Revert / Reset to Default. There is **no dataset→view relationship**.
- **Spike 1c:** `?intervalDescriptors=demo` enriches the derived interval types with `IntervalTypeDescriptor`s (description, subsystem, parameters, computed attributes). Nothing is persisted for this.

### How to run

```sh
psql "$PLANDEV_DB_URL" -f deployment/spike/standalone_dataset_fixture.sql   # prints the new id
# UI: http://localhost:3000/datasets/<id>           (1b: types from span.type only)
#     http://localhost:3000/datasets/<id>?intervalDescriptors=demo   (1c)
```

---

## 2. Verification performed

The stack was run locally in this environment:
- Postgres and Hasura in Docker, using the base images. The CVE-patch `apt-get` layer can't be built here.
- The gateway from `plandev-gateway` source with `AUTH_TYPE=none`.
- The UI dev server.
- merlin-server and the workers were **not** running.

The UI was driven with Playwright against the real backend.

| Check | Result |
|---|---|
| DB tests `StandaloneDatasetTests` (9) | **pass, 0 skipped.** Needed a local-only Gradle init script pointing at Google's Maven Central mirror because Central returned 429; nothing committed. |
| Lifecycle checks on the dev DB and on a fresh `init.sql` DB | pass |
| Migration `up.sql` on an existing DB; `down.sql` → `up.sql` round trip | pass. Down removes the wrappers, their datasets, and all partitions. |
| Hasura metadata consistent; `standalone_dataset` + profiles + spans readable as `viewer` | pass |
| No `simulation_notification`; no plan/model/sim/`resource_type`/`activity_type` rows needed | pass |
| UI `svelte-check`, eslint, prettier on changed files | clean |
| UI unit tests (`vitest run`) | **878 passed, 0 failed** (includes a new `sampleProfiles` test) |
| Standalone: page loads (no plan loaded), absolute 2029 UTC/DOY axis and coverage header | pass |
| Standalone: resource catalog from profiles (`/power/load (real • W)`, …) | pass |
| Standalone: real line, discrete x-range, **gap (hatched) vs valid null (blank)**, two y-axes in one row | pass |
| Standalone: add row from list, add second layer to row, rename/height via editor, delete row (+ confirm), Revert | pass |
| Standalone: zoom via keyboard; axis ticks update | pass |
| Standalone: Save → reload → same rows restored | pass |
| Standalone: spans render and group by `span.type`; hover tooltip; click-select → details; filter-by-type row; filter builder shows types/instance counts | pass |
| 1c: subsystem filter in list; **dynamic Subsystem filter row renders only matching spans**; `ActivitySpanForm` shows typed parameters | pass |
| **Plan-page regression.** Plan + sim dataset seeded in SQL; baseline run on unmodified upstream vs spike branch: sim-internal profile renders, external `plan_dataset` profile added from list renders, no errors | same behavior on both, except the `hasActivityLayer` bug fix (§6) |

Not verified:
- The UI e2e suite. It needs merlin-server and a model jar, which can't be built here.
- Live-streaming simulation profiles on the plan page. The provider passes through the same `createProfileSubscription`, but I didn't exercise it.

---

## 3. Dependency classification

Categories:
- **Intrinsic Plan**: needs a plan because it *is* planning (directives, plan permissions, plan-linked events).
- **Accidental Plan**: reads plan- or model-named state but needs only generic data.
- **Intrinsic Sim** / **Accidental Sim**: the same split for the simulation dataset.
- **Generic**: a timeline concern with no plan or simulation dependency.

| Component | Intrinsic Plan | Accidental Plan | Intrinsic Sim | Accidental Sim | Generic |
|---|---|---|---|---|---|
| **Timeline.svelte** | directive build on drop; `$planDerivationGroupLinks` filter for external events | `TimelineTimeDisplay` gated on `plan` (only needs `maxTimeRange`; spike adds `showTimeDisplay`); `viewAddTimelineRow`/`viewUpdateTimeline` hard-wired to the global view store | — | `TimelineSimulationRange` and histogram take `simulationDataset` (null is fine) | axis, zoom/pan, cursors, guides, rows DnD, tooltip, context menu |
| **TimelinePanel.svelte** | directive delete/select, permissions from `$plan` | builds everything from globals; only thin wiring (spike duplicates it in about 190 lines) | — | constraint results, `$spans`, `$simulationDataset` | — |
| **Row.svelte** (before) | directive creation on drop (`plan`, `$planModelActivityTypes`) | **resource resolution required `plan` + `simulationDataset` + `$resourceTypes`**; dynamic filters used `$planModelActivityTypes` | — | "internal vs external" choice keyed on the sim dataset | layer drawing, discrete tree, y-axes |
| **Row.svelte** (after) | directive creation on drop only | — | — | — | asks a provider; filter type metadata from catalog context |
| **TimelineEditorPanel** | — | `maxTimeRange` derived from the plan (only for guide DatePicker bounds) | — | — | everything else; works unchanged against a synthesized view |
| **TimelineLayerEditor** | — | resource dropdown = `$resourceTypes` (model) + `$externalResourceNames` | — | — | layer editing |
| **ActivityFilterBuilder** | — | type pickers/subsystems from `$planModelActivityTypes`; instance counts from global `$spans` | — | — | filter logic |
| **ResourceList** | upload (plan permission, associate with sim) | reads `$allResourceTypes` and `$plan` | — | "Use selected simulation" upload option | — (spike bypasses with `TimelineItemList`) |
| **TimelineItemList** | "Add New Directive" button (shown disabled) | assumes a view exists (`timelines[0].rows` throws without one) | — | — | search, filter, layer picker, drag |
| **ActivityList** | directive create/upload | items = `$planModelActivityTypes` | — | — | — (spike feeds `TimelineItemList` directly) |
| **ActivitySpanForm** | — | arguments shown **only** via the type's declared `parameters` | "Simulation Status", "Sequencing" section; calls `getExpansionSequenceId(span, -1)` | — | definition, times, decomposition from span hierarchy |
| **TimelineTooltip** | — | — | — | labels spans "Simulated Activity (Span)" | hover values |
| **TimelineViewControls** | "jump to selection" uses `$selectedActivityDirective`/`$plan`; link copy writes plan params | uses global `$selectedSpan` (standalone selection is local, so jump is a no-op) | — | — | zoom, shift, reset, decimation toggles |
| **views store** | — | field name `definition.plan.*`; **global singleton** (`view`, `selectedRow`, `selectedTimelineId`) | — | — | all row/layer/axis/guide mutation helpers |
| **simulation store** | — | `resourceTypes` (model-sourced, generically typed); `yAxesWithScaleDomainsCache` is a global keyed by row id | `simulation*`, status, templates | `allResourceTypes` mixes model + plan datasets for the *active sim* | — |
| **plan store** | the plan itself | `viewTimeRange` (a generic writable living in plan.ts); `maxTimeRange` derived from plan bounds; `planModelActivityTypes`, `subsystemTags` | — | — | — |
| **profile.ts `createProfileSubscription`** | — | — | — | liveness: re-fetches on global `simulationDataset` ticks; "not found in simulation dataset" message | fetch by `(dataset_id, name)` + `sampleProfiles(start)` |
| **effects.getSpans** | — | parameter named `planStartTimeYmd` | — | log says "simulation ID=" | fetch by `dataset_id`, offsets vs any start |

---

## 4. Resource path

```
before:
Row
 → requires plan && simulationDataset && !$resourceTypesLoading
 → isExternal = name ∉ $resourceTypes (mission model)
 → external: createExternalResourceSubscription(simulationDataset.id, name, plan.start_time)   (plan_dataset rows)
   internal: createProfileSubscription(simulationDataset.dataset_id, name, sim start ?? plan start)
 → profile

after:
Row → resourceProvider.subscribeResource(name)        (re-subscribe when provider.key changes)
  plan page:        PlanTimelineResourceProvider      → same two branches as before (moved, not changed)
  standalone page:  StandaloneTimelineResourceProvider → createProfileSubscription(dataset_id, name, standalone.start_time)
```

The provider needed **one** thing besides `subscribeResource`: a `key` for invalidation, which replaces the old `simulationDatasetId` comparison.

Reusing `createProfileSubscription` was possible because its fetch has no plan or simulation dependency; only its *liveness* does. For Spike 2, a second instance of the same resource name needs a source-qualified key. Today the rows' `resourceRequestMap` and `timelineResourceStatus` are keyed by `(datasetId, name)`, which is already close.

---

## 5. Activity / span path

**Works with only `span.type`, timing, `parent_id`, and `attributes`:**
- draw;
- group by type (the grouped tree);
- hierarchy/decomposition (from `parent_id` via `createSpanUtilityMaps`);
- hover tooltip;
- click-select;
- static type filters (`static_types` match `span.type` strings);
- "filter by time window";
- instance counts in the filter builder;
- raw attribute display.

**The minimal catalog** is `getIntervalTypesFromSpans`: distinct `span.type` values, wrapped as `ActivityType` with empty `parameters`. The wrapping is needed only because the list and filter UI consume `ActivityType`.

**Needs richer type declarations (enrichment, not rendering):**
- **Subsystem** filters. `ActivityType.subsystem_tag` is a `tags`-table row (numeric id, owner, created_at), so a descriptor's plain `subsystem: "Science"` must become a **synthetic Tag** (negative id). Saved views then store `Subsystem includes [-2]`, which depends on tag identity rather than a stable name.
- **Parameter/argument** display and parameter-aware filters. `ActivitySpanForm` shows *nothing* from `attributes.arguments` unless the type declares `parameters`.
- Computed attributes display (needs `computed_attributes_value_schema`).
- Description.

**Requires things a standalone source doesn't have:**
- Directive composition ("Directives / Simulated / Both"; `activityDirectivesMap` must be non-null: the page passes `{}`).
- Directive creation from the list or by drag.
- Expansion sequences.
- "Simulation Status".

**`planModelActivityTypes` can't simply be fed.** It is a gql subscription keyed on `modelId`, so it re-queries with `-1` and overwrites anything injected. That's why the catalog context exists.

---

## 6. Pre-existing bugs found (fixed on the branch where small)

1. **Spans with no directives never drew** (`Row.svelte`): `hasActivityLayer = directives.length > 0 || directives.length > 0`. **Fixed.** This affects the plan page too: a baseline run on upstream shows an empty "Activities by Type" row for a sim span with no directive, and the branch shows it.
2. **Real-profile gaps crash sampling** (`sampleProfiles`): it reads `dynamics.initial` for `is_gap` segments whose dynamics are `null`, which is how Merlin writes gaps. The row stays on "Loading…" forever and a page error is thrown. **Fixed** (gap → `y: null`, which `LayerLine` already skips); a test is added. Existing tests only built real gaps *with* dynamics.
3. **`merlin.delete_partitions()` uses unqualified table names** (`drop table if exists profile_segment_<id>`). Partition cleanup only works when `merlin` is on the caller's `search_path`. Hasura's connection string includes it; a plain psql or JDBC session doesn't, so partitions leak silently (`NOTICE ... does not exist, skipping`). This affects simulation datasets too. **Not fixed** (core dataset code); the tests set `search_path` explicitly.
4. `TimelineItemList` throws if no view is loaded yet. The standalone page gates on `$view`. Not fixed.

---

## 7. View / editor path

`view.definition.plan.timelines` is **mostly naming debt**. The whole editor worked against a synthesized `View` with no schema change:
- `generateDefaultView()` output;
- `id: -1`;
- stored in localStorage;
- migrated with `applyViewMigrations` on load.

The deeper couplings are structural, not the field name:
- **Global singletons.** `view`, `selectedRowId`, `selectedTimelineId`, `viewTimeRange`, and `yAxesWithScaleDomainsCache` are module-level stores. One page means one view. The plan page and the standalone page share them (the standalone page resets them on destroy). Spike 2 needing two sources in *one* view is fine; two independent timelines on one screen are not.
- **The view is a whole-page layout,** not a timeline configuration. `grid`, `activityDirectivesTable`, `simulationEventsTable`, and `iFrames` travel with it. `viewTogglePanel` and `GridMenu` mutate `definition.plan.grid` even on the standalone page (harmless).
- **Layers bind resources by bare name** (`filter.resource: '/battery/soc'`). There is no source qualifier. This is the real blocker for Spike 2's same-name overlay, and it lives in `types/timeline.ts`, not in the `plan` key.
- **Subsystem filters persist tag ids** (§5).
- **Persistence:** `ui.view` itself has no plan FK, so it *could* be reused. I used localStorage as directed, to avoid implying any dataset→view relationship.

---

## 8. Temporary coupling and workarounds

- A synthesized `View` under `definition.plan`, id −1, in localStorage (key `plandev.spike.standaloneDataset.<id>.view`).
- `StandaloneDatasetTimelinePanel` duplicates about 190 lines of `TimelinePanel` wiring.
- The standalone page writes the global `viewTimeRange`, `view`, and `selectedRowId`, and resets them on destroy.
- `Timeline.svelte` gets `activityDirectivesMap={{}}`, `plan={null}`, and `planStartTimeYmd = standalone.start_time`. That prop is only used as a time origin, despite its name.
- Interval types are cast to `ActivityType`. Subsystems become synthetic negative-id Tags.
- Descriptors for 1c are hard-coded demo data enabled by a query param.
- **Permissions:** writes to `standalone_dataset` are admin-only (Hasura) and reads are open, matching `merlin.dataset`/`profile`/`span`. There is no owner column, because reads didn't need one. A real feature needs ownership or collaborators if non-admins may create or delete sources.
- There is no UI to create or delete a standalone dataset, and no link to one from navigation.

---

## 9. Answers to the spike questions

1. **Can `merlin.dataset` serve as physical storage for standalone products?** Yes.
   - Partitioning, triggers, and profile/span/event semantics have no plan or simulation dependency.
   - The only lifecycle work was an owner wrapper, the same pattern `simulation_dataset` already uses.
   - One caveat: partition cleanup depends on `search_path` (§6.3). That's a pre-existing bug, not a blocker.
2. **Minimum metadata around a dataset?** An absolute start time (the offset origin), coverage end or bounds, a display name, and an owner record that controls deletion. Nothing else was needed to render.
3. **Can resource schemas come entirely from `profile.type.schema`?** Yes. The list, data-type filter, units in labels and axes, line vs x-range choice, and variant colouring all worked from the profile schema alone.
4. **What truly requires a Plan?** Directives: creation, drag-to-create, directive composition, and permissions. Plan-linked external events (derivation groups). Plan-level upload and permissions. Rendering, configuring, and saving did not.
5. **What truly requires a SimulationDataset?** Only simulation-specific UX:
   - the sim-range overlay;
   - simulation status;
   - expansion sequences;
   - *live* profile streaming.

   Everything else accepted `null`. The sim-internal vs external decision is a Plan-provider concern.
6. **Can spans render without mission-model activity types?** Yes: draw, group, hierarchy, hover, select, and filter by type. This needed one pre-existing bug fix (§6.1), which also affects the plan page.
7. **What activity UX needs richer declarations?** Subsystem filters, parameter filters, argument display in the span form, computed attributes, and descriptions. A source-supplied descriptor fed through the same `ActivityType` shape drives all of these (1c), except that subsystem-as-tag-id is awkward.
8. **Is a small provider enough to decouple resource loading?** Yes. The interface is `{ key, subscribeResource(name, range?) }`: two providers, and `Row.svelte` got smaller. A second, equally small seam, a catalog context, was needed for *editor* components that read type metadata.
9. **How hard is reusing TimelineEditor/View without a Plan?** Easy. It needed three context-fallback lines in three editor files plus a synthesized `View`. The hard parts are structural (global singletons, whole-page view, bare resource names), not the `plan` key.
10. **Does the architecture still look viable?** Yes. The `TimelineSource` idea (bounds + catalog + resources + intervals) maps directly onto what was needed:
    - bounds → `maxTimeRange`;
    - catalog → the catalog context;
    - resources → the provider;
    - intervals → spans passed as props.

    The plan page already fits it with a thin adapter.

## 10. Implications for Spike 2 (multi-source overlay)

- **Source-qualified resource identity in layers.** Layers bind resources by bare name today (`filter.resource: string`), so `/battery/soc` from A and from B collide. This is the first schema change needed.
- **Row-level providers.** Today the provider is per timeline. Rows would need a provider *registry* keyed by source, with `layer.filter.source → provider`. The `key` field already exists for invalidation.
- **Per-source catalogs** (the context would hold a map, not a single catalog), and per-source time origins. Each provider already owns its origin.
- **Per-source span/interval stores.** Spans are still a single `spans`/`spansMap` prop into `Timeline.svelte`.
