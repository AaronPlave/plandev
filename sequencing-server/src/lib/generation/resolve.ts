import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { mapGraphQLActivityInstance, type SimulatedActivity } from '../batchLoaders/simulatedActivityBatchLoader.js';
import type { GraphQLActivitySchema } from '../batchLoaders/activitySchemaBatchLoader.js';
import { applyActivityLayerFilter } from '../filters/utilities.js';
import type { SequenceFilter } from '../filters/types.js';
import { convertDoyToYmd } from '../mustache/util/time.js';
import type { SequencingLanguage } from '../mustache/enums/language.js';
import { getSeqBuilder } from '../expansion/expandResolvedActivities.js';
import {
  DiagnosticCode,
  type DictionarySnapshot,
  type ExpansionSnapshot,
  type GenerateSequenceRequest,
  type GenerationDiagnostic,
  type ParcelSnapshot,
  type ResolvedGeneration,
  type SourceSnapshot,
  type TemplateSnapshot,
} from './types.js';
import { GENERATOR_VERSION } from './version.js';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Thrown when a Generation cannot be resolved; carries the diagnostics explaining why. */
export class GenerationResolutionError extends Error {
  constructor(
    public readonly diagnostics: GenerationDiagnostic[],
    public readonly partial: { sourceSnapshot?: SourceSnapshot; expansionSnapshot?: ExpansionSnapshot } = {},
  ) {
    super(diagnostics.map(d => d.message).join('; '));
  }
}

type SpanRow = {
  id: number;
  parent_id: number | null;
  start_offset: string;
  duration: string | null;
  activity_type_name: string;
  attributes: any;
};

/**
 * Resolve every input a Generation needs, once.
 *
 * All reads happen inside a single REPEATABLE READ, read-only transaction, so the plan, simulation, activities,
 * templates, parcels and dictionaries are all read from one consistent database snapshot. A concurrent template or
 * configuration change is therefore either entirely visible to this generation or not at all; it can never observe a
 * mix of old and new inputs. Expansion afterwards only uses the returned (in-memory) snapshot.
 */
export async function resolveGeneration(
  client: PoolClient,
  request: GenerateSequenceRequest,
): Promise<ResolvedGeneration> {
  await client.query('begin transaction isolation level repeatable read read only');
  try {
    const resolved = await resolveInSnapshot(client, request);
    await client.query('commit');
    return resolved;
  } catch (e) {
    await client.query('rollback');
    throw e;
  }
}

