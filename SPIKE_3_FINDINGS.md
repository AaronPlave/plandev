# Spike 3: multi-source activity/span composition in one PlanDev timeline: findings

**Question.** Can one PlanDev timeline compose activities/spans from several independent sources, keep PlanDev's existing activity-layer filters, and source-qualify span identity, hierarchy, selection and tooltips?

**Answer: yes, and without renderer surgery.**

- `LayerDiscrete` needed only its identity keys changed (+42/−18 lines, no drawing-algorithm change).
- The filter functions are already pure over `(directives, spans, types)`. They needed no change at all.

The real single-namespace assumptions are elsewhere:

- one global `selectedSpanId` that every plan panel reads;
- `spansMap[span_id]` lookups in the context menu and hierarchy;
- `seen[span_id]` de-duplication sets;
- the filter builder's module-level catalog stores.

All of them type-check, so none showed up as compiler errors. Each was found by inspection and proven with deliberately colliding data.

**Stronger success criterion: met.**

- Source-qualified activity layers are edited in the existing editor and saved to `ui.view`.
- On reload they bind by **slot** (`"tour"`), not by artifact.
- The same saved view was rebound from tour revision r1 to r2 with no view change. Intervals and resources both followed.

## Branches

| Repo | Branch | Commit |
|---|---|---|
| `AaronPlave/plandev-ui` | `claude/hopeful-cannon-cki37d` | `930044a` (on top of Spike 2 `1f4d0b0`) |
| `AaronPlave/plandev` | `claude/hopeful-cannon-cki37d` | this file, fixture |

The UI diff is 22 files, about +775/−116, including a 192-line test file and a 75-line spike-only details component. There are **no backend changes and no new tables.**

---

## 1. What was implemented

### Three identities, kept apart

| Identity | Example | Where it lives |
|---|---|---|
| **Slot** (what a layer stores) | `"plan"`, `"tour"` | `TimelineSource.id`, `ActivityLayer.sourceId`, `ResourceRef.sourceId` |
| **Concrete artifact** (what the slot is bound to now) | `standalone_dataset 10 (Imported Tour r1)` | `TimelineSource.binding` (display only) |
| **Data revision** | `dataset:46` | `TimelineIntervalData.key`, `TimelineResourceProvider.key` |

Fake runtime binding (URL):

- `?source.tour=standalone:10` binds slot `tour` to standalone_dataset 10.
- `&source.tour.catalog=inferred` asks for a richer inferred catalog (see §3e).
- Spike 2's `?standaloneDataset=9` still works; it is simply a slot whose name is `standalone:9`.

Because the registry id *is* the slot, Spike 2's resource refs became slot-bound for free. `{name:'/battery/soc', sourceId:'tour'}` followed the r1→r2 rebind with no resource-path changes. The plan's role id was renamed `plan-simulation` → `plan`. Being the default source, it is never written into views, so no saved view changed.

### Source registry gains an optional interval capability

```ts
TimelineSource {
  id; label; binding?;
  provider; resourceTypes;           // resources (Spike 2)
  intervals?: TimelineIntervalData | null;  // undefined = no interval capability; null = loading
  hasDirectives?: boolean;           // only the plan slot
}
TimelineIntervalData { key; spans; spansMap; spanUtilityMaps; intervalTypes: ActivityType[] }
SpanRef { sourceId: string | null; spanId }   // null = default source
SpanKey = `${sourceId ?? ''}::${spanId}` (branded string; only for records/quadtrees)
```

- **Loading:** eager, the whole dataset. It reuses the existing `effects.getSpans(dataset_id, source.start_time)`, so offsets resolve against the source's own start. There is no `queryIntervals(range)` yet; the seam is `intervals` becoming a provider.
- **Stamping:** as in Spike 2, default-source spans are unstamped and other sources' spans carry `sourceId`. The invariant everywhere is: `span.sourceId ?? null` is the span's source.
- **Plan slot:** it keeps its meaning of *directives + simulated spans*.
  - Its `intervals` expose the simulation's spans and `planModelActivityTypes`, for catalog, tooltip and parent lookups.
  - Rows still take the plan's directives/spans from their existing props, so the legacy code path is untouched.
  - Imported slots are *spans only* and read-only.

### Activity layers bind at the layer level

