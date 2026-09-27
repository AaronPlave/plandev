import { createHash } from 'node:crypto';
import type { GraphQLClient } from 'graphql-request';
import { insertActivityDirective } from './testUtils/ActivityDirective.js';
import { insertDictionary, removeDictionary } from './testUtils/Dictionary';
import { createSequenceFilter, insertSequenceTemplate } from './testUtils/SequenceTemplate';
import { removeMissionModel, uploadMissionModel } from './testUtils/MissionModel.js';
import { createPlan, removePlan } from './testUtils/Plan.js';
import { executeSimulation, updateSimulationBounds } from './testUtils/Simulation.js';
import { getGraphQLClient } from './testUtils/testUtils';
import { insertParcel, removeParcel } from './testUtils/Parcel';
import {
  generateSequence,
  generateSequencePreflight,
  getGeneration,
  getGenerationsForPlan,
  removeSequenceTemplates,
  runSql,
  updateSequenceTemplateDefinition,
} from './testUtils/Generation';
import { DictionaryType } from '../src/types/types';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

let planId: number;
let graphqlClient: GraphQLClient;
let missionModelId: number;
let commandDictionaryId: number;
let channelDictionaryId: number;
let parameterDictionaryId: number;
let parcelId: number;

const STOL = 'STOL';
const GROW_TEMPLATE = 'CMD PARAM_GROW={{ attributes.arguments.growingDuration }}';
const BAKE_TEMPLATE = 'CMD PARAM_BAKE={{ attributes.arguments.temperature }}';

beforeAll(async () => {
  graphqlClient = await getGraphQLClient();
  commandDictionaryId = (await insertDictionary(graphqlClient, DictionaryType.COMMAND)).command.id;
  channelDictionaryId = (await insertDictionary(graphqlClient, DictionaryType.CHANNEL)).channel.id;
  parameterDictionaryId = (await insertDictionary(graphqlClient, DictionaryType.PARAMETER)).parameter.id;
  parcelId = (
    await insertParcel(graphqlClient, commandDictionaryId, channelDictionaryId, parameterDictionaryId, 'generationTestParcel')
  ).parcelId;
});

beforeEach(async () => {
  missionModelId = await uploadMissionModel(graphqlClient);
  planId = await createPlan(graphqlClient, missionModelId);
  await updateSimulationBounds(graphqlClient, {
    plan_id: planId,
    simulation_start_time: '2020-001T00:00:00Z',
    simulation_end_time: '2020-002T00:00:00Z',
  });
});

afterEach(async () => {
  await removeSequenceTemplates(graphqlClient, missionModelId);
  await removePlan(graphqlClient, planId);
  await removeMissionModel(graphqlClient, missionModelId);
});

afterAll(async () => {
  await removeParcel(graphqlClient, parcelId);
  await removeDictionary(graphqlClient, commandDictionaryId, DictionaryType.COMMAND);
  await removeDictionary(graphqlClient, channelDictionaryId, DictionaryType.CHANNEL);
  await removeDictionary(graphqlClient, parameterDictionaryId, DictionaryType.PARAMETER);
});

async function insertGrowAndBakeTemplates(): Promise<{ growTemplateId: number; bakeTemplateId: number }> {
  const growTemplateId = await insertSequenceTemplate(graphqlClient, 'GrowBanana.tpl', parcelId, missionModelId, 'GrowBanana', STOL, GROW_TEMPLATE);
  const bakeTemplateId = await insertSequenceTemplate(graphqlClient, 'BakeBananaBread.tpl', parcelId, missionModelId, 'BakeBananaBread', STOL, BAKE_TEMPLATE);
  return { growTemplateId, bakeTemplateId };
}

