import type { SimulatedActivity } from '../batchLoaders/simulatedActivityBatchLoader.js';
import { Mustache } from '../mustache/util/index.js';
import { stringifyActivity } from '../mustache/util/activity.js';
import { SequencingLanguage } from '../mustache/enums/language.js';
import type { ExpandedActivity, SeqBuilder } from '../../types/seqBuilder.js';
import { seqnBuilder } from '../../builders/seqnBuilder.js';
import { stolBuilder } from '../../builders/stolBuilder.js';
import { concatBuilder } from '../../builders/concatBuilder.js';

/*
 * The single implementation of Sequence Template expansion, shared by first-class Generations and the legacy
 * `expand-all-sequence-templates` endpoint. It operates purely on already-resolved inputs: it does not read the
 * database, so a caller controls exactly which activities and template contents are used.
 */

export type ResolvedTemplate = {
  definition: string;
  templateId?: number;
  definitionHash?: string;
};

export type ExpandedBlock = {
  activity: SimulatedActivity;
  template: ResolvedTemplate;
  expansion: string;
};

export type ExpansionFailure = {
  activity: SimulatedActivity;
  message: string;
};

export type ExpandResolvedActivitiesResult = {
  /** The built sequence, or null if expansion or building failed. */
  sequence: string | null;
  /** Successfully expanded activities, in output (start offset) order. */
  blocks: ExpandedBlock[];
  /** Activities with no template for their type, grouped by type. */
  missing: { activityType: string; activities: SimulatedActivity[] }[];
  /** Activities whose template failed to execute. */
  failures: ExpansionFailure[];
  /** Set if every activity expanded but the sequence builder failed. */
  buildError: string | null;
};

export function getSeqBuilder(language: string): { name: string; builder: SeqBuilder<string, string> } | null {
  switch (language) {
    case SequencingLanguage.STOL:
      return { name: 'stolBuilder', builder: stolBuilder };
    case SequencingLanguage.SEQN:
      return { name: 'seqnBuilder', builder: seqnBuilder };
    case SequencingLanguage.TEXT:
      return { name: 'concatBuilder', builder: concatBuilder };
    default:
      return null;
  }
}

export function sortByStartOffset<T extends { startOffset: Temporal.Duration }>(activities: T[]): T[] {
  return [...activities].sort((a, b) => Temporal.Duration.compare(a.startOffset, b.startOffset));
}

/**
 * Expand each activity with the template for its activity type, sort by start offset and build the sequence.
 *
 * With `missingTemplate: 'error'`, any activity without a template, or any template failure, means no sequence is
 * built. With `missingTemplate: 'skip'` (legacy behavior), activities without templates are left out of the output.
 */
export function expandResolvedActivities(opts: {
  activities: SimulatedActivity[];
  templatesByActivityType: Record<string, ResolvedTemplate>;
  language: SequencingLanguage;
  seqId: string;
  seqMetadata: Record<string, unknown>;
  simulationDatasetId: number;
  missingTemplate: 'skip' | 'error';
}): ExpandResolvedActivitiesResult {
  const seqBuilder = getSeqBuilder(opts.language);
  if (seqBuilder === null) {
    throw new Error(`Unsupported sequence language "${opts.language}"`);
  }

  const missingByType = new Map<string, SimulatedActivity[]>();
  const failures: ExpansionFailure[] = [];
  const blocks: ExpandedBlock[] = [];
  const compiled = new Map<string, Mustache>();

  for (const activity of sortByStartOffset(opts.activities)) {
    const template = opts.templatesByActivityType[activity.activityTypeName];
    if (template === undefined) {
      const missing = missingByType.get(activity.activityTypeName) ?? [];
      missing.push(activity);
      missingByType.set(activity.activityTypeName, missing);
      continue;
    }

    try {
      let mustache = compiled.get(activity.activityTypeName);
      if (mustache === undefined) {
        mustache = new Mustache(template.definition, opts.language);
        compiled.set(activity.activityTypeName, mustache);
      }
      // NOTE: undefined variables are not errors, i.e. "CMD {{ dsvsdfs }}" expands to "CMD ".
      mustache.setLanguage(opts.language);
      blocks.push({ activity, template, expansion: mustache.execute(stringifyActivity(activity)) });
    } catch (e) {
      failures.push({ activity, message: e instanceof Error ? e.message : String(e) });
    }
  }

  const missing = [...missingByType.entries()].map(([activityType, activities]) => ({ activityType, activities }));

  if (failures.length > 0 || (opts.missingTemplate === 'error' && missing.length > 0)) {
    return { sequence: null, blocks, missing, failures, buildError: null };
  }

  const expandedActivities: ExpandedActivity<string>[] = blocks.map(block => ({
    ...block.activity,
    expansionResult: block.expansion,
    errors: [],
  }));

  try {
    const sequence = seqBuilder.builder(expandedActivities, opts.seqId, opts.seqMetadata, opts.simulationDatasetId);
    return { sequence, blocks, missing, failures, buildError: null };
  } catch (e) {
    return { sequence: null, blocks, missing, failures, buildError: e instanceof Error ? e.message : String(e) };
  }
}