`ActivityLayer.sourceId?` holds the slot. The filter (`static_types`, `dynamic_type_filters`, `other_filters`, `type_subfilters`) is **unchanged**, and no per-type source qualification was needed. A missing `sourceId` means the default source.

Normalisation happens in exactly one function, `resolveActivityLayerSourceId(layer, defaultSourceId)`. The canonical stored form omits the default, so legacy views round-trip byte-identical. This is simpler than Spike 2's string/object union: it is one optional field, not a union type in every consumer.

### Row: one pass per source namespace

For each activity layer, `Row` resolves the layer's slot to a namespace `{directives, spans, spansMap, spanUtilityMaps, types}`:

- the plan slot: the existing props;
- an imported slot: `source.intervals`, with directives `[]`.

It then runs the existing `applyActivityLayerFilter` in that namespace.

Two `span_id`-keyed pieces were re-keyed:

- the seen-sets that de-duplicate across layers → `SpanKey`;
- `idToColorMaps.spans` → `SpanKey`.

Two failure cases get explicit row messages:

- Unknown slot → `Source "tour" is not available`, never a silent rebind to Plan.
- Slot with no interval capability → `Source "X" has no activities`.

**Tree:** one subtree is built per source, each with *that source's* span maps. Two tiny changes to `generateDiscreteTreeUtil` (+24/−10):

- An optional `nodeNamespace {idPrefix, labelSuffix}` param namespaces non-default top-level nodes (`tour::OBSERVE`, label `OBSERVE · Imported Tour r1`), so expansion state and labels never merge.
- In `directive` hierarchy mode, a source without directives uses its root spans as roots. Previously imported spans were invisible in that mode.

### Selection is source-qualified without touching plan panels

`selectedSpanId` stays what every plan panel assumes: **span N of the plan's simulation**. A new `selectedSourceSpan` store holds an imported span, carrying its `sourceId`.

`TimelinePanel` computes `selectedSpanKey` and threads it through `Timeline → Row → LayerDiscrete / RowHeader → RowHeaderDiscreteTree`. Highlight comparisons are by `SpanKey`, and "anything selected" dimming checks the key.

When an imported span is clicked:

- the plan selection is cleared;
- `ActivityFormPanel` renders a spike-only, read-only `ImportedIntervalDetails`. It shows source, binding, type, span id "(within tour)", start/end/duration, parent and children resolved in the same source, and raw attributes including provenance.

`ActivitySpanForm`, which reads model types, simulation dataset and directive links, is not used for imported spans.

A plan selection made anywhere (tables, forms) clears `selectedSourceSpan`.

### Other source-qualification fixes

- **Context menu:** it looked up `spansMap[selectedSpanId]`, i.e. the plan span with the same id. Now `LayerDiscrete` passes the span object, and `selectedSpanId` is only set for default-source spans.
- **Context menu times:** `getSpanDate` computed `sim start + start_offset`, which is wrong for any non-simulation span. It now uses the span's absolute `startMs`/`endMs`. "Jump to Activity Directive" is hidden for imported spans.
- **Tooltip:** a `Source:` row appears when there is more than one source. A `Parent: TYPE (id)` row is resolved within the span's own source. The header reads "Imported Interval" vs "Simulated Activity (Span)".
- **Drop onto a row:** the "does this row already show type X?" check, and the layer that receives an added type, now consider only default-source layers. Previously a tour `OBSERVE` layer counted as showing plan `OBSERVE`, and a plan type could be appended to a tour layer's filter.
- **`getUniqueNodeItems`:** it de-duplicated by `span_id`; it now uses `SpanKey`.

### Editor: the existing filter builder, fed a per-source catalog

`TimelineLayerEditor` gains a `Source ▼` control for activity layers. It lists the plan plus every source with an interval capability, plus `X (unavailable)` if the layer's slot isn't bound.

`ActivityFilterBuilder` gains one optional prop, `sourceCatalog`. When it is set, the unchanged builder uses that source's `intervalTypes`, spans and span maps instead of `planModelActivityTypes` / `$spans`. Subsystem options are derived from the same types, and the directive list is empty. That required converting four module-level store reads into reactive values (+30/−15).

On a source switch:

