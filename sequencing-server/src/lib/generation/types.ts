import type { SimulatedActivity } from '../batchLoaders/simulatedActivityBatchLoader.js';
import type { SequencingLanguage } from '../mustache/enums/language.js';

/*
 * Types for first-class sequence Generations.
 *
 * A Generation is one immutable attempt to build sequence products from one resolved set of inputs. Everything a
 * Generation used is resolved once, up front, into the snapshots below; expansion then only reads those snapshots.
 */

export enum GenerationStatus {
  PENDING = 'pending',
  RUNNING = 'incomplete',
  SUCCESS = 'success',
  FAILED = 'failed',
}

export type GenerationSelection =
  | { type: 'activity-directives'; ids: number[] }
  | { type: 'simulated-activities'; ids: number[] }
  | { type: 'filter'; filterId: number; timeRangeStart?: string | null; timeRangeEnd?: string | null };

export type GenerateSequenceRequest = {
  planId: number;
  /** When omitted, the latest successful simulation dataset of the plan is used. */
  simulationDatasetId?: number | null;
  sequenceId: string;
  selection: GenerationSelection;
  metadata?: Record<string, unknown> | null;
};

export enum DiagnosticCode {
  PLAN_NOT_FOUND = 'PLAN_NOT_FOUND',
  PLAN_HAS_NO_MODEL = 'PLAN_HAS_NO_MODEL',
  SIMULATION_NOT_FOUND = 'SIMULATION_NOT_FOUND',
  SIMULATION_NOT_IN_PLAN = 'SIMULATION_NOT_IN_PLAN',
  SIMULATION_NOT_COMPLETE = 'SIMULATION_NOT_COMPLETE',
  SIMULATION_PLAN_REVISION_DIFFERS = 'SIMULATION_PLAN_REVISION_DIFFERS',
  FILTER_NOT_FOUND = 'FILTER_NOT_FOUND',
  INVALID_TIME_RANGE = 'INVALID_TIME_RANGE',
  DIRECTIVE_NOT_SIMULATED = 'DIRECTIVE_NOT_SIMULATED',
  SIMULATED_ACTIVITY_NOT_FOUND = 'SIMULATED_ACTIVITY_NOT_FOUND',
  EMPTY_SELECTION = 'EMPTY_SELECTION',
  MISSING_EXPANSION = 'MISSING_EXPANSION',
  MIXED_TEMPLATE_LANGUAGES = 'MIXED_TEMPLATE_LANGUAGES',
  UNSUPPORTED_LANGUAGE = 'UNSUPPORTED_LANGUAGE',
  EXPANSION_FAILED = 'EXPANSION_FAILED',
  SEQUENCE_BUILD_FAILED = 'SEQUENCE_BUILD_FAILED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/**
 * A structured diagnostic. Where a diagnostic concerns specific source activities, their identities are included so
 * the UI can navigate back to them.
 */
export type GenerationDiagnostic = {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  activityType?: string;
  /** Simulated activity (span) ids within the source simulation dataset. */
  sourceActivityIds?: number[];
  /** Activity directive ids, where known. */
  directiveIds?: number[];
  templateId?: number;
  details?: Record<string, unknown>;
};

export type SourceActivitySnapshot = {
  /** Span id within the source simulation dataset. */
  id: number;
  directiveId: number | null;
  parentId: number | null;
  activityType: string;
  startOffset: string;
  startTime: string;
  duration: string | null;
};

/**
 * What the Generation was generated from.
 *
 * `sourceType` + `provenance` allow sources other than a native PlanDev simulation (e.g. an imported run) to be
 * represented later with whatever identifiers/revisions they can provide, recording what is unknown in `unavailable`.
 */
export type SourceSnapshot = {
  sourceType: 'plandev-simulation';
  provenance: 'complete' | 'partial';
  identifiers: {
    planId: number;
    simulationDatasetId: number;
    simulationId: number;
    datasetId: number | null;
  };
  revisions: {
    /** Plan revision the simulation was run against. */
    planRevision: number;
    /** Plan revision at the time the generation was resolved. */
    currentPlanRevision: number;
    modelRevision: number;
    simulationRevision: number;
    simulationTemplateRevision: number | null;
    datasetRevision: number | null;
  };
  unavailable: string[];
  time: {
    planStartTime: string;
    simulationStartTime: string;
    simulationEndTime: string;
    /** The time range used to evaluate a filter selection, if any. */
    selectionTimeRange: { start: string; end: string } | null;
  };
  simulation: {
    status: string;
    requestedAt: string;
    requestedBy: string | null;
  };
  selection: {
    type: GenerationSelection['type'];
    /** For directive selections, the directive ids that were requested. */
    requestedDirectiveIds?: number[];
    /** For filter selections, a snapshot of the filter as it was evaluated. */
    filter?: { id: number; name: string | null; modelId: number; filter: unknown };
  };
  activities: SourceActivitySnapshot[];
  /** Inputs such as external datasets/events that directly feed generation. Templates cannot reference any today. */
  externalInputs: unknown[];
};

export type TemplateSnapshot = {
  templateId: number;
  name: string;
  activityType: string;
  language: string;
  parcelId: number | null;
  owner: string | null;
  definitionHash: string;
  definition: string;
};

export type DictionarySnapshot = {
  id: number;
  mission: string;
  version: string;
  updatedAt: string;
};

export type ParcelSnapshot = {
  parcelId: number;
  name: string;
  updatedAt: string;
  commandDictionary: DictionarySnapshot | null;
  channelDictionary: DictionarySnapshot | null;
  parameterDictionaries: DictionarySnapshot[];
  sequenceAdaptation: { id: number; name: string; updatedAt: string; contentHash: string } | null;
};

/** The expansion environment the Generation used. */
export type ExpansionSnapshot = {
  generator: {
    name: 'sequencing-server';
    version: string;
    expansion: 'sequence-template';
    builder: string | null;
  };
  model: {
    id: number;
    name: string;
    mission: string;
    version: string;
    /** Model revision at the time the generation was resolved. */
    revision: number;
  };
  language: SequencingLanguage | null;
  parcels: ParcelSnapshot[];
  /** Every template used by this generation, with its full content. */
  templates: TemplateSnapshot[];
  coverage: {
    activities: number;
    expandable: number;
    missing: number;
    activityTypes: string[];
    missingActivityTypes: string[];
  };
};

/** One source activity's contribution to a generated product, in output order. */
export type SourceBlock = {
  index: number;
  sourceActivityId: number;
  directiveId: number | null;
  activityType: string;
  startOffset: string;
  startTime: string;
  templateId: number;
  templateHash: string;
  /** The template's expansion of this activity, before sequence building. */
  expansion: string;
};

export type ResolvedGeneration = {
  planId: number;
  simulationDatasetId: number;
  seqId: string;
  seqMetadata: Record<string, unknown>;
  activities: SimulatedActivity[];
  templatesByActivityType: Record<string, TemplateSnapshot>;
  sourceSnapshot: SourceSnapshot;
  expansionSnapshot: ExpansionSnapshot;
  diagnostics: GenerationDiagnostic[];
};

export type GenerateSequenceResponse = {
  generationId: number;
  status: GenerationStatus;
  generatedProductIds: number[];
  diagnostics: GenerationDiagnostic[];
};
