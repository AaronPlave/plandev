import { gql, GraphQLClient } from 'graphql-request';
import http from 'node:http';
import fetch from 'node-fetch';

export type GenerationSelectionInput =
  | { type: 'activity-directives'; ids: number[] }
  | { type: 'simulated-activities'; ids: number[] }
  | { type: 'filter'; filterId: number; timeRangeStart?: string; timeRangeEnd?: string };

export type GenerateSequenceResult = {
  generationId: number;
  status: string;
  generatedProductIds: number[];
  diagnostics: any[];
};

export async function generateSequence(
  graphqlClient: GraphQLClient,
  input: {
    planId: number;
    simulationDatasetId?: number | null;
    sequenceId: string;
    selection: GenerationSelectionInput;
    metadata?: Record<string, unknown>;
  },
): Promise<GenerateSequenceResult> {
  const res = await graphqlClient.request<{ generateSequence: GenerateSequenceResult }>(
    gql`
      mutation GenerateSequence(
        $planId: Int!
        $simulationDatasetId: Int
        $sequenceId: String!
        $selection: GenerateSequenceSelection!
        $metadata: json
      ) {
        generateSequence(
          planId: $planId
          simulationDatasetId: $simulationDatasetId
          sequenceId: $sequenceId
          selection: $selection
          metadata: $metadata
        ) {
          generationId
          status
          generatedProductIds
          diagnostics
        }
      }
    `,
    { metadata: {}, ...input },
  );
  return res.generateSequence;
}

export async function generateSequencePreflight(
  graphqlClient: GraphQLClient,
  input: { planId: number; simulationDatasetId?: number | null; sequenceId: string; selection: GenerationSelectionInput },
): Promise<{ ok: boolean; diagnostics: any[]; source: any; expansion: any }> {
  const res = await graphqlClient.request<{
    generateSequencePreflight: { ok: boolean; diagnostics: any[]; source: any; expansion: any };
  }>(
    gql`
      query GenerateSequencePreflight(
        $planId: Int!
        $simulationDatasetId: Int
        $sequenceId: String!
        $selection: GenerateSequenceSelection!
      ) {
        generateSequencePreflight(
          planId: $planId
          simulationDatasetId: $simulationDatasetId
          sequenceId: $sequenceId
          selection: $selection
        ) {
          ok
          diagnostics
          source
          expansion
        }
      }
    `,
    input,
  );
  return res.generateSequencePreflight;
}

export type GenerationRecord = {
  id: number;
  plan_id: number;
  simulation_dataset_id: number | null;
  requested_seq_id: string;
  status: string;
  requested_by: string | null;
  completed_at: string | null;
  request_snapshot: any;
  source_snapshot: any;
  expansion_snapshot: any;
  diagnostics: any[];
  error: any;
  products: {
    id: number;
    generation_id: number;
    product_key: string;
    seq_id: string;
    language: string;
    rendered_output: string;
    output_hash: string;
    source_blocks: any[];
  }[];
};

export async function getGeneration(graphqlClient: GraphQLClient, id: number): Promise<GenerationRecord> {
  const res = await graphqlClient.request<{ sequence_generation_by_pk: GenerationRecord }>(
    gql`
      query GetGeneration($id: Int!) {
        sequence_generation_by_pk(id: $id) {
          id
          plan_id
          simulation_dataset_id
          requested_seq_id
          status
          requested_by
          completed_at
          request_snapshot
          source_snapshot
          expansion_snapshot
          diagnostics
          error
          products {
            id
            generation_id
            product_key
            seq_id
            language
            rendered_output
            output_hash
            source_blocks
          }
        }
      }
    `,
    { id },
  );
  return res.sequence_generation_by_pk;
}

export async function getGenerationsForPlan(graphqlClient: GraphQLClient, planId: number): Promise<{ id: number; status: string }[]> {
  const res = await graphqlClient.request<{ sequence_generation: { id: number; status: string }[] }>(
    gql`
      query GetGenerations($planId: Int!) {
        sequence_generation(where: { plan_id: { _eq: $planId } }, order_by: { id: asc }) {
          id
          status
        }
      }
    `,
    { planId },
  );
  return res.sequence_generation;
}

export async function updateSequenceTemplateDefinition(
  graphqlClient: GraphQLClient,
  templateId: number,
  templateDefinition: string,
): Promise<void> {
  await graphqlClient.request(
    gql`
      mutation UpdateTemplate($id: Int!, $templateDefinition: String!) {
        update_sequence_template_by_pk(pk_columns: { id: $id }, _set: { template_definition: $templateDefinition }) {
          id
        }
      }
    `,
    { id: templateId, templateDefinition },
  );
}

export async function removeSequenceTemplates(graphqlClient: GraphQLClient, modelId: number): Promise<void> {
  await graphqlClient.request(
    gql`
      mutation RemoveTemplates($modelId: Int!) {
        delete_sequence_template(where: { model_id: { _eq: $modelId } }) {
          affected_rows
        }
      }
    `,
    { modelId },
  );
}

/** Run raw SQL through Hasura's admin API (used to verify database-level guarantees). */
export async function runSql(sql: string): Promise<{ result_type: string; result?: string[][] }> {
  const url = (process.env['MERLIN_GRAPHQL_URL'] as string).replace('/v1/graphql', '/v2/query');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hasura-admin-secret': process.env['HASURA_GRAPHQL_ADMIN_SECRET'] as string,
    },
    body: JSON.stringify({ type: 'run_sql', args: { source: 'PlanDev', sql } }),
    // A fresh connection per call: a reused keep-alive socket can be closed by Hasura between calls.
    agent: new http.Agent({ keepAlive: false }),
  });
  const body = (await response.json()) as any;
  if (!response.ok) {
    throw new Error(body?.internal?.error?.message ?? body?.error ?? JSON.stringify(body));
  }
  return body;
}
