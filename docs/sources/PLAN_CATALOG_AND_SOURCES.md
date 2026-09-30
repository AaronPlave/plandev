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
  | `68e1675` | Phase 4 fix: external-event layers keep the scope of the Sources leaf (§5); per-group loading |
  | `8619ba6` | Phase 4 fix: rebinding a resource layer re-derives its presentation (§4) |
  | `3deee3a` | Phase 4 fix: new resource layers are always source-bound (§3) |
  | `255a15e` | Phase 4 cleanup: horizontal guides during resource rebinding (§4) |
  | `9a20711` | Phase 4 cleanup: event row names include the derivation group (§5) |

- **Backend** (`plandev`, same branch):
  - `5a1431a7`: `merlin.delete_partitions()` search_path fix (migration 38);
  - `docs/sources/`: this note, the fixture and the screenshots.

## 1. Plan Catalog vs Sources

The left panel is now **Plan & Sources**, with two tabs.

| Tab | Contains | Meaning |
|---|---|---|
| **Plan** → Activity Types | the model's activity types, unchanged, with *Add New Directive* | things the Plan can create |
| **Plan** → Model Resources | `resource_type` rows of the mission model only; layers created here bind to `plan` | things the model declares |
| **Sources** → Plan › Simulation | Resources: profiles *present in the selected simulation dataset*; Simulated Activities: span types *present in its spans*, with counts | data the simulation actually produced |
| **Sources** → External Datasets | one node per `plan_dataset`, listing its profiles | attached external data |
| **Sources** → External Events | linked derivation groups › external sources › event types present in plan bounds, with counts | external events, in their own structure |

Rules the tabs follow:
- **Imported or external types never enter the Plan tab.** Model Resources used to list model resources plus every attached profile name; now it lists model declarations only.
- **Model declarations and simulated data are separate lists.** Model Resources shows what the model declares. Sources › Simulation › Resources shows what the simulation dataset contains, via a new `SUB_SIMULATION_DATASET_PROFILES` subscription.
- **Items from Sources add layers; they never create directives.** Dragging or adding a Sources item creates a layer bound to that source. A Sources item dropped on a row canvas adds a layer instead of opening the directive builder.
- **Upload moved.** External-dataset upload now lives in the Sources tab.

The browser (`SourceBrowser.svelte` / `SourceBrowserTree.svelte`) only renders normalized `SourceBrowserNode`s (`id, label, kind, children, action, badge, tags, tooltip, emptyMessage`). The adapters in `utilities/timelineSources.ts` produce the nodes. The browser has no knowledge of Hasura tables or source kinds.

An item's `action` is `{ typeName: 'activity' | 'resource' | 'externalEvent', item, sourceId, externalSources? }`. Adding one goes through the existing `viewAddFilterToRow` path, with `sourceId` (and, for events, `externalSources`) carried in `TimelineItemMetadata`.

While a group's stores load, its empty state reads *Loading…*. Each group checks its own sources' capability `loading` flags, not only `plan_dataset` loading. External Events count as loading while the plan's derivation-group links or the derivation groups load, and, once there are links, while their events load.

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

**Source-less resource layers are legacy compatibility only.** Every new resource layer carries a `sourceId`:
- Plan › Model Resources items, including those dragged onto a row, bind to `plan`. The single choke point is `getUpdatedLayerWithFilters`, which defaults a resource layer with no source to `plan`.
- New empty resource layers from the row editor bind to `plan`.
- Generated default views bind to `plan`.
- Sources items keep the source they came from.

A source-less layer therefore only exists in a view saved before sources. The layer editor offers *Any (legacy: simulation, then attached datasets)* only to such a layer. A bound layer can switch between sources but not back to the unbound lookup, so the legacy state does not grow.

**Unbound layers behave exactly as before.** A resource layer with no `sourceId` keeps the old lookup:
- model resource name → simulation profile;
- otherwise → the attached external datasets (sim-tied row, then plan-level, then first).

Its request is keyed `::<name>`, so it never aliases a source-bound request for the same name.

**Old views are not rewritten.** The v3→v4 migration only bumps the version; it deliberately adds no `sourceId`.

