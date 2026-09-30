# Plan Catalog and Sources: implementation note

This is the first production step of the source architecture explored in Spikes 1–3 (`SPIKE_FINDINGS.md`, `SPIKE_2_FINDINGS.md`, `SPIKE_3_FINDINGS.md`). It works on the existing Plan page, with existing entities only:
- Plan;
- SimulationDataset;
- `plan_dataset`;
- External Events.

It adds no tables. The spike code was reverted on both branches and rebuilt, not merged.

**Where it lives:**
- **UI** (`plandev-ui`, branch `claude/hopeful-cannon-cki37d`), after the revert commit:

  | Commit | What it does |
  |---|---|
  | `ccaca02` | Independent fix: spans without directives not drawing |
  | `a7bf149` | Independent fix: real-profile gaps with null dynamics |
  | `c269f5b` | Independent fix: resource-status ID-space collision |
  | `8fac442` | Independent fix: context-menu span time basis |
  | `ef04ab7` | Source model, layer binding and view schema v4 |
  | `b9a2c2f` | Sources browser and the Plan/Sources tabs |
  | `a913046` | Browser wording |

- **Backend** (`plandev`, same branch):
  - `5a1431a7`: `merlin.delete_partitions()` search_path fix (migration 38);
  - `docs/sources/`: this note, the fixture and the screenshots.

## 1. Plan Catalog vs Sources

The left panel is now **Plan & Sources**, with two tabs.

| Tab | Contains | Meaning |
|---|---|---|
| **Plan** → Activity Types | the model's activity types, unchanged, with *Add New Directive* | things the Plan can create |
| **Plan** → Model Resources | `resource_type` rows of the mission model only | things the model declares |
| **Sources** → Plan › Simulation | Resources: profiles *present in the selected simulation dataset*; Simulated Activities: span types *present in its spans*, with counts | data the simulation actually produced |
| **Sources** → External Datasets | one node per `plan_dataset`, listing its profiles | attached external data |
| **Sources** → External Events | linked derivation groups › external sources › event types present in plan bounds, with counts | external events, in their own structure |

Rules the tabs follow:
- **Imported or external types never enter the Plan tab.** Model Resources used to list model resources plus every attached profile name; now it lists model declarations only.
- **Model declarations and simulated data are separate lists.** Model Resources shows what the model declares. Sources › Simulation › Resources shows what the simulation dataset contains, via a new `SUB_SIMULATION_DATASET_PROFILES` subscription.
- **Items from Sources add layers; they never create directives.** Dragging or adding a Sources item creates a layer bound to that source. A Sources item dropped on a row canvas adds a layer instead of opening the directive builder.
- **Upload moved.** External-dataset upload now lives in the Sources tab.

The browser (`SourceBrowser.svelte` / `SourceBrowserTree.svelte`) only renders normalized `SourceBrowserNode`s (`id, label, kind, children, action, badge, tags, tooltip, emptyMessage`). The adapters in `utilities/timelineSources.ts` produce the nodes. The browser has no knowledge of Hasura tables or source kinds.

An item's `action` is `{ typeName: 'activity' | 'resource' | 'externalEvent', item, sourceId }`. Adding one goes through the existing `viewAddFilterToRow` path, with `sourceId` carried in `TimelineItemMetadata`.

## 2. How `plan_dataset` is a source

Each `plan_dataset` row is a source:

```
id:          external-dataset:<dataset_id>        (stable; (plan, dataset) is the PK, dataset id suffices per plan)
label:       Dataset <dataset_id>                  (plan_dataset has no name column — see §8)
description: Plan-level | Tied to the selected simulation (N) | Tied to simulation N, plus offset
resources:   catalog = its profiles; subscribe(name) = createExternalResourceSubscription(..., datasetId)
revisionKey: dataset:<dataset_id>
```

The existing external-profile subscription gained one optional argument, `datasetId`, which restricts the row lookup to that `plan_dataset`. The same name in another dataset, or in the simulation, never satisfies it.

Datasets tied to a *different* simulation are still listed, because they are real, addressable data. The legacy merged namespace hides them, and it still does.

Ownership and lifecycle are unchanged: a dataset is still created, attached and deleted through `plan_dataset`.

## 3. How legacy merged behavior is preserved

**Unbound layers behave exactly as before.** A resource layer with no `sourceId` keeps the old lookup:
- model resource name → simulation profile;
- otherwise → the attached external datasets (sim-tied row, then plan-level, then first).

Its request is keyed `::<name>`, so it never aliases a source-bound request for the same name.

**Old views are not rewritten.** The v3→v4 migration only bumps the version; it deliberately adds no `sourceId`.

