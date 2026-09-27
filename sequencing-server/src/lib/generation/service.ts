import type { Pool } from 'pg';
import getLogger from '../../utils/logger.js';
import { expandResolvedActivities } from '../expansion/expandResolvedActivities.js';
import { GenerationResolutionError, resolveGeneration, sha256 } from './resolve.js';
import {
  DiagnosticCode,
  GenerationStatus,
  type GenerateSequenceRequest,
  type GenerateSequenceResponse,
  type GenerationDiagnostic,
  type ResolvedGeneration,
  type SourceBlock,
} from './types.js';

const logger = getLogger('generation');

export const DEFAULT_PRODUCT_KEY = 'default';

/** Validate the shape of a request. Invalid requests are rejected without creating a Generation. */
export function parseGenerateSequenceRequest(input: any): GenerateSequenceRequest {
  const errors: string[] = [];
  const isId = (value: unknown) => Number.isInteger(value);

  if (!isId(input?.planId)) errors.push('planId must be an integer');
  if (input?.simulationDatasetId !== undefined && input?.simulationDatasetId !== null && !isId(input.simulationDatasetId))
    errors.push('simulationDatasetId must be an integer');
  if (typeof input?.sequenceId !== 'string' || input.sequenceId.trim() === '') errors.push('sequenceId is required');
  if (input?.metadata !== undefined && input?.metadata !== null && (typeof input.metadata !== 'object' || Array.isArray(input.metadata)))
    errors.push('metadata must be an object');

  const selection = input?.selection;
  switch (selection?.type) {
    case 'activity-directives':
    case 'simulated-activities':
      if (!Array.isArray(selection.ids) || !selection.ids.every(isId)) errors.push('selection.ids must be integers');
      break;
    case 'filter':
      if (!isId(selection.filterId)) errors.push('selection.filterId must be an integer');
      break;
    default:
      errors.push('selection.type must be one of "activity-directives", "simulated-activities" or "filter"');
  }

  if (errors.length > 0) {
    throw Object.assign(new Error(`Invalid generateSequence request: ${errors.join('; ')}`), { status: 400 });
  }

  const normalizedSelection =
    selection.type === 'filter'
      ? {
          type: 'filter' as const,
          filterId: selection.filterId as number,
          timeRangeStart: selection.timeRangeStart ?? null,
          timeRangeEnd: selection.timeRangeEnd ?? null,
        }
      : { type: selection.type, ids: selection.ids as number[] };

  return {
    planId: input.planId,
    simulationDatasetId: input.simulationDatasetId ?? null,
    sequenceId: input.sequenceId.trim(),
    selection: normalizedSelection,
    metadata: input.metadata ?? {},
  };
}

/**
 * Resolve what a Generation would use, and whether it can succeed, without creating one.
 */
export async function preflightGeneration(
  db: Pool,
  request: GenerateSequenceRequest,
): Promise<{ ok: boolean; diagnostics: GenerationDiagnostic[]; source: unknown; expansion: unknown }> {
  const client = await db.connect();
  try {
    const resolved = await resolveGeneration(client, request);
    return {
      ok: true,
      diagnostics: resolved.diagnostics,
      source: summarizeSource(resolved.sourceSnapshot),
      expansion: summarizeExpansion(resolved.expansionSnapshot),
    };
  } catch (e) {
    if (e instanceof GenerationResolutionError) {
      return {
        ok: false,
        diagnostics: e.diagnostics,
        source: e.partial.sourceSnapshot ? summarizeSource(e.partial.sourceSnapshot) : null,
        expansion: e.partial.expansionSnapshot ? summarizeExpansion(e.partial.expansionSnapshot) : null,
      };
    }
    throw e;
  } finally {
    client.release();
  }
}

function summarizeSource(source: ResolvedGeneration['sourceSnapshot']) {
  const { activities, ...rest } = source;
  return { ...rest, activityCount: activities.length };
}

function summarizeExpansion(expansion: ResolvedGeneration['expansionSnapshot']) {
  return {
    ...expansion,
    templates: expansion.templates.map(({ definition: _definition, ...template }) => template),
  };
}