- `static_types` and `type_subfilters` are pruned to the new source's catalog, and rule-based filters are kept.
- **Exception:** if pruning would drop *every* selected type, they are kept. PlanDev has no "match nothing" filter, and an emptied `static_types` means "all types", which would silently widen the layer (see §6).

Source and pruned filter are written in one update. `handleUpdateLayerProperty` spreads a captured layer, so two consecutive dispatches lose the first.

### Persistence

The saved view stores `{ "sourceId": "tour", "filter": { "activity": { "static_types": [...] } } }`; plan layers have no `sourceId`.

The v3 JSON schema's activity layer has `additionalProperties: false`, so saved view 5 **failed** upload validation until the schema gained `sourceId` (verified with Ajv before and after). As in Spike 2, it was widened in place; production should bump to v4.

### Imported catalog: minimal and inferred

- **Default:** distinct `span.type` only (Spike 1b).
- **`&source.tour.catalog=inferred`:** `inferIntervalTypeDescriptors` builds each type's parameters from the union of its spans' `attributes.arguments` keys, typed by JS value. It is shaped as `ActivityType` because that is what the builder consumes. No fake mission model is involved.

### Fixture (`deployment/spike/spike3_multisource_intervals_fixture.sql`)

**Plan 2:**

- Two OBSERVE directives: *Observe Europa* at 001T01:00 and *Observe Io* at 003T04:30.
- Sim dataset 13 holds span 1 OBSERVE (→ directive 1), span 2 SLEW with parent 1, span 3 OBSERVE (→ directive 2), and span 4 SLEW with parent 3.
- Model types OBSERVE(target) and SLEW(to).

**Tour r1** (standalone 10 / dataset 46, 003→006; offsets from 003T00:00):

- span 1 OBSERVE 003T04:00–05:00. **Same id and type as plan span 1, and overlapping plan span 3.**
- span 2 SLEW, parent 1, 04:15–04:45. **Same id and parent_id shape as plan span 2→1.**
- span 3 INSTR_Decontamination.
- spans 4 and 5 INSTR_SampleAcquisition.
- `attributes.arguments = {legend, subsystem}`, `attributes.provenance = {sourcePath, externalId}`.
- `/battery/soc` = 40.

**Tour r2** (standalone 11 / dataset 47):

- Same product, everything 2 h later.
- Adds a second INSTR_Decontamination.
- `/battery/soc` = 60.

**Views:**

- 3: legacy, no `sourceId` anywhere.
- 4: hard-coded overlay.
- 5: saved after edits.
- 6: richer filters.

---

## 2. Verification

These are scripted Playwright runs against the local stack (Postgres + Hasura + gateway + UI dev server). Screenshots were taken during the runs but are not kept in the repository.