**Evidence.** Legacy views (plan 2 views 2 and 3, and plan 1's default view) were rendered on a baseline build (develop plus the four independent fixes) and on this branch:
- all timeline rows are pixel-identical;
- 14 pixels in the header's range-cursor icons differ by at most 21 colour levels;
- a baseline-vs-baseline render differs by 0 pixels, so these 14 are real but sub-pixel anti-aliasing, not data.

## 4. How source-qualified identity is persisted

**Layer shape.** A layer carries `sourceId?: string` at layer level, uniform for resource and activity layers:

```json
{ "chartType": "line", "filter": { "resource": "/battery/soc" } }                                     // legacy: merged lookup
{ "chartType": "line", "filter": { "resource": "/battery/soc" }, "sourceId": "plan" }                 // simulation only
{ "chartType": "line", "filter": { "resource": "/battery/soc" }, "sourceId": "external-dataset:50" }  // one plan_dataset
```

**Schema.**
- View schema **v4** (`ui-view-schema-v4.json`) adds `sourceId` to activity, line and x-range layers; v3 is untouched.
- New views save with `version: 4`.
- Tests:
  - v1 and v3 views migrate to v4 with no `sourceId`;
  - a v4 view with bound and unbound layers side by side validates.

**Identity in memory.** The in-memory identity is always *(source, name)*:
- Row request keys: `getResourceRequestKey(sourceId, name)`.
- Loaded resources are tagged with their `sourceId`, so `getResourceForLayer` matches on name *and* source. The tag lives on the timeline's sampled `Resource` view model, never on a DB entity.

**Where the source is shown.** Legends and tooltips name the source (`/battery/soc · Dataset 50`, `Source: External Datasets · Dataset 50`). New source-bound layers put the source in their axis label.

**Missing sources.** A layer bound to a source not in the registry shows `Source "external-dataset:999" is not available in this plan`. It is never rebound to another source with the same name. While `plan_dataset` is still loading, a missing source shows as loading, not as an error.

## 5. External Events in the Sources browser

External Events have one adapter, `createExternalEventsSource`, which reads the existing stores:
- `planDerivationGroupLinks`;
- `derivationGroups`;
- `selectedExternalEvents`;
- `derivationGroupVisibilityMap`;
- `derivationGroupsAcknowledged`;
- `externalEventTypes`.

It builds this tree:

```
External Events
└─ <linked derivation group>   tags: source type, "hidden" (visibility off for this plan), "updated" (unacknowledged)
   └─ <external source key>    all sources of the group, even with no events in plan bounds
      └─ <event type> (count)  → adds an ordinary external-event layer: filter.externalEvent.static_types = [type]
```

**Unchanged in the backend.** No backend or domain change. These all stay where they were:
- schemas;
- source keys;
- derivation groups;
- derived events and their refresh;
- plan links;
- acknowledgement;
- visibility.

Event identity stays the existing pkey (derivation group, source key, type, key), and the source's only capability is `events`.

**Known gap.** The existing event-layer filter has no derivation-group or source dimension. A layer added from *DSN Passes › dsn_week1.json › Pass* shows every Pass event in every visible linked group (it showed `pass-3` from `dsn_week2.json` too). That is today's semantics, preserved on purpose. Scoping a layer to one group or source would need a filter extension (for example a layer `sourceId` of `external-events:<group>`), which is left for later.

## 6. Capabilities

| Source | id | resources | intervals | events |
|---|---|---|---|---|
| Plan · Simulation | `plan` | ✓ simulated profiles; `revisionKey = simulation-dataset:<id>` | ✓ catalog = model activity types; `present` = span types; `hasDirectives` | – |
| External dataset | `external-dataset:<id>` | ✓ its profiles | – (no activity layer offered) | – |
| External Events | `external-events` | – | – | ✓ event types present |

**Resource capability.** The `resources` capability is `{catalog, loading, revisionKey, subscribe(name, context), unavailableReason?}`. A row restarts a request only when its `revisionKey` changes.

The Plan source subscribes from the simulation dataset it was built from, so its data always matches its `revisionKey`. The first version used the Row's prop instead, and a view reloaded while the dataset loaded never recovered; this was caught in verification and fixed.

**Plan resources without results.** Without simulation results, a layer bound to Plan resources gets "The plan has no simulation results".

**Activity layers.** They resolve to `plan` when unbound. A layer bound to a source without intervals shows `Source "Dataset 50" has no activities`, and its filter is never applied to Plan data. The Plan activity layer keeps using the existing `ActivityFilterBuilder` and the directive + span path.

## 7. Remaining Plan-specific assumptions

1. **Intervals come only from the Plan.** `Row` keeps the single existing directive + span pass, now over `planActivityLayers`. The per-source interval pass, source-qualified span keys and hierarchy from Spike 3 are not productionized, because no non-Plan interval source exists yet.
   - **Selection** stays `selectedSpanId`. No `selectedIntervalRef` bridge ships, since nothing would consume it; the design for it is in §8.
   - Spans are not stamped with a source.
2. **The context menu** still resolves spans through the Plan `spansMap` by id. Its time basis is fixed independently (it uses the span's drawn `startMs`/`endMs`).
3. **Legacy resource layers** need a simulation dataset and model resource types before they load, exactly as before. Source-bound external layers do not.
4. **The registry is Plan-page scoped.** It is built from plan-scoped stores, and sources are implicit, one per existing association; there are no persisted bindings. `external-dataset:<id>` is only stable because `(plan_id, dataset_id)` is the key.
5. **`plan_dataset` has no name**, so labels are `Dataset <id>`.
6. **External events** are loaded only for linked derivation groups within plan bounds (the existing subscription).
7. **The Tooltip** gets model resource types for legacy layers and source catalogs for bound layers.

## 8. What is needed next

**Imported KPT/APGen products**
- Backend: `source_artifact` (the product) and `source_revision` (an immutable data revision, owning a `merlin.dataset` for profiles and spans). This is the standalone-dataset idea from Spike 1, with explicit revisions.
- A source adapter per revision kind:
  - KPT offers resources;
  - APGen offers resources and intervals, using the Spike 3 per-source interval pass, source-qualified span keys, per-source tree and imported-interval details.
- The same browser. It needs no changes: new adapters emit `SourceBrowserNode`s.
- Interval selection: `IntervalRef {sourceId, intervalId}`. Plan spans still write `selectedSpanId`; others write a per-source ref, with one derived `selectedIntervalRef`.

**Persistent source revisions / bindings**
- A binding row per (plan or analysis, slot) pointing at an artifact, plus a revision policy (pinned revision, or "latest").
- The registry then resolves slot → artifact → revision. Today it builds sources from implicit associations.
- Views keep storing only the slot id, which is `sourceId` today. Rebinding to another revision is then a binding change, with no view edit (demonstrated in Spike 3 with URL bindings).
- Needed UI actions: *Replace Source*, *Update Source*, *Remove from View*.

**Planless Analysis page**
- A registry built from persisted bindings instead of plan stores, where the Plan simulation is just one optional source.
- A time range not derived from a plan.
- Layers already carry `sourceId`, and legacy resolution already lives in one place (`resolveResourceLayerSource` / `resolveActivityLayerSourceId`). The remaining Plan couplings are in §7 and in `SPIKE_FINDINGS.md`: the view store, time display, and directive creation on drop.

**Also open**
- External-event layers scoped per derivation group or source (§5).
- A name for `plan_dataset` (for example captured from the upload file name).

## Verification

Run on the local stack with plan 2 and `docs/sources/sources_fixture.sql` loaded:
- Dataset A (50), plan-level: `/battery/soc` ramping 90→30 %, plus `/thermal/panel`.
- Dataset B (51), tied to the selected simulation: `/battery/soc` at 55 %.
- Derivation groups: *DSN Passes* (2 sources) and *Eclipses*.

Tested with scripted Chromium runs. The screenshots are in `img/`.

| Check | Result |
|---|---|
| Plan tab: Activity Types / Model Resources; *Add New Directive* opens the directive builder (`01`) | pass |
| Legacy views (plan 2 views 2 and 3, plan 1 default) vs baseline build | rows pixel-identical (§3) |
| Sources tree: Simulation (2 resources, OBSERVE 2 / SLEW 2), Datasets 50 and 51, derivation groups › sources › types with counts, *hidden* and *updated* tags (`02`) | pass |
| Plan `/battery/soc`, Dataset 50 `/battery/soc` and Dataset 51 `/battery/soc`, plus the legacy layer, in one row with independent axes and labelled legends; tooltip lists each with its source and value (65 / 90 / 55 %) (`04`, `06`) | pass |
| Editor Source control. Catalog follows the source: Dataset 51 → [/battery/soc], Plan → [/battery/soc, /power/load], legacy → all three names. Switching Dataset 51 → 50 keeps `/battery/soc`; `/thermal/panel` → Dataset 51 clears the resource, since 51 has none (`07`) | pass |
| Plan activity layer from Sources: `sourceId: plan`, existing ActivityFilterBuilder; dropping Sources SLEW on the row canvas extends the layer and creates no directive (`08`) | pass |
| External event layers from Sources render through the existing path and filter builder (`09`, `14`) | pass |
| Save as a new view, then reload: a v4 definition with the legacy layer, 3 bound resource layers, a bound `/thermal/panel`, the Plan activity layer and 2 event layers; all restore | pass |
| Missing source `external-dataset:999` → unavailable message; activity layer bound to Dataset 50 → "has no activities"; no rebinding (`10`) | pass |
| `merlin.delete_partitions()` with no `merlin` on search_path: before the fix, 3 partitions leak; after, 0 | pass |
| vitest: 70 files, 891 tests; includes 10 new source tests, v4 schema/migration tests and new `getResourceForLayer` cases | pass |
| svelte-check 0 errors / 0 warnings; eslint and prettier clean | pass |

**Not verified:**
- the UI e2e suite (it needs merlin-server);
- scheduling and constraints runs, since neither code path was touched;
- live-streaming simulation profiles into a bound Plan layer;
- a plan with no `plan_dataset` rows at all; the empty-state message was checked on plan 1's empty External Events group instead.