describe('sequence generation', () => {
  it('generates a sequence from multiple selected activity directives', async () => {
    await insertGrowAndBakeTemplates();
    const bakeId = await insertActivityDirective(graphqlClient, planId, 'BakeBananaBread', '2 minutes', { temperature: 350, tbSugar: 1, glutenFree: true });
    const growId = await insertActivityDirective(graphqlClient, planId, 'GrowBanana', '1 minute', { quantity: 1, growingDuration: 10000000 });
    const { simulationDatasetId } = await executeSimulation(graphqlClient, planId);

    const result = await generateSequence(graphqlClient, {
      planId,
      sequenceId: 'E17_MINI',
      selection: { type: 'activity-directives', ids: [bakeId, growId] },
      metadata: { purpose: 'test' },
    });

    expect(result.status).toEqual('success');
    expect(result.generatedProductIds).toHaveLength(1);

    const generation = await getGeneration(graphqlClient, result.generationId);
    expect(generation.status).toEqual('success');
    expect(generation.completed_at).not.toBeNull();
    expect(generation.requested_seq_id).toEqual('E17_MINI');
    expect(generation.simulation_dataset_id).toEqual(simulationDatasetId);
    expect(generation.request_snapshot).toEqual({
      planId,
      simulationDatasetId: null,
      sequenceId: 'E17_MINI',
      selection: { type: 'activity-directives', ids: [bakeId, growId] },
      metadata: { purpose: 'test' },
    });

    // Generated product: identity is its own id, output in start-offset order
    expect(generation.products).toHaveLength(1);
    const product = generation.products[0]!;
    expect(product.id).toEqual(result.generatedProductIds[0]);
    expect(product.product_key).toEqual('default');
    expect(product.seq_id).toEqual('E17_MINI');
    expect(product.language).toEqual(STOL);
    expect(product.rendered_output).toEqual('CMD PARAM_GROW=PT10S\nCMD PARAM_BAKE=350');
    expect(product.output_hash).toEqual(sha256(product.rendered_output));

    // Expansion-block provenance: source activity -> expanded block, in output order
    expect(product.source_blocks.map(b => [b.directiveId, b.activityType, b.expansion])).toEqual([
      [growId, 'GrowBanana', 'CMD PARAM_GROW=PT10S'],
      [bakeId, 'BakeBananaBread', 'CMD PARAM_BAKE=350'],
    ]);
  });

  it('persists the source snapshot', async () => {
    await insertGrowAndBakeTemplates();
    const growId = await insertActivityDirective(graphqlClient, planId, 'GrowBanana');
    const { simulationDatasetId, simulationId } = await executeSimulation(graphqlClient, planId);

    const { generationId } = await generateSequence(graphqlClient, {
      planId,
      sequenceId: 'SRC',
      selection: { type: 'activity-directives', ids: [growId] },
    });
    const { source_snapshot: source } = await getGeneration(graphqlClient, generationId);

    expect(source.sourceType).toEqual('plandev-simulation');
    expect(source.provenance).toEqual('complete');
    expect(source.identifiers).toMatchObject({ planId, simulationDatasetId, simulationId });
    expect(typeof source.revisions.planRevision).toEqual('number');
    expect(typeof source.revisions.modelRevision).toEqual('number');
    expect(source.time.simulationStartTime).toMatch(/^2020-01-01T00:00:00/);
    expect(source.selection).toEqual({ type: 'activity-directives', requestedDirectiveIds: [growId] });
    expect(source.activities).toHaveLength(1);
    expect(source.activities[0]).toMatchObject({ directiveId: growId, activityType: 'GrowBanana' });
  });

  it('persists the template and environment snapshot', async () => {
    const { growTemplateId } = await insertGrowAndBakeTemplates();
    const growId = await insertActivityDirective(graphqlClient, planId, 'GrowBanana');
    await executeSimulation(graphqlClient, planId);

    const { generationId } = await generateSequence(graphqlClient, {
      planId,
      sequenceId: 'ENV',
      selection: { type: 'activity-directives', ids: [growId] },
    });
    const { expansion_snapshot: expansion } = await getGeneration(graphqlClient, generationId);

    expect(expansion.generator).toMatchObject({ name: 'sequencing-server', expansion: 'sequence-template', builder: 'stolBuilder' });
    expect(typeof expansion.generator.version).toEqual('string');
    expect(expansion.model).toMatchObject({ id: missionModelId });
    expect(typeof expansion.model.revision).toEqual('number');
    expect(expansion.language).toEqual(STOL);
    // Only the templates actually used are captured, with their full content and hash
    expect(expansion.templates).toEqual([
      expect.objectContaining({
        templateId: growTemplateId,
        activityType: 'GrowBanana',
        parcelId,
        definition: GROW_TEMPLATE,
        definitionHash: sha256(GROW_TEMPLATE),
      }),
    ]);
    expect(expansion.parcels).toHaveLength(1);
    expect(expansion.parcels[0]).toMatchObject({
      parcelId,
      commandDictionary: expect.objectContaining({ id: commandDictionaryId }),
      channelDictionary: expect.objectContaining({ id: channelDictionaryId }),
      parameterDictionaries: [expect.objectContaining({ id: parameterDictionaryId })],
    });
    expect(expansion.coverage).toMatchObject({ activities: 1, expandable: 1, missing: 0, missingActivityTypes: [] });
  });

  it('generates the same seq_id multiple times against the same simulation as separate generations and products', async () => {
    await insertGrowAndBakeTemplates();
    const growId = await insertActivityDirective(graphqlClient, planId, 'GrowBanana');
    const { simulationDatasetId } = await executeSimulation(graphqlClient, planId);

    const request = {
      planId,
      simulationDatasetId,
      sequenceId: 'SAME_SEQ',
      selection: { type: 'activity-directives' as const, ids: [growId] },
    };
    const first = await generateSequence(graphqlClient, request);
    const second = await generateSequence(graphqlClient, request);

    expect(first.status).toEqual('success');
    expect(second.status).toEqual('success');
    expect(second.generationId).not.toEqual(first.generationId);
    expect(second.generatedProductIds[0]).not.toEqual(first.generatedProductIds[0]);

    const [a, b] = await Promise.all([getGeneration(graphqlClient, first.generationId), getGeneration(graphqlClient, second.generationId)]);
    expect(a.products[0]!.seq_id).toEqual('SAME_SEQ');
    expect(b.products[0]!.seq_id).toEqual('SAME_SEQ');
    expect(a.simulation_dataset_id).toEqual(b.simulation_dataset_id);
  });

  it('fails visibly with a structured diagnostic when an activity has no template', async () => {
    await insertSequenceTemplate(graphqlClient, 'GrowBanana.tpl', parcelId, missionModelId, 'GrowBanana', STOL, GROW_TEMPLATE);
    const growId = await insertActivityDirective(graphqlClient, planId, 'GrowBanana');
    const peelId = await insertActivityDirective(graphqlClient, planId, 'PeelBanana', '1 minute');
    await executeSimulation(graphqlClient, planId);

    const preflight = await generateSequencePreflight(graphqlClient, {
      planId,
      sequenceId: 'MISSING',
      selection: { type: 'activity-directives', ids: [growId, peelId] },
    });
    expect(preflight.ok).toEqual(false);
    expect(preflight.expansion.coverage).toMatchObject({ activities: 2, expandable: 1, missing: 1, missingActivityTypes: ['PeelBanana'] });

    const result = await generateSequence(graphqlClient, {
      planId,
      sequenceId: 'MISSING',
      selection: { type: 'activity-directives', ids: [growId, peelId] },
    });
    expect(result.status).toEqual('failed');
    expect(result.generatedProductIds).toEqual([]);

    const generation = await getGeneration(graphqlClient, result.generationId);
    expect(generation.status).toEqual('failed');
    expect(generation.products).toEqual([]);
    expect(generation.error).toMatchObject({ code: 'MISSING_EXPANSION' });
    const missing = generation.diagnostics.find(d => d.code === 'MISSING_EXPANSION');
    expect(missing).toMatchObject({ severity: 'error', activityType: 'PeelBanana', directiveIds: [peelId] });
    expect(missing.sourceActivityIds).toHaveLength(1);
    // The resolved snapshots are retained for inspection
    expect(generation.source_snapshot.activities).toHaveLength(2);
  });

  it('records a failed generation when a template fails to expand', async () => {
    await insertSequenceTemplate(graphqlClient, 'GrowBanana.tpl', parcelId, missionModelId, 'GrowBanana', STOL, 'CMD PARAM_GROW=-1 {{ param }');
    const growId = await insertActivityDirective(graphqlClient, planId, 'GrowBanana');
    await executeSimulation(graphqlClient, planId);

    const result = await generateSequence(graphqlClient, {
      planId,
      sequenceId: 'BROKEN',
      selection: { type: 'activity-directives', ids: [growId] },
    });
    expect(result.status).toEqual('failed');

    const generation = await getGeneration(graphqlClient, result.generationId);
    expect(generation.error).toMatchObject({ code: 'EXPANSION_FAILED' });
    expect(generation.diagnostics[0]).toMatchObject({ code: 'EXPANSION_FAILED', activityType: 'GrowBanana', directiveIds: [growId] });
    expect(generation.products).toEqual([]);
  });

  it('preserves a failed generation; a retry creates a new generation', async () => {
    const growId = await insertActivityDirective(graphqlClient, planId, 'GrowBanana');
    await executeSimulation(graphqlClient, planId);
    const request = { planId, sequenceId: 'RETRY', selection: { type: 'activity-directives' as const, ids: [growId] } };

    const failed = await generateSequence(graphqlClient, request);
    expect(failed.status).toEqual('failed');

    await insertSequenceTemplate(graphqlClient, 'GrowBanana.tpl', parcelId, missionModelId, 'GrowBanana', STOL, GROW_TEMPLATE);
    const retried = await generateSequence(graphqlClient, request);
    expect(retried.status).toEqual('success');
    expect(retried.generationId).toBeGreaterThan(failed.generationId);

    const generations = await getGenerationsForPlan(graphqlClient, planId);
    expect(generations).toEqual([
      { id: failed.generationId, status: 'failed' },
      { id: retried.generationId, status: 'success' },
    ]);
    const original = await getGeneration(graphqlClient, failed.generationId);
    expect(original.error).toMatchObject({ code: 'MISSING_EXPANSION' });

    // Finished generations and products cannot be modified at the database level
    await expect(runSql(`update sequencing.generation set status = 'success' where id = ${failed.generationId}`)).rejects.toThrow(/cannot be modified/);
    await expect(runSql(`update sequencing.generated_product set rendered_output = 'x' where id = ${retried.generatedProductIds[0]}`)).rejects.toThrow(/cannot be modified/);
  });

  it('fails when the requested simulation is not complete', async () => {
    await insertGrowAndBakeTemplates();
    const growId = await insertActivityDirective(graphqlClient, planId, 'GrowBanana');
    const { simulationDatasetId } = await executeSimulation(graphqlClient, planId);
    await runSql(`update merlin.simulation_dataset set status = 'incomplete' where id = ${simulationDatasetId}`);

    const result = await generateSequence(graphqlClient, {
      planId,
      simulationDatasetId,
      sequenceId: 'INCOMPLETE',
      selection: { type: 'activity-directives', ids: [growId] },
    });
    expect(result.status).toEqual('failed');
    expect(result.diagnostics[0]).toMatchObject({ code: 'SIMULATION_NOT_COMPLETE' });
  });

  it('rejects a simulation dataset from another plan without recording a generation', async () => {
    await insertGrowAndBakeTemplates();
    const growId = await insertActivityDirective(graphqlClient, planId, 'GrowBanana');
    await executeSimulation(graphqlClient, planId);
    const otherPlanId = await createPlan(graphqlClient, missionModelId);
    try {
      await updateSimulationBounds(graphqlClient, {
        plan_id: otherPlanId,
        simulation_start_time: '2020-001T00:00:00Z',
        simulation_end_time: '2020-002T00:00:00Z',
      });
      const other = await executeSimulation(graphqlClient, otherPlanId);

      await expect(
        generateSequence(graphqlClient, {
          planId,
          simulationDatasetId: other.simulationDatasetId,
          sequenceId: 'MISMATCH',
          selection: { type: 'activity-directives', ids: [growId] },
        }),
      ).rejects.toThrow();
      expect(await getGenerationsForPlan(graphqlClient, planId)).toEqual([]);
    } finally {
      await removePlan(graphqlClient, otherPlanId);
    }
  });

  it('expands only the top-level simulated activity of a selected directive', async () => {
    await insertSequenceTemplate(graphqlClient, 'parent.tpl', parcelId, missionModelId, 'parent', STOL, 'CMD PARENT');
    const parentId = await insertActivityDirective(graphqlClient, planId, 'parent');
    await executeSimulation(graphqlClient, planId);

    // 'parent' decomposes into children with no templates; they are not part of the selection.
    const result = await generateSequence(graphqlClient, {
      planId,
      sequenceId: 'PARENT',
      selection: { type: 'activity-directives', ids: [parentId] },
    });
    expect(result.status).toEqual('success');
    const generation = await getGeneration(graphqlClient, result.generationId);
    expect(generation.products[0]!.rendered_output).toEqual('CMD PARENT');
  });

  it('generates from an existing sequence filter', async () => {
    await insertGrowAndBakeTemplates();
    await insertActivityDirective(graphqlClient, planId, 'GrowBanana');
    await insertActivityDirective(graphqlClient, planId, 'BakeBananaBread', '1 minute', { temperature: 350, tbSugar: 1, glutenFree: true });
    await executeSimulation(graphqlClient, planId);
    const filterId = await createSequenceFilter(graphqlClient, { static_types: ['BakeBananaBread'] }, 'bake filter', missionModelId);

    const result = await generateSequence(graphqlClient, {
      planId,
      sequenceId: 'FILTERED',
      selection: { type: 'filter', filterId },
    });
    expect(result.status).toEqual('success');
    const generation = await getGeneration(graphqlClient, result.generationId);
    expect(generation.products[0]!.rendered_output).toEqual('CMD PARAM_BAKE=350');
    expect(generation.source_snapshot.selection.filter).toMatchObject({ id: filterId, filter: { static_types: ['BakeBananaBread'] } });
    expect(generation.source_snapshot.time.selectionTimeRange).not.toBeNull();
  });

  it('keeps a generation\'s provenance and product unambiguous after its template changes', async () => {
    const { growTemplateId } = await insertGrowAndBakeTemplates();
    const growId = await insertActivityDirective(graphqlClient, planId, 'GrowBanana');
    await executeSimulation(graphqlClient, planId);
    const request = { planId, sequenceId: 'REPRO', selection: { type: 'activity-directives' as const, ids: [growId] } };

    // 1. Generate with template contents A
    const genN = await generateSequence(graphqlClient, request);
    // 2. Change the template to B
    const TEMPLATE_B = 'CMD PARAM_GROW_B';
    await updateSequenceTemplateDefinition(graphqlClient, growTemplateId, TEMPLATE_B);

    // 3/4. Generation N still identifies A, and its product is unchanged
    const n = await getGeneration(graphqlClient, genN.generationId);
    expect(n.expansion_snapshot.templates[0]).toMatchObject({ templateId: growTemplateId, definition: GROW_TEMPLATE, definitionHash: sha256(GROW_TEMPLATE) });
    expect(n.products[0]!.source_blocks[0]).toMatchObject({ templateId: growTemplateId, templateHash: sha256(GROW_TEMPLATE) });
    expect(n.products[0]!.rendered_output).toEqual('CMD PARAM_GROW=PT3600S');

    // 5/6. Generating again produces generation N+1, which identifies B
    const genN1 = await generateSequence(graphqlClient, request);
    const n1 = await getGeneration(graphqlClient, genN1.generationId);
    expect(n1.expansion_snapshot.templates[0]).toMatchObject({ templateId: growTemplateId, definition: TEMPLATE_B, definitionHash: sha256(TEMPLATE_B) });
    expect(n1.products[0]!.source_blocks[0]).toMatchObject({ templateHash: sha256(TEMPLATE_B) });
    expect(n1.products[0]!.rendered_output).toEqual(TEMPLATE_B);
  });

  it('never mixes old and new template contents when templates change during generation', async () => {
    const { growTemplateId, bakeTemplateId } = await insertGrowAndBakeTemplates();
    const growId = await insertActivityDirective(graphqlClient, planId, 'GrowBanana');
    const bakeId = await insertActivityDirective(graphqlClient, planId, 'BakeBananaBread', '1 minute', { temperature: 350, tbSugar: 1, glutenFree: true });
    await executeSimulation(graphqlClient, planId);

    const request = { planId, sequenceId: 'RACE', selection: { type: 'activity-directives' as const, ids: [growId, bakeId] } };
    // Race several generations against a template mutation that changes both templates in one transaction.
    const [results] = await Promise.all([
      Promise.all([1, 2, 3, 4].map(() => generateSequence(graphqlClient, request))),
      runSql(`
        update sequencing.sequence_template set template_definition = 'CMD GROW_V2' where id = ${growTemplateId};
        update sequencing.sequence_template set template_definition = 'CMD BAKE_V2' where id = ${bakeTemplateId};
      `),
    ]);

    for (const result of results) {
      expect(result.status).toEqual('success');
      const generation = await getGeneration(graphqlClient, result.generationId);
      const snapshotHashes = new Set(generation.expansion_snapshot.templates.map((t: any) => t.definitionHash));
      // Every block was expanded with exactly the template content recorded in the generation's snapshot...
      for (const block of generation.products[0]!.source_blocks) {
        expect(snapshotHashes.has(block.templateHash)).toBe(true);
      }
      // ...and the snapshot is entirely old or entirely new, never a mix.
      const output = generation.products[0]!.rendered_output;
      expect([
        'CMD PARAM_GROW=PT3600S\nCMD PARAM_BAKE=350',
        'CMD GROW_V2\nCMD BAKE_V2',
      ]).toContain(output);
    }
  });
});