**Evidence.** Legacy views (plan 2 views 2 and 3, and plan 1's default view) were rendered on a baseline build (develop plus the four independent fixes) and on this branch:
- all timeline rows are pixel-identical;
- 14 pixels in the header's range-cursor icons differ by at most 21 colour levels;
- a baseline-vs-baseline render differs by 0 pixels, so these 14 are real but sub-pixel anti-aliasing, not data.

After the Phase 4 fixes, views 2 and 3 were compared again, this time against the previous branch head:
- rows are again pixel-identical;
- the only differences (about 85 pixels) are in the overview histogram, which now also counts the fixture's new *Backup Passes* event.

Legacy event layers (type filters only) still show the type from every visible linked source. View 7's *Pass* layer shows `pass-1`, `pass-2`, `pass-3` and `backup-pass-1`.

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

**Where the source is shown.** Legends and tooltips name the source (`/battery/soc · Dataset 50`, `Source: External Datasets · Dataset 50`). Axis labels of layers bound to a non-Plan source name it (`/power (W) · Dataset 50`). Plan layers do not repeat `· Simulation` on the axis; their legend and tooltip still name it.

**Rebinding a resource layer** (changing its source, or its resource while bound) re-derives everything that comes from the resource declaration. `getResourceLayerPresentation(resourceType, sourceId, sourceLabel)` is the single mapping from a `ResourceType` to schema family, default chart type, axis label, unit and tick count. Both `createTimelineResourceLayer` and `rebindResourceLayer` use it, so creation and rebinding cannot diverge. `rebindResourceLayer`:
1. **Resolves the declaration.** It looks up the new resource's `ResourceType` in the new source's catalog (`findResourceType`), and the previous one the same way.
2. **Updates the binding.** It sets `sourceId` and `filter.resource`, and keeps the layer id.
3. **Chart type.** Within the same schema family it keeps the layer's styling (colour, width, and a user-chosen line/x-range). If the new resource is discrete, a line layer becomes an x-range. If a numeric resource replaces a discrete one, an x-range becomes a line. Conversion builds the layer with the same creators as `createTimelineResourceLayer`.
4. **Axis.** The layer's own axis (`layer.yAxisId`) is updated in place: its label always; its tick count, fit mode and scale domain are reset unless family and unit are unchanged. If sibling layers share the axis, it is left untouched for them and the layer gets a new axis.
5. **Missing resource.** If the new source lacks the resource, the selection is cleared and the axis waits until a resource is chosen.
6. **Horizontal guides.** Guides reference an axis by `yAxisId` and hold a raw `y`, so they are part of the decision. A guide is kept only when the axis still measures the same quantity: the previous and new resource have the **same name, schema family and unit** (Dataset A `/battery/soc` real % → Dataset B `/battery/soc` real %). There is no other inference; two unrelated % resources do not share guides. Otherwise:
   - **Own axis, incompatible rebind** (`/power` W → kW, real → variant, `/soc` → `/dod`): the axis is updated in place as above, and guides on it are removed, so 500 W never silently becomes 500 kW.
   - **Own axis, resource cleared:** the axis stays for the next selection, but its guides are removed.
   - **Shared axis:** the axis and its guides stay as they are for the other layers, and the rebound layer's new axis starts with no guides.

   `rebindResourceLayer` takes and returns `{ layers, yAxes, horizontalGuides }`, keeping the guide decision next to the axis decision. The editor applies all three in one store update through `viewUpdateRowProperties`; `viewUpdateRow` now delegates to it.

Unbound (legacy) layers keep their existing resource-change behavior.

The Plan source's bindable catalog is its simulated profiles plus the model's declared resources, so a Plan layer can be set up before simulating. The Sources tree still lists only what was simulated.

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
      └─ <event type> (count)  → adds an external-event layer restricted to this type from this source
```

**How browser scope is represented in layers.** `ExternalEventLayerFilter` gains one field. It is expressed in the external-event domain's own identity, not as TimelineSource ids:

```json
{ "static_types": ["Pass"],
  "external_sources": [{ "derivation_group_name": "DSN Passes", "source_key": "dsn_week1.json" }] }
```

- **Matching.** An event matches only if its `pkey.(derivation_group_name, source_key)` is one of the listed pairs. The pair is compared as a whole, so the same source key in another group never matches.
- **Combining.** The restriction narrows every other criterion (static and dynamic types, other filters, type subfilters). On its own, it selects every event from those sources.
- **Absent or empty** keeps the old semantics (any linked source). Legacy layers are unchanged and nothing is migrated.
- **Merging.** Adding items to an existing layer only merges when the layer's restriction equals the items' (order-insensitive). Otherwise a new layer is created, so a merge can neither widen a layer nor narrow items. This applies to the layer picker and to drops on a row. Merging now keeps a layer's other criteria; it used to replace the whole filter with `static_types`.
- **Naming.** Source keys are only unique within a derivation group. So a new row for a restricted leaf is named `<type> · <derivation group> / <source key>`, as in the filter builder. For example, `Pass · DSN Passes / dsn_week1.json` and `Pass · Backup Passes / dsn_week1.json` are distinct. A multi-source restriction gets `<type> · N sources`. Type-only items keep the existing default (`Pass`), and saved rows are never renamed.
- **Filter builder.** `ExternalEventFilterBuilder` has an *External Sources* section. It lists the restriction and lets you remove entries or add any source of a linked group. Every other edit round-trips the field, so an editor interaction never widens the layer back to all sources. The builder's instance count honours the restriction.
- **Schema.** View schema v4 accepts `external_sources`. v4 is new on this branch, so it was extended rather than bumped.

**Unchanged in the backend.** No backend or domain change. These all stay where they were:
- schemas;
- source keys;
- derivation groups;
- derived events and their refresh;
- plan links;
- acknowledgement;
- visibility.

Event identity stays the existing pkey (derivation group, source key, type, key), and the source's only capability is `events`.

**Remaining limitations.**
- **Leaves only.** Only type leaves are addable. Derivation-group and source nodes are for browsing, although the filter can already express "every event from this source".
- **Visibility still applies.** Per-plan derivation-group visibility is applied before the layer filter, so a restricted layer on a hidden group shows nothing.
- **No live validation.** A restriction naming a source that no longer exists, or a group that is unlinked, simply matches nothing. It is not flagged as unavailable the way a missing resource source is.

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
- Add actions on derivation-group and source nodes, and an unavailable message for event restrictions whose source is gone (§5).
- A name for `plan_dataset` (for example captured from the upload file name).
- The builder's existing *Other Filters → Add Filter* default (an empty `Tags` filter, which external events do not have) matches nothing until edited. This behavior predates this work.

## Verification

Run on the local stack with plan 2 and `docs/sources/sources_fixture.sql` loaded:
- Dataset A (50), plan-level: `/battery/soc` ramping 90→30 %, `/thermal/panel`, `/power` (W), `/mode` (real).
- Dataset B (51), tied to the selected simulation: `/battery/soc` at 55 %, `/power` (kW), `/mode` (variant).
- Derivation groups: *DSN Passes* (2 sources), *Backup Passes* (Pass in another group; its `dsn_week1.json` shares a key with a DSN Passes source) and *Eclipses*.

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
| vitest: 72 files, 907 tests; includes the source tests, v4 schema/migration tests, `getResourceForLayer` cases, and the Phase 4 fix tests below | pass |
| svelte-check 0 errors / 0 warnings; eslint and prettier clean | pass |

**Phase 4 fix pass.** View 9 *Phase 4 fixes* was built from legacy view 2 through the UI and saved, then edited, saved and reloaded.

| Check | Result |
|---|---|
| Unit tests (`stores/views.test.ts`): DG A has source-1 and source-2, DG B has source-3, all with `Pass`, plus the same source key in DG B. Selecting *DG A / source-1 / Pass* yields only that subset. Legacy type-only filters still match all of them. The restriction narrows dynamic and other filters. Merges keep the restriction and the other criteria, and happen only between equal restrictions. JSON round trip keeps the restriction. v4 schema accepts it and rejects a malformed entry | pass |
| Browser: *DSN Passes › dsn_week1.json › Pass* → row `Pass · dsn_week1.json` with `external_sources` persisted. Tooltips at each event: `pass-1`, `pass-2` shown; `pass-3` (dsn_week2) and `backup-pass-1` (Backup Passes) absent. *Backup Passes › backup.json › Pass* shows only `backup-pass-1` | pass |
| Filter builder on that layer lists *DSN Passes / dsn_week1.json* and 2 instances. After adding *Handover*, saving and reloading, the filter is `static_types [Pass, Handover]` with the restriction intact: 3 instances, still no `pass-3` or `backup-pass-1` (`15`) | pass |
| Legacy view 7 *Pass* layer (type-only) still shows all four Pass events | pass |
| Plan › Model Resources `/battery/soc` → persisted `"sourceId": "plan"`. Editor Source shows *Plan · Simulation*, with no *Any* option. The legacy `/battery/soc` layer keeps *Any (legacy…)* | pass |
| Unit tests (`utilities/resourceLayerRebind.test.ts`): `/soc` real % → real % keeps the layer, styling and scale, and relabels the axis. Real W → real kW updates the unit and resets the scale. `/mode` real → variant converts to the layer creation would produce, and back. A shared axis is left alone and the layer gets its own. A resource the source lacks clears the selection. Rebinding to legacy drops `sourceId` | pass |
| Browser rebinding, then save. Model Resources `/battery/soc` Plan → Dataset 50 → 51: same layer id, colour kept, axis `/battery/soc (%) · Dataset 51`. `/power` 50 → 51: axis `/power (kW) · Dataset 51`, tooltip `0.2 (kW)`. `/mode` 50 → 51: line → x-range, tick count 0, tooltip `SAFE` then `SCIENCE`. The four other rows are byte-identical in the saved definition before and after (`16`) | pass |
| Missing-source view 8 unchanged (unavailable / has no activities). Plan 1, with no linked groups, shows *No derivation groups are linked to this plan*, not a stuck *Loading…* | pass |

**Final cleanup pass.** View 9 was seeded with guides and a shared-axis row, then edited through the UI and saved.

| Check | Result |
|---|---|
| Unit tests (`resourceLayerRebind.test.ts`): same `/soc` % A → B keeps the guide on the same axis. `/power` W → kW removes it and relabels and resets the axis. `/soc` % → `/dod` % removes it. `/mode` real → variant removes it and becomes an x-range. On a shared axis, the axis and guide are kept for the sibling and the rebound layer's new axis has none. A cleared resource removes the guides of an own axis only | pass |
| Unit tests (`views.test.ts`): *DG A / source-1 / Pass* and *DG B / source-1 / Pass* → `Pass · DG A / source-1` and `Pass · DG B / source-1`. Two sources → `Pass · 2 sources`. Type-only → `Pass` | pass |
| Browser: `/power` Dataset 50 (W) with a 500 W guide → Dataset 51: axis `/power (kW) · Dataset 51`, guide gone | pass |
| Browser: `/battery/soc` Dataset 51 → 50 (both real %) with a 50 % guide: guide kept, same axis | pass |
| Browser: *Shared /power*, two Dataset 50 layers on axis 6 with a 100 W guide; Layer A → Dataset 51. A gets axis 7 (`/power (kW) · Dataset 51`, no guide). Layer B, axis 6 and the 100 W guide are unchanged (`17`) | pass |
| Browser: Pass from *DSN Passes › dsn_week1.json* and from *Backup Passes › dsn_week1.json* → rows `Pass · DSN Passes / dsn_week1.json` (pass-1, pass-2) and `Pass · Backup Passes / dsn_week1.json` (backup-pass-2) (`17`) | pass |
| vitest 72 files / 915 tests; svelte-check 0 / 0; eslint and prettier clean | pass |

**Not verified:**
- the UI e2e suite (it needs merlin-server);
- scheduling and constraints runs, since neither code path was touched;
- live-streaming simulation profiles into a bound Plan layer;
- a plan with no `plan_dataset` rows at all; the empty-state message was checked on plan 1's empty External Events group instead;
- the transient *Loading…* state of the External Events group, which is too brief to capture locally; it is covered only by the loading logic above.