/**
 * Generate a sequence as one new, immutable Generation.
 *
 *   1. create the Generation (pending) with the request snapshot
 *   2. mark it running
 *   3. resolve source, membership, coverage and environment once, from one consistent database snapshot
 *   4. persist the source/expansion snapshots
 *   5. expand the resolved activities with the resolved template contents and build the sequence
 *   6. persist the Generated Product and mark the Generation successful, atomically
 *
 * Any failure after step 1 leaves the Generation persisted as failed, with structured diagnostics.
 */
export async function generateSequence(
  db: Pool,
  request: GenerateSequenceRequest,
  requestedBy: string | null,
): Promise<GenerateSequenceResponse> {
  const requestSnapshot = {
    planId: request.planId,
    simulationDatasetId: request.simulationDatasetId ?? null,
    sequenceId: request.sequenceId,
    selection: request.selection,
    metadata: request.metadata ?? {},
  };

  // Permissions are checked against the plan of simulationDatasetId when one is given, so a mismatched
  // plan/simulation pair is rejected outright rather than recorded as a Generation of `planId`.
  if (request.simulationDatasetId !== undefined && request.simulationDatasetId !== null) {
    const { rows } = await db.query(
      `select s.plan_id from merlin.simulation_dataset sd join merlin.simulation s on s.id = sd.simulation_id
        where sd.id = $1`,
      [request.simulationDatasetId],
    );
    if (rows[0] !== undefined && rows[0].plan_id !== request.planId) {
      throw Object.assign(
        new Error(`Simulation dataset ${request.simulationDatasetId} does not belong to plan ${request.planId}.`),
        { status: 400 },
      );
    }
  }

  const generationId: number = (
    await db.query(
      // simulation_dataset_id is set once the source is resolved; the requested one is in the request snapshot.
      `insert into sequencing.generation (plan_id, requested_seq_id, requested_by, request_snapshot)
       values ($1, $2, $3, $4)
       returning id`,
      [request.planId, request.sequenceId, requestedBy, requestSnapshot],
    )
  ).rows[0].id;
  logger.info(`Generation ${generationId}: created for plan ${request.planId}, sequence "${request.sequenceId}"`);

  const markFailed = async (diagnostics: GenerationDiagnostic[]): Promise<GenerateSequenceResponse> => {
    const firstError = diagnostics.find(d => d.severity === 'error') ?? diagnostics[0];
    await db.query(
      `update sequencing.generation
          set status = 'failed', completed_at = now(), diagnostics = $2, error = $3
        where id = $1`,
      [
        generationId,
        JSON.stringify(diagnostics),
        firstError ? { code: firstError.code, message: firstError.message } : null,
      ],
    );
    logger.info(`Generation ${generationId}: failed (${firstError?.code})`);
    return { generationId, status: GenerationStatus.FAILED, generatedProductIds: [], diagnostics };
  };

  try {
    await db.query(`update sequencing.generation set status = 'incomplete' where id = $1`, [generationId]);

    // Resolve once. Everything from here on uses only `resolved`.
    let resolved: ResolvedGeneration;
    const client = await db.connect();
    try {
      resolved = await resolveGeneration(client, request);
    } catch (e) {
      if (e instanceof GenerationResolutionError) {
        await persistSnapshots(db, generationId, e.partial.sourceSnapshot, e.partial.expansionSnapshot);
        return await markFailed(e.diagnostics);
      }
      throw e;
    } finally {
      client.release();
    }
    await persistSnapshots(db, generationId, resolved.sourceSnapshot, resolved.expansionSnapshot, resolved.simulationDatasetId);

    const language = resolved.expansionSnapshot.language!;
    const expansion = expandResolvedActivities({
      activities: resolved.activities,
      templatesByActivityType: resolved.templatesByActivityType,
      language,
      seqId: resolved.seqId,
      seqMetadata: resolved.seqMetadata,
      simulationDatasetId: resolved.simulationDatasetId,
      missingTemplate: 'error',
    });

    const diagnostics: GenerationDiagnostic[] = [...resolved.diagnostics];
    for (const missing of expansion.missing) {
      // Unreachable given coverage resolution, but never let an activity silently disappear.
      diagnostics.push({
        code: DiagnosticCode.MISSING_EXPANSION,
        severity: 'error',
        message: `No sequence template exists for activity type "${missing.activityType}".`,
        activityType: missing.activityType,
        sourceActivityIds: missing.activities.map(a => a.id),
      });
    }
    for (const failure of expansion.failures) {
      const template = resolved.templatesByActivityType[failure.activity.activityTypeName];
      diagnostics.push({
        code: DiagnosticCode.EXPANSION_FAILED,
        severity: 'error',
        message: `Template for "${failure.activity.activityTypeName}" failed to expand activity ${failure.activity.id}: ${failure.message}`,
        activityType: failure.activity.activityTypeName,
        sourceActivityIds: [failure.activity.id],
        ...(failure.activity.attributes.directiveId != null ? { directiveIds: [failure.activity.attributes.directiveId] } : {}),
        ...(template ? { templateId: template.templateId } : {}),
      });
    }
    if (expansion.buildError !== null) {
      diagnostics.push({
        code: DiagnosticCode.SEQUENCE_BUILD_FAILED,
        severity: 'error',
        message: `Building the ${language} sequence failed: ${expansion.buildError}`,
      });
    }

    // Every selected activity must be accounted for as expanded.
    const expandedIds = new Set(expansion.blocks.map(block => block.activity.id));
    const unaccounted = resolved.activities.filter(a => !expandedIds.has(a.id));
    if (expansion.sequence === null || unaccounted.length > 0 || diagnostics.some(d => d.severity === 'error')) {
      if (!diagnostics.some(d => d.severity === 'error')) {
        diagnostics.push({
          code: DiagnosticCode.INTERNAL_ERROR,
          severity: 'error',
          message: `Activities ${unaccounted.map(a => a.id).join(', ')} were not expanded.`,
          sourceActivityIds: unaccounted.map(a => a.id),
        });
      }
      return await markFailed(diagnostics);
    }

    const sourceBlocks: SourceBlock[] = expansion.blocks.map((block, index) => ({
      index,
      sourceActivityId: block.activity.id,
      directiveId: block.activity.attributes.directiveId ?? null,
      activityType: block.activity.activityTypeName,
      startOffset: block.activity.startOffset.toString(),
      startTime: block.activity.startTime.toString(),
      templateId: block.template.templateId!,
      templateHash: block.template.definitionHash!,
      expansion: block.expansion,
    }));

    // Persist the product and mark success atomically.
    const txn = await db.connect();
    let productId: number;
    try {
      await txn.query('begin');
      productId = (
        await txn.query(
          `insert into sequencing.generated_product
             (generation_id, product_key, seq_id, metadata, language, rendered_output, output_hash, source_blocks)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           returning id`,
          [
            generationId,
            DEFAULT_PRODUCT_KEY,
            resolved.seqId,
            resolved.seqMetadata,
            language,
            expansion.sequence,
            sha256(expansion.sequence),
            JSON.stringify(sourceBlocks),
          ],
        )
      ).rows[0].id;
      await txn.query(
        `update sequencing.generation set status = 'success', completed_at = now(), diagnostics = $2 where id = $1`,
        [generationId, JSON.stringify(diagnostics)],
      );
      await txn.query('commit');
    } catch (e) {
      await txn.query('rollback');
      throw e;
    } finally {
      txn.release();
    }

    logger.info(`Generation ${generationId}: success, product ${productId}`);
    return { generationId, status: GenerationStatus.SUCCESS, generatedProductIds: [productId], diagnostics };
  } catch (e) {
    logger.error(`Generation ${generationId}: unexpected error`, e);
    return await markFailed([
      {
        code: DiagnosticCode.INTERNAL_ERROR,
        severity: 'error',
        message: e instanceof Error ? e.message : String(e),
      },
    ]);
  }
}

async function persistSnapshots(
  db: Pool,
  generationId: number,
  sourceSnapshot: unknown,
  expansionSnapshot: unknown,
  simulationDatasetId?: number,
) {
  await db.query(
    `update sequencing.generation
        set source_snapshot = $2,
            expansion_snapshot = $3,
            simulation_dataset_id = coalesce($4, simulation_dataset_id)
      where id = $1`,
    [
      generationId,
      sourceSnapshot === undefined ? null : JSON.stringify(sourceSnapshot),
      expansionSnapshot === undefined ? null : JSON.stringify(expansionSnapshot),
      simulationDatasetId ?? (sourceSnapshot as any)?.identifiers?.simulationDatasetId ?? null,
    ],
  );
}
