import { seqnBuilder } from '../../src/builders/seqnBuilder';
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
        { ...expandedActivities[0], expansionResult: 'A2025-001T00:00:05 CMD_B\nA2025-001T00:00:00 CMD_A' },
        { ...expandedActivities[1], expansionResult: 'A2025-001T00:00:01 CMD_C\n@METADATA "note" "mine"' },
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
});
