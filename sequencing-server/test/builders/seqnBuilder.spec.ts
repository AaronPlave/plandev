import { seqnBuilder } from '../../src/builders/seqnBuilder';
import Ajv2020 from 'ajv/dist/2020';
import { readFileSync } from 'fs';
import { seqnToSeqJson } from '../../src/lib/parsing/seqn/seqnToSeqJson';
import type { ExpandedActivity } from '../../src/types/seqBuilder';

describe('seqn merging', () => {
  const expandedActivities: ExpandedActivity<string>[] = [
    {
      id: 1,
      simulationDatasetId: 1,
      simulationDataset: {
        simulation: {
          planId: 1,
        },
      },
      attributes: {
        arguments: {},
        computed: {},
        directiveId: 1,
      },
      duration: null,
      startOffset: Temporal.Duration.from({ seconds: 0 }),
      startTime: Temporal.Instant.from('2025-01-01T00:00:00Z'),
      endTime: Temporal.Instant.from('2025-01-01T00:00:01Z'),
      activityTypeName: 'bread',
      expansionResult: 'A2025-001T00:00:00 CMD_NO_OP',
      errors: [],
    },
    {
      id: 2,
      simulationDatasetId: 1,
      simulationDataset: {
        simulation: {
          planId: 1,
        },
      },
      attributes: {
        arguments: {},
        computed: {},
        directiveId: 1,
      },
      duration: null,
      startOffset: Temporal.Duration.from({ seconds: 0 }),
      startTime: Temporal.Instant.from('2025-01-01T00:00:01Z'),
      endTime: Temporal.Instant.from('2025-01-01T00:00:02Z'),
      activityTypeName: 'bread',
      expansionResult: 'A2025-001T00:00:01 CMD_NO_OP',
      errors: [],
    },
  ];

  it('should merge seqn snippets', async () => {
    const mergedSequence = seqnBuilder(expandedActivities, 'test', {}, 1);
    expect(mergedSequence).toEqual(
      [
        '@ID "test"',
        '@METADATA "planId" 1',
        '@METADATA "simulationDatasetId" 1',
        '@METADATA "timeSorted" true',
        '',
        'A2025-001T00:00:00.000 CMD_NO_OP',
        '@METADATA "simulatedActivityId" 1',
        'A2025-001T00:00:01.000 CMD_NO_OP',
        '@METADATA "simulatedActivityId" 2',
        '',
      ].join('\n'),
    );
  });

  it('should operate on a single activity instance', async () => {
    const mergedSequence = seqnBuilder(expandedActivities.slice(0, 1), 'test', {}, 1);
    expect(mergedSequence).toEqual(
      [
        '@ID "test"',
        '@METADATA "planId" 1',
        '@METADATA "simulationDatasetId" 1',
        '@METADATA "timeSorted" true',
        '',
        'A2025-001T00:00:00.000 CMD_NO_OP',
        '@METADATA "simulatedActivityId" 1',
        '',
      ].join('\n'),
    );
  });

  it('says which activity each command came from, wherever sorting puts it', async () => {
    const mergedSequence = seqnBuilder(
      [
        { ...expandedActivities[0]!, expansionResult: 'A2025-001T00:00:05 CMD_B\nA2025-001T00:00:00 CMD_A' },
        { ...expandedActivities[1]!, expansionResult: 'A2025-001T00:00:01 CMD_C\n@METADATA "note" "mine"' },
      ],
      'test',
      {},
      1,
    );
    expect(mergedSequence).toEqual(
      [
        '@ID "test"',
        '@METADATA "planId" 1',
        '@METADATA "simulationDatasetId" 1',
        '@METADATA "timeSorted" true',
        '',
        'A2025-001T00:00:00.000 CMD_A',
        '@METADATA "simulatedActivityId" 1',
        'A2025-001T00:00:01.000 CMD_C',
        '@METADATA "note" "mine"',
        '@METADATA "simulatedActivityId" 2',
        'A2025-001T00:00:05.000 CMD_B',
        '@METADATA "simulatedActivityId" 1',
        '',
      ].join('\n'),
    );
  });

  it('places command-relative commands from their activity start, sorts them, and keeps the activity of each', async () => {
    const mergedSequence = seqnBuilder(
      [
        { ...expandedActivities[0]!, expansionResult: 'A2025-001T00:00:00 CMD_A 1 "x"\nR00:00:10 CMD_B' },
        { ...expandedActivities[1]!, expansionResult: 'R00:00:01 CMD_C' },
      ],
      'test',
      {},
      1,
    );
    expect(mergedSequence).toEqual(
      [
        '@ID "test"',
        '@METADATA "planId" 1',
        '@METADATA "simulationDatasetId" 1',
        '@METADATA "timeSorted" true',
        '',
        'A2025-001T00:00:00.000 CMD_A 1 "x"',
        '@METADATA "simulatedActivityId" 1',
        // Activity 2 starts at 00:00:01; its R1s command is placed at 00:00:02.
        'A2025-001T00:00:02.000 CMD_C',
        '@METADATA "simulatedActivityId" 2',
        // CMD_B is 10 s after CMD_A.
        'A2025-001T00:00:10.000 CMD_B',
        '@METADATA "simulatedActivityId" 1',
        '',
      ].join('\n'),
    );
  });

  it('produces SeqN that converts to schema-valid seqJSON with the attribution and arguments intact', async () => {
    const mergedSequence = seqnBuilder(
      [
        { ...expandedActivities[0]!, expansionResult: 'A2025-001T00:00:05 CMD_B 2\nA2025-001T00:00:00 CMD_A 1 "x"' },
        { ...expandedActivities[1]!, expansionResult: 'A2025-001T00:00:01 CMD_C' },
      ],
      'test',
      {},
      1,
    );
    const seqJson = seqnToSeqJson(mergedSequence, 'test.seqN.txt').toSeqJson();
    const schema = JSON.parse(
      readFileSync(new URL('../../node_modules/@nasa-jpl/seq-json-schema/schema.json', import.meta.url), 'utf8'),
    );
    const validate = new Ajv2020({ strict: false }).compile(schema);
    validate(seqJson);
    expect(validate.errors ?? []).toEqual([]);
    const steps = seqJson.steps as { args: { value: unknown }[]; metadata?: Record<string, unknown>; stem: string }[];
    expect(steps.map(step => [step.stem, step.args.map(arg => arg.value), step.metadata?.['simulatedActivityId']])).toEqual(
      [
        ['CMD_A', [1, 'x'], 1],
        ['CMD_C', [], 2],
        ['CMD_B', [2], 1],
      ],
    );
  });
});