| Check | Result |
|---|---|
| **Legacy Plan behaviour** (view 3, with and without a tour binding) | Tree `OBSERVE 2 / SLEW 2`, directive-hierarchy and compact rows. Screenshot is **pixel-identical** (0 differing pixels) to a baseline taken before any Spike 3 code |
| **Same-name type, same row** (view 4 row 0, `02-overlay`) | Plan `OBSERVE` (directives + spans) and tour `OBSERVE` render together, as groups `OBSERVE` and `OBSERVE · Imported Tour r1` |
| **Same span_id selection** (`04`, `05`) | Both hierarchies expanded. Selecting tour SLEW 2 highlights **only** the tour leaf and opens the imported details, with the plan panel empty. Selecting plan SLEW 2 highlights **only** the plan leaf and opens the plan span form (001T01:10, decomposition OBSERVE→SLEW, sim-table row 13 highlighted) |
| **Canvas hit-testing** | Canvas click on tour span 1 selects (tour, 1); click on plan span 3 opens the plan form. The quadtree is keyed by `SpanKey` |
| **Parent-id collision** | Expanding tour `OBSERVE` (span 1) shows child `SLEW` from **tour** maps. Details for tour span 2: `Parent OBSERVE (1)`, start 003T04:15, i.e. the tour parent, not plan span 1 at 001T01:00 |
| **Overlapping time, tooltip** (`03`) | At 003T04:45 the tour lane reads *Imported Interval / Source: Imported Tour r1 / OBSERVE / 04:00–05:00 / Id 1*; the plan lane reads *Simulated Activity / Source: Plan / OBSERVE / 04:30–05:30 / Id 3* |
| **Different time origins** | Tour offsets resolved against 003T00:00; spans land at their absolute times |
| **Static and multi-type filter** | `static_types:[INSTR_Decontamination, INSTR_SampleAcquisition]` on tour → both groups (1 + 2); builder shows *2 types / 3 instances* (`06`) |
| **Richer filters on imported metadata** (view 6, `10`) | dynamic *Type includes INSTR* ✓; *Parameter legend = INSTR* ✓; *Parameter subsystem = INSTR* ✓ (a cross-type Raven-style band: INSTR_* **and** OBSERVE, excluding GNC SLEW); `type_subfilters` (SLEW subsystem=INSTR) ✓ → OBSERVE only |
| **Plan filters unaffected** | Plan layer *Parameter target = Io* → Observe Io + its SLEW only |
| **Editing source** | Layer A plan→tour: its plan groups disappear and the tour catalog applies. tour→plan restores them. INSTR layer tour→plan keeps its (unknown) types and shows nothing rather than every plan activity; →tour restores |
| **Catalog follows source** | The builder on a tour layer lists INSTR_* / OBSERVE / SLEW from the tour catalog; plan layers list the model's OBSERVE / SLEW |
| **Delete one layer** (`07`) | Deleting plan layer A: tour layer B unchanged, **0 GraphQL requests**, and the existing tour selection is kept (highlighted in every row that shows span (tour, 1)) |
| **Save / reload** | "Save as" → view 5 (layers stored `sourceId:"tour"`; plan layers have none). Reload with `?source.tour=standalone:10` restores every layer |
| **Missing binding** (`08`) | View 5 without `source.tour` → every tour layer shows `Source "tour" is not available`. Mixed rows still draw their plan layer. The tour resource layer shows the Spike 2 load error |
| **Artifact id ≠ slot** | View 5 with `?standaloneDataset=10` (the same artifact under slot `standalone:10`) → still "tour not available". The view is bound to the slot, not the artifact |
| **Rebind to a new revision** (`09`) | View 5 with `?source.tour=standalone:11` → groups read `Imported Tour r2`, INSTR_Decontamination 2, times shifted, resource axis `/battery/soc · Imported Tour r2`. No view edit |
| **Spike 1 / 2 regressions** | `/datasets/8` and `/datasets/10` (tour as its own plan-free page) render; Spike 2 view 1 overlay renders; plan 1 renders |
| **Unit tests** | `timelineIntervals.test.ts` (9 tests): `(plan,1) ≠ (tour,1)`, local maps and stamping, parent lookup per source, legacy layer → default, canonical form, same type in two sources filtered separately, Parameter filter on imported arguments, namespaced tree nodes, directive-mode roots, URL bindings, inferred parameters. Full suite **895 passed**; svelte-check 0 errors; eslint and prettier clean on changed files |

**Not verified:**

- live switching of the plan's simulation within one page session;
- very large imported span sets (no LOD/range queries by design);
- the e2e suite (needs merlin-server);
- external-event layers together with multi-source activities in one row. That path is handled in code (other-source nodes are appended to the `!!activity-agg` cluster) but has not been run.

---

## 3. Answers to the spike questions

**1. Can one timeline render activities/spans from multiple independent sources?**

Yes, in the same row, same canvas, same packing and same tree. `LayerDiscrete` draws whatever `DiscreteTreeNodeItem`s it is given. It never asks where a span came from, except in the identity lookups listed in Q4.

**2. Can two sources contain the same span_id safely?**

Yes, once identity is `(sourceId, span_id)`. The collision is real, not hypothetical: `merlin.span`'s primary key is `(dataset_id, span_id)` and every simulation numbers from its own base. Before the fix, three things would have shown the wrong span:

- highlight: `selectedSpanId === span.span_id` was true for both;
- plan panels: the form and tables read `spansMap[selectedSpanId]`;
- the context menu: it also read `spansMap[selectedSpanId]`.

After the fix, verified with ids 1 and 2 colliding in both sources.

**3. Can two sources contain the same activity/span type safely?**

Yes. The filter runs per namespace, so `static_types:["OBSERVE"]` on a tour layer never matches plan OBSERVE. The tree gives non-default groups namespaced ids and labels.

What remains global by type name:

- `type_subfilters` keys: fine, because they are layer-local.
- The tooltip's overflow summary, which groups by type across sources: cosmetic.
- The drop-to-row "type is visible" check: fixed to plan-bound layers only.

**4. What state had to become source-qualified?**

- the selection highlight (`SpanKey` through five components);
- an imported-span selection store separate from `selectedSpanId`;
- the Row seen-sets and span color map;
- the per-source span maps used for tree generation and parent lookup;
- the tree node ids and labels for non-default sources;
- the context-menu span resolution and time basis;
- `getUniqueNodeItems`;
- the filter builder's catalog;
- the drop-to-row target layer.

**5. Which span_id assumptions were timeline-global vs safely source-local?**

| Location | Keyed by span_id | Verdict |
|---|---|---|
| `LayerDiscrete` `idToColorMaps.spans`, `visibleSpansById`, quadtree ids, `seenSpans`, selection compare | yes | **timeline-global → re-keyed to `SpanKey`** |
| `Row` `seenSpanIds`, color map | yes | **global (crosses layers) → `SpanKey`** |
| `RowHeaderDiscreteTree` selected compare | yes | **global → `SpanKey`** |
| `getUniqueNodeItems` | `Set<number>` | **global → `SpanKey`** |
| `TimelineContextMenu` `spansMap[selectedSpanId]`, `getSpanRootParent`, `spanIdToDirectiveIdMap` | yes | **global lookup → skipped for imported spans** |
| `selectedSpanId` / `selectedSpan` store | yes | **kept, now explicitly plan-scoped**; imported selection is separate |
| `generateDiscreteTreeUtil` / `getSpanSubtrees` / `getDirectiveSubtree` (`spanIdToChildIdsMap`, `spansMap`) | yes | **source-local if called per source**: now called once per source |
| `createSpanUtilityMaps`, `spansMap` per source | yes | source-local by construction |
| `ActivitySpanForm`, `ActivityDecomposition`, `ActivitySpansTable`, `SimulationEvents*`, `getActivityDirectiveStartTimeMs` (anchors) | yes | **source-local** (only ever receive plan spans), safe as long as `selectedSpanId` never carries an imported id |
| `ActivityFilterBuilder` instance count (`directiveIdToSpanIdMap`) | yes | source-local once fed the source's maps |
| `TimelineHistogram` | plan spans only | source-local; imported spans are simply absent from the histogram |

**6. How invasive was source-qualifying hierarchy?**

Small. Because hierarchy lookups take `(spansMap, spanUtilityMaps)` as arguments, calling the tree builder once per source with that source's maps was enough: one optional parameter plus a partition-by-`sourceId` wrapper in `Row`. `getSpanParent(span, registry)` resolves parents for tooltip and details in the span's own source.