async function resolveInSnapshot(client: PoolClient, request: GenerateSequenceRequest): Promise<ResolvedGeneration> {
  const diagnostics: GenerationDiagnostic[] = [];
  const fail = (diagnostic: Omit<GenerationDiagnostic, 'severity'>, partial = {}): never => {
    throw new GenerationResolutionError([...diagnostics, { severity: 'error', ...diagnostic }], partial);
  };

  // 1. Plan and mission model
  const plan = (
    await client.query<{
      id: number;
      revision: number;
      model_id: number | null;
      start_time: string;
      model_name: string | null;
      model_mission: string | null;
      model_version: string | null;
      model_revision: number | null;
    }>(
      `select p.id, p.revision, p.model_id, to_json(p.start_time)#>>'{}' as start_time,
              m.name as model_name, m.mission as model_mission, m.version as model_version, m.revision as model_revision
         from merlin.plan p
         left join merlin.mission_model m on m.id = p.model_id
        where p.id = $1`,
      [request.planId],
    )
  ).rows[0];
  if (plan === undefined) {
    return fail({ code: DiagnosticCode.PLAN_NOT_FOUND, message: `Plan ${request.planId} does not exist.` });
  }
  if (plan.model_id === null || plan.model_name === null) {
    return fail({ code: DiagnosticCode.PLAN_HAS_NO_MODEL, message: `Plan ${plan.id} has no mission model.` });
  }
  const modelId = plan.model_id;

  // 2. Simulation dataset
  const simulationQuery = `
    select sd.id, sd.simulation_id, sd.dataset_id, sd.status, sd.plan_revision, sd.model_revision,
           sd.simulation_revision, sd.simulation_template_revision, sd.dataset_revision, sd.requested_by,
           to_json(sd.requested_at)#>>'{}' as requested_at,
           to_json(sd.simulation_start_time)#>>'{}' as simulation_start_time,
           to_json(sd.simulation_end_time)#>>'{}' as simulation_end_time,
           s.plan_id
      from merlin.simulation_dataset sd
      join merlin.simulation s on s.id = sd.simulation_id`;
  type SimulationRow = {
    id: number;
    simulation_id: number;
    dataset_id: number | null;
    status: string;
    plan_revision: number;
    model_revision: number;
    simulation_revision: number;
    simulation_template_revision: number | null;
    dataset_revision: number | null;
    requested_by: string | null;
    requested_at: string;
    simulation_start_time: string;
    simulation_end_time: string;
    plan_id: number;
  };
  let simulation: SimulationRow | undefined;
  if (request.simulationDatasetId !== undefined && request.simulationDatasetId !== null) {
    simulation = (await client.query<SimulationRow>(`${simulationQuery} where sd.id = $1`, [request.simulationDatasetId]))
      .rows[0];
    if (simulation === undefined) {
      return fail({
        code: DiagnosticCode.SIMULATION_NOT_FOUND,
        message: `Simulation dataset ${request.simulationDatasetId} does not exist.`,
      });
    }
    if (simulation.plan_id !== plan.id) {
      return fail({
        code: DiagnosticCode.SIMULATION_NOT_IN_PLAN,
        message: `Simulation dataset ${simulation.id} does not belong to plan ${plan.id}.`,
      });
    }
  } else {
    simulation = (
      await client.query<SimulationRow>(
        `${simulationQuery} where s.plan_id = $1 and sd.status = 'success' order by sd.id desc limit 1`,
        [plan.id],
      )
    ).rows[0];
    if (simulation === undefined) {
      return fail({
        code: DiagnosticCode.SIMULATION_NOT_FOUND,
        message: `Plan ${plan.id} has no successful simulation to generate from.`,
      });
    }
  }
  if (simulation.status !== 'success') {
    return fail({
      code: DiagnosticCode.SIMULATION_NOT_COMPLETE,
      message: `Simulation dataset ${simulation.id} is ${simulation.status}; only a successful simulation can be used.`,
      details: { simulationDatasetId: simulation.id, status: simulation.status },
    });
  }
  if (simulation.plan_revision !== plan.revision) {
    diagnostics.push({
      code: DiagnosticCode.SIMULATION_PLAN_REVISION_DIFFERS,
      severity: 'info',
      message: `The plan has changed since simulation ${simulation.id} was run (plan revision ${simulation.plan_revision}, now ${plan.revision}).`,
      details: { simulationPlanRevision: simulation.plan_revision, currentPlanRevision: plan.revision },
    });
  }

  // 3. Source activities
  const spans =
    simulation.dataset_id === null
      ? []
      : (
          await client.query<SpanRow>(
            `select span_id as id, parent_id, start_offset::text as start_offset, duration::text as duration,
                    type as activity_type_name, attributes
               from merlin.span
              where dataset_id = $1
              order by span_id`,
            [simulation.dataset_id],
          )
        ).rows;

  const activitySchemas = new Map<string, GraphQLActivitySchema>(
    (
      await client.query<GraphQLActivitySchema>(
        `select name, parameters, computed_attributes_value_schema from merlin.activity_type where model_id = $1`,
        [modelId],
      )
    ).rows.map(row => [row.name, row]),
  );

  const toSimulatedActivity = (span: SpanRow): SimulatedActivity =>
    mapGraphQLActivityInstance(
      {
        id: span.id,
        simulation_dataset_id: simulation!.id,
        plan_id: plan.id,
        model_id: modelId,
        attributes: span.attributes,
        duration: span.duration ?? '',
        start_offset: span.start_offset,
        simulation_start_time: simulation!.simulation_start_time,
        activity_type_name: span.activity_type_name,
      },
      activitySchemas.get(span.activity_type_name) ?? {
        name: span.activity_type_name,
        parameters: {},
        requiredParameters: [],
        computed_attributes_value_schema: { type: 'struct', items: {} } as any,
      },
    );

  const selection = request.selection;
  const sourceSelection: SourceSnapshot['selection'] = { type: selection.type };
  let selectionTimeRange: SourceSnapshot['time']['selectionTimeRange'] = null;
  let selectedSpans: SpanRow[];

  switch (selection.type) {
    case 'activity-directives': {
      // Top-level only: the span each directive produced, not its decomposed children.
      const byDirective = new Map<number, SpanRow>();
      for (const span of spans) {
        const directiveId = span.attributes?.directiveId;
        if (directiveId !== undefined && directiveId !== null && !byDirective.has(Number(directiveId))) {
          byDirective.set(Number(directiveId), span);
        }
      }
      const requested = [...new Set(selection.ids)];
      const notSimulated = requested.filter(id => !byDirective.has(id));
      if (notSimulated.length > 0) {
        return fail({
          code: DiagnosticCode.DIRECTIVE_NOT_SIMULATED,
          message: `Activity directive(s) ${notSimulated.join(', ')} have no simulated activity in simulation ${simulation.id}.`,
          directiveIds: notSimulated,
        });
      }
      sourceSelection.requestedDirectiveIds = requested;
      selectedSpans = requested.map(id => byDirective.get(id)!);
      break;
    }
    case 'simulated-activities': {
      const byId = new Map(spans.map(span => [span.id, span]));
      const requested = [...new Set(selection.ids)];
      const notFound = requested.filter(id => !byId.has(id));
      if (notFound.length > 0) {
        return fail({
          code: DiagnosticCode.SIMULATED_ACTIVITY_NOT_FOUND,
          message: `Simulated activit(ies) ${notFound.join(', ')} do not exist in simulation ${simulation.id}.`,
          sourceActivityIds: notFound,
        });
      }
      selectedSpans = requested.map(id => byId.get(id)!);
      break;
    }
    case 'filter': {
      const filter = (
        await client.query<{ id: number; name: string | null; model_id: number; filter: SequenceFilter }>(
          `select id, name, model_id, filter from sequencing.sequence_filter where id = $1`,
          [selection.filterId],
        )
      ).rows[0];
      if (filter === undefined) {
        return fail({
          code: DiagnosticCode.FILTER_NOT_FOUND,
          message: `Sequence filter ${selection.filterId} does not exist.`,
        });
      }
      let start: Temporal.Instant;
      let end: Temporal.Instant;
      try {
        start = selection.timeRangeStart
          ? Temporal.Instant.from(convertDoyToYmd(selection.timeRangeStart))
          : Temporal.Instant.from(simulation.simulation_start_time);
        end = selection.timeRangeEnd
          ? Temporal.Instant.from(convertDoyToYmd(selection.timeRangeEnd))
          : Temporal.Instant.from(simulation.simulation_end_time);
      } catch (e) {
        return fail({
          code: DiagnosticCode.INVALID_TIME_RANGE,
          message: `Invalid filter time range: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      if (Temporal.Instant.compare(start, end) > 0) {
        return fail({
          code: DiagnosticCode.INVALID_TIME_RANGE,
          message: `Filter time range start (${start}) is after its end (${end}).`,
        });
      }
      selectionTimeRange = { start: start.toString(), end: end.toString() };
      sourceSelection.filter = { id: filter.id, name: filter.name, modelId: filter.model_id, filter: filter.filter };
      const spanById = new Map(spans.map(span => [span.id, span]));
      const matched = applyActivityLayerFilter(filter.filter, spans.map(toSimulatedActivity), start, end);
      selectedSpans = matched.map(activity => spanById.get(activity.id)!);
      break;
    }
    default:
      return fail({
        code: DiagnosticCode.INTERNAL_ERROR,
        message: `Unknown selection type "${(selection as { type: string }).type}".`,
      });
  }

  const activities = selectedSpans.map(toSimulatedActivity);

  const sourceSnapshot: SourceSnapshot = {
    sourceType: 'plandev-simulation',
    provenance: 'complete',
    identifiers: {
      planId: plan.id,
      simulationDatasetId: simulation.id,
      simulationId: simulation.simulation_id,
      datasetId: simulation.dataset_id,
    },
    revisions: {
      planRevision: simulation.plan_revision,
      currentPlanRevision: plan.revision,
      modelRevision: simulation.model_revision,
      simulationRevision: simulation.simulation_revision,
      simulationTemplateRevision: simulation.simulation_template_revision,
      datasetRevision: simulation.dataset_revision,
    },
    unavailable: [],
    time: {
      planStartTime: plan.start_time,
      simulationStartTime: simulation.simulation_start_time,
      simulationEndTime: simulation.simulation_end_time,
      selectionTimeRange,
    },
    simulation: {
      status: simulation.status,
      requestedAt: simulation.requested_at,
      requestedBy: simulation.requested_by,
    },
    selection: sourceSelection,
    activities: activities.map(activity => ({
      id: activity.id,
      directiveId: activity.attributes.directiveId ?? null,
      parentId: selectedSpans.find(span => span.id === activity.id)?.parent_id ?? null,
      activityType: activity.activityTypeName,
      startOffset: activity.startOffset.toString(),
      startTime: activity.startTime.toString(),
      duration: activity.duration?.toString() ?? null,
    })),
    externalInputs: [],
  };

  // 4. Templates: only those for the activity types actually selected, with their full contents
  const activityTypes = [...new Set(activities.map(activity => activity.activityTypeName))].sort();
  const templateRows = (
    await client.query<{
      id: number;
      name: string;
      activity_type: string;
      language: string;
      parcel_id: number | null;
      owner: string | null;
      template_definition: string;
    }>(
      `select id, name, activity_type, language, parcel_id, owner, template_definition
         from sequencing.sequence_template
        where model_id = $1 and activity_type = any($2::text[])
        order by activity_type`,
      [modelId, activityTypes],
    )
  ).rows;
  const templates: TemplateSnapshot[] = templateRows.map(row => ({
    templateId: row.id,
    name: row.name,
    activityType: row.activity_type,
    language: row.language,
    parcelId: row.parcel_id,
    owner: row.owner,
    definitionHash: sha256(row.template_definition),
    definition: row.template_definition,
  }));
  const templatesByActivityType = Object.fromEntries(templates.map(t => [t.activityType, t]));

  // 5. Parcels, dictionaries and sequence adaptations of the templates used
  const parcels = await resolveParcels(client, [
    ...new Set(templates.map(t => t.parcelId).filter((id): id is number => id !== null)),
  ]);

  // 6. Coverage and language
  const missingActivityTypes = activityTypes.filter(type => templatesByActivityType[type] === undefined);
  const languages = [...new Set(templates.map(t => t.language))];
  const language = languages.length === 1 ? (languages[0] as SequencingLanguage) : null;
  const builder = language !== null ? getSeqBuilder(language) : null;

  const expansionSnapshot: ExpansionSnapshot = {
    generator: {
      name: 'sequencing-server',
      version: GENERATOR_VERSION,
      expansion: 'sequence-template',
      builder: builder?.name ?? null,
    },
    model: {
      id: modelId,
      name: plan.model_name,
      mission: plan.model_mission ?? '',
      version: plan.model_version ?? '',
      revision: plan.model_revision ?? 0,
    },
    language,
    parcels,
    templates,
    coverage: {
      activities: activities.length,
      expandable: activities.filter(a => templatesByActivityType[a.activityTypeName] !== undefined).length,
      missing: activities.filter(a => templatesByActivityType[a.activityTypeName] === undefined).length,
      activityTypes,
      missingActivityTypes,
    },
  };
  const partial = { sourceSnapshot, expansionSnapshot };

  const errors: GenerationDiagnostic[] = [];
  if (activities.length === 0) {
    errors.push({
      code: DiagnosticCode.EMPTY_SELECTION,
      severity: 'error',
      message: 'The selection resolved to zero activities.',
    });
  }
  for (const activityType of missingActivityTypes) {
    const missing = activities.filter(a => a.activityTypeName === activityType);
    errors.push({
      code: DiagnosticCode.MISSING_EXPANSION,
      severity: 'error',
      message: `No sequence template exists for activity type "${activityType}" (${missing.length} selected activit${missing.length === 1 ? 'y' : 'ies'}).`,
      activityType,
      sourceActivityIds: missing.map(a => a.id),
      directiveIds: missing.map(a => a.attributes.directiveId).filter((id): id is number => id !== undefined && id !== null),
    });
  }
  if (languages.length > 1) {
    errors.push({
      code: DiagnosticCode.MIXED_TEMPLATE_LANGUAGES,
      severity: 'error',
      message: `The templates for the selected activities use different languages (${languages.join(', ')}).`,
      details: { templates: templates.map(t => ({ templateId: t.templateId, activityType: t.activityType, language: t.language })) },
    });
  } else if (language !== null && builder === null) {
    errors.push({
      code: DiagnosticCode.UNSUPPORTED_LANGUAGE,
      severity: 'error',
      message: `Unsupported sequence language "${language}".`,
    });
  }
  if (errors.length > 0) {
    throw new GenerationResolutionError([...diagnostics, ...errors], partial);
  }

  return {
    planId: plan.id,
    simulationDatasetId: simulation.id,
    seqId: request.sequenceId,
    seqMetadata: { ...(request.metadata ?? {}), simulationDatasetId: simulation.id },
    activities,
    templatesByActivityType,
    sourceSnapshot,
    expansionSnapshot,
    diagnostics,
  };
}

async function resolveParcels(client: PoolClient, parcelIds: number[]): Promise<ParcelSnapshot[]> {
  if (parcelIds.length === 0) {
    return [];
  }
  const dictionary = (prefix: string) => `
    case when ${prefix}.id is null then null else json_build_object(
      'id', ${prefix}.id, 'mission', ${prefix}.mission, 'version', ${prefix}.version, 'updatedAt', ${prefix}.updated_at
    ) end`;
  const rows = (
    await client.query<{
      id: number;
      name: string;
      updated_at: string;
      command_dictionary: DictionarySnapshot | null;
      channel_dictionary: DictionarySnapshot | null;
      parameter_dictionaries: DictionarySnapshot[];
      sequence_adaptation: { id: number; name: string; updatedAt: string; adaptation: string } | null;
    }>(
      `select p.id, p.name, to_json(p.updated_at)#>>'{}' as updated_at,
              ${dictionary('cmd')} as command_dictionary,
              ${dictionary('chan')} as channel_dictionary,
              coalesce((select json_agg(json_build_object(
                          'id', pd.id, 'mission', pd.mission, 'version', pd.version, 'updatedAt', pd.updated_at
                        ) order by pd.id)
                          from sequencing.parcel_to_parameter_dictionary ppd
                          join sequencing.parameter_dictionary pd on pd.id = ppd.parameter_dictionary_id
                         where ppd.parcel_id = p.id), '[]'::json) as parameter_dictionaries,
              case when sa.id is null then null else json_build_object(
                'id', sa.id, 'name', sa.name, 'updatedAt', sa.updated_at, 'adaptation', sa.adaptation
              ) end as sequence_adaptation
         from sequencing.parcel p
         left join sequencing.command_dictionary cmd on cmd.id = p.command_dictionary_id
         left join sequencing.channel_dictionary chan on chan.id = p.channel_dictionary_id
         left join sequencing.sequence_adaptation sa on sa.id = p.sequence_adaptation_id
        where p.id = any($1::int[])
        order by p.id`,
      [parcelIds],
    )
  ).rows;
  return rows.map(row => ({
    parcelId: row.id,
    name: row.name,
    updatedAt: row.updated_at,
    commandDictionary: row.command_dictionary,
    channelDictionary: row.channel_dictionary,
    parameterDictionaries: row.parameter_dictionaries,
    sequenceAdaptation:
      row.sequence_adaptation === null
        ? null
        : {
            id: row.sequence_adaptation.id,
            name: row.sequence_adaptation.name,
            updatedAt: row.sequence_adaptation.updatedAt,
            contentHash: sha256(row.sequence_adaptation.adaptation),
          },
  }));
}