The only real gap was pre-existing: `directive` hierarchy mode shows only directive subtrees, so directive-less spans (imported, or Spike 1's standalone page) were invisible. Fixed for non-default sources by treating root spans as roots.

Expand/collapse works and is namespaced (`tour::OBSERVE_…`).

**7. How invasive was source-qualifying selection?**

Moderate but mechanical: one store, one derived key, a prop threaded through five components, and seven comparison sites.

The design point is that `selectedSpanId` is consumed by about ten plan panels that all mean "plan simulation span". Widening it to a `SpanRef` would touch all of them for no benefit. The better shape is a timeline-level `selectedIntervalRef` with the plan's `selectedSpanId` derived from it when `sourceId` is the plan.

Jump-to-span and jump-to-directive remain plan-only, which is correct.

**8. Can existing activity filters operate against a per-source catalog without redesign?**

Yes:

- `applyActivityLayerFilter` and `getMatchingTypesForActivityLayerFilter` are pure over `(directives, spans, types)`.
- The builder is unchanged apart from getting its catalog from a prop instead of module-level stores.
- No filter-language change was needed.

**9. Which existing filters work on imported source metadata?**

| Filter | Works on imported spans? |
|---|---|
| `static_types` (one or many) | ✓ |
| `dynamic_type_filters` **Type** | ✓ |
| `other_filters` / `type_subfilters` **Parameter** | ✓ It reads `span.attributes.arguments[name]`, so a transformer that normalises metadata into `arguments` gets per-instance filtering (`legend`, `subsystem`, …) for free |
| **Subsystem** | only via source-supplied type descriptors (type-level synthetic tag). Not from per-span values |
| **Name**, **Tags**, **SchedulingGoalId** | ✗ directive-only fields, for plan spans too |

Two important caveats:

- **Evaluation doesn't depend on the catalog, but editing does.** A saved *Parameter legend = INSTR* filter matched the same 3 spans with either catalog. But with the names-only catalog the builder cannot show or edit it: it shows a blank "Select Parameter" (`11`). With the inferred catalog it shows `legend (string) equals INSTR` (`12`). Imported sources need declared parameters for the UI, not for the filter.
- **"Resulting Types" is type-level.** An instance filter such as `legend = INSTR` still lists all 4 types. This is existing behaviour, and a bit misleading for Raven-style bands.

**10. Which useful Raven metadata cannot currently be expressed by PlanDev filters?**

- **Source paths / hierarchical organisation** (`Activities by Legend/…`, `Activities by Type/INSTR/…`). Parameter only looks in `attributes.arguments` and has no path/prefix semantics over nested attributes. `provenance.sourcePath` is preserved and shown in details but is not filterable. *(Do not add it to the layer schema; it belongs in the source browser.)*
- **Per-instance subsystem as a Subsystem filter.** PlanDev's Subsystem is a *type-level* `tags.tags` id. Imported per-span subsystems must use Parameter, and a type can't have two subsystems.
- **Portable subsystem filters.** The filter stores **tag ids**: real DB ids for plan types, synthetic negative ids for imported descriptors. They are not stable across sources or revisions, unlike type names.
- **"Match nothing"** does not exist; an empty `static_types` means all types (see the editor pruning exception).
- **Legend as a type-selector** (Raven "Activities by Legend/X" selects bands, not instances). It is only expressible as an instance filter (`other_filters`), not in `dynamic_type_filters`, which supports only Type/Subsystem.
- **Name** for imported spans. Spans have no `name`; Raven activity names/labels would need a field the filter reads.

**11. Can imported spans stay semantically distinct from Plan directives while sharing timeline rendering?**

Yes. Imported spans:

- are drawn by the same code;
- are never draggable (no directive);
- have no "Jump to Activity Directive";
- never enter `selectedSpanId`, `ActivitySpanForm` or the spans table;
- are labelled "Imported Interval" in the tooltip, with read-only details.

The plan slot keeps *directive + span* composition exactly as before (pixel-identical).

The shared abstraction is **visualisation and query**: items with a type, time, parent and attributes, filtered by the same rules. It is not domain equivalence.

One latent leak: `createSpanUtilityMaps` treats `attributes.directiveId` as a directive link. An imported product that happened to use that attribute name would get directive↔span entries in *its own* maps. That is harmless today because non-default sources have no directives, but imported attributes should not reuse the Merlin attribute shape blindly.

**12. Did LayerDiscrete / activity rendering itself require major changes?**

No. Only identity keys (`SpanKey` for colors, quadtree, visible map, seen-set, selection) and a source-qualified context-menu payload. Packing, drawing, labels, grouped, compact and collapsed modes are unchanged. **The single-source assumption enters above the renderer**: in `Row`'s namespace selection, tree generation and selection state.

**13. Can a source slot survive changing concrete source revisions?**

Yes, verified. View 5 saved against r1 rendered r2 (`?source.tour=standalone:11`) without edits: intervals, catalog, labels and the tour resource layer all followed. This holds because the stored identities are the **slot** plus **type/resource names**.

What does not survive a revision:

- selection (runtime only; fine);
- `Subsystem` filter tag ids (Q10);
- any type that the new revision renames.

Tree expansion state is keyed by slot, so it survives.

**14. Does the source registry still look like the right common timeline abstraction?**

Yes, with optional capabilities:

- a resources provider and catalog;
- intervals plus a catalog;
- `hasDirectives` for the plan slot.

Two cleanups for production:

- Rows still take the default source's spans from props while the registry also carries them. The plan slot should be read from the registry like any other, with directives as a capability.
- Interval loading should become a provider (`subscribeIntervals(range)`) mirroring resources.

**15. What should the next experiment be?**

A **plan-independent Analysis View with persisted slot bindings**:

- A view declares slots (`sources: [{slot, kind, label, capabilities}]`, schema v4).
- A small binding record maps slot → artifact revision per analysis or plan, replacing the URL.
- The page composes N sources with **no privileged plan slot**: plan and simulation become just another source kind.
- It should include external events as a source capability, the third single-namespace store today, and exercise `selectedIntervalRef` as the one timeline selection.

A second, smaller experiment is a `subscribeIntervals(range)` provider on a large imported product, to size the eager-load limit.

---

## 4. Dependency classification (Spikes 1–2 table extended)

Columns:

- **Plan**: needs a plan.
- **Sim**: needs a simulation dataset.
- **1-src**: one data source per timeline.
- **span-ID**: `span_id` used as a timeline-global key.
- **type-ns**: one global activity-type namespace.
- **directive**: assumes directive semantics.

Symbols: ✅ assumption removed in Spike 3 (S1/S2 = removed earlier); ⚠️ still present; — never had it; *local* = present but only ever sees one source.

| Component | Plan | Sim | 1-src | span-ID | type-ns | directive | Notes |
|---|---|---|---|---|---|---|---|
| `Row.svelte` activity pass | ✅ S1 | ✅ | ✅ per-source namespace | ✅ `SpanKey` | ✅ per-source types | plan slot only | default slot still via props |
| `Row.svelte` resources | ✅ S1 | ✅ S2 | ✅ S2 | — | — | — | |
| `LayerDiscrete` | ⚠️ drag = plan directives | — | ✅ | ✅ `SpanKey` | — | plan items only | renderer otherwise agnostic |
| `RowHeaderDiscreteTree` | — | — | ✅ | ✅ | — | — | |
| `generateDiscreteTreeUtil` & subtrees | — | — | ✅ called per source | *local* | ✅ namespaced groups | ⚠️ directive mode = directive roots (✅ for non-default) | |
| `applyActivityLayerFilter` & co | — | — | — | — | — (types passed in) | Name/Tags/Goal fields directive-only | pure; unchanged |
| `ActivityFilterBuilder` | ✅ S1 | ✅ | ✅ `sourceCatalog` prop | *local* | ✅ | directive count only for plan | |
| `TimelineLayerEditor` | ✅ | ✅ | ✅ Source control (activity + resource) | — | ✅ prunes to catalog | — | |
| `TimelineEditorPanel` | — | — | ✅ | — | — | — | single update for source + filter |
| `TimelineTooltip` | — | ✅ | ✅ Source row | ✅ parent per source | ⚠️ overflow groups by type | — | |
| `TimelineContextMenu` | ⚠️ sim start/end actions | ⚠️ | ✅ | ✅ | — | ✅ hidden for imported | |
| `TimelinePanel` selection | intrinsic | intrinsic | ✅ | ✅ `selectedSourceSpan` + key | — | — | |
| `selectedSpanId` / `selectedSpan` stores | ⚠️ intrinsic | ⚠️ | ⚠️ | *local* (plan-scoped by rule) | — | ✅ | should derive from `selectedIntervalRef` |
| `ActivityFormPanel` | ⚠️ | ⚠️ | ✅ imported → details | *local* | — | ✅ | |
| `ActivitySpanForm` / Decomposition / spans table | ⚠️ | ⚠️ | ⚠️ plan only | *local* | ⚠️ model types | ⚠️ | correct to stay plan-only |
| `ImportedIntervalDetails` (spike) | — | — | ✅ | ✅ | — | — | seam for a neutral details UI |
| `TimelineHistogram` | ⚠️ | ⚠️ plan spans | ⚠️ | *local* | — | — | imported spans not shown |
| `Row` drop / `viewAddFilterToRow` | ⚠️ creates directives | — | ✅ plan-bound layers only | — | ✅ | ⚠️ | `TimelineItemList` layer picker still lists all layers |
| `TimelineItemsPanel` activity list | ⚠️ plan types only | — | ⚠️ no source picker | — | ⚠️ | ⚠️ | resources have one (S2) |
| `stores/timelineSources` registry | intrinsic (plan page) | — | ✅ | ✅ | ✅ | `hasDirectives` | |
| external events | ⚠️ plan-linked | — | ⚠️ single store | — | ⚠️ | — | untouched, next namespace |
| `ui.view` / v3 schema | ⚠️ `definition.plan.*` | — | ✅ layer `sourceId` | — | — | — | schema widened in place; v4 needed |

---

## 5. Explicit decisions and temporary workarounds

- **Slots are faked by URL** (`?source.<slot>=standalone:<id>`). No binding table exists; the saved view stores only slot names.
- **Default-source data comes via Row props**, so the legacy path is untouched. The registry duplicates it for catalog and lookups.
- **Eager whole-dataset interval load.** There are no range queries and no LOD.
- **The imported catalog** is `ActivityType`-shaped: names only, or inferred from `attributes.arguments`. Nothing is written to `merlin.activity_type`, and no fake model is created.
- **Selection:** a separate store for imported spans. `selectedSpanId` is left plan-scoped.
- **Canonical stored form:** a default-source activity layer has no `sourceId`.
- **The v3 schema was widened in place** instead of versioned.
- **View bounds = Plan bounds** (as in Spike 2).

## 6. Bugs and hazards found

New in Spike 3. All are latent in single-source PlanDev; they became visible with a second namespace.

1. **The context menu resolved spans via the plan `spansMap` by id**, so right-clicking any non-plan span targets the plan span with that id. Fixed.
2. **Context menu span times used `sim start + start_offset`**, which is wrong for spans whose offsets are relative to another origin. Fixed (absolute times).
3. **The drop-to-row type check and target layer ignored layer binding.** Fixed.
4. **`directive` hierarchy mode hides every span without a directive.** This is pre-existing, and also affects Spike 1's standalone page. Fixed only for non-default sources.
5. **Source switch vs "empty filter = all types":** pruning selections can silently widen a layer. Handled by keeping unknown types; the filter model lacks "match nothing".
6. **`handleUpdateLayerProperty` spreads a captured layer**, so two consecutive updates to one layer lose the first. Worked around with a single combined update.
7. **The view schema rejects `sourceId` on activity layers**, and save doesn't validate. Spike 2's bug 6, again.
8. **The filter builder can't display or edit Parameter filters whose parameter isn't declared** in the catalog, although they still evaluate.
9. **Subsystem filters store tag ids**, which are not portable across sources or revisions.
10. **Tooltip overflow aggregation groups by type across sources.** Cosmetic; not fixed.

Still open from Spikes 1–2: `merlin.delete_partitions()` search_path (not fixed); the S1 `hasActivityLayer` fix, S1 null-gap sampling fix and S2 status-key collision fix remain spike-branch-only. The standalone/plan_dataset ownership caveat (S1 §6) is still avoided by never attaching through `plan_dataset`.

## 7. Recommended production shape (update to Spike 2 §8)

```
TimelineSource        { id: SlotId, label, binding, capabilities: {
                          resources?: { catalog, provider },
                          intervals?: { catalog: IntervalType[], provider /* subscribeIntervals(range) */ },
                          directives?: true } }
SpanRef               { sourceId, spanId }        // one timeline selection: selectedIntervalRef
ActivityLayer (v4)    { sourceId?: SlotId, filter: { activity: <unchanged> } }
ResourceLayer (v4)    { filter: { resource: { slot, name } | "name" } }
View (v4)             { sources: [{ slot, kind, label }], ... }
Binding (backend)     (analysis|plan, slot) -> artifact revision   // non-owning reference
```

Keep `ActivityType` as the catalog shape only until a neutral interval-type descriptor exists. Imported types need declared parameters for the builder (Q9); Subsystem needs a portable, name-based representation (Q10).

---

## Appendix: how to run

```bash
# DB (after the Spike 1 and Spike 2 fixtures)
psql ... -f deployment/spike/spike3_multisource_intervals_fixture.sql

# UI (plandev-ui, branch claude/hopeful-cannon-cki37d)
/plans/2?viewId=3                                   # legacy view: unchanged
/plans/2?viewId=4&source.tour=standalone:10         # hard-coded overlay
/plans/2?viewId=5&source.tour=standalone:10         # saved after edits
/plans/2?viewId=5&source.tour=standalone:11         # same view, tour revision r2
/plans/2?viewId=5                                   # no binding -> "Source "tour" is not available"
/plans/2?viewId=6&source.tour=standalone:10&source.tour.catalog=inferred   # richer filters, editable
# optional: &startTime=2029-01-03T03:30:00Z&endTime=2029-01-03T06:00:00Z  to zoom on the overlap
```
