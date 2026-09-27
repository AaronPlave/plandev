import express from 'express';
import { db } from '../app.js';
import { getUsername } from '../utils/hasura.js';
import {
  generateSequence,
  parseGenerateSequenceRequest,
  preflightGeneration,
} from '../lib/generation/service.js';

export const sequenceGenerationRouter = express.Router();

sequenceGenerationRouter.post('/generate', async (req, res, next) => {
  /**
   * ARGUMENTS
   * {
   *    planId: Int!,
   *    simulationDatasetId: Int,       // defaults to the plan's latest successful simulation
   *    sequenceId: String!,
   *    selection: {
   *      type: "activity-directives" | "simulated-activities" | "filter",
   *      ids: [Int!],                  // directive or simulated activity ids
   *      filterId: Int,                // for "filter"
   *      timeRangeStart: String,       // for "filter"; defaults to the simulation bounds
   *      timeRangeEnd: String
   *    },
   *    metadata: json
   * }
   *
   * Creates a new Generation. A failed generation is still a successful response: the response and the persisted
   * Generation carry status "failed" and structured diagnostics.
   */
  const request = parseGenerateSequenceRequest(req.body.input);
  const username = getUsername(req.body.session_variables, req.headers.authorization);
  const result = await generateSequence(db, request, username);
  res.status(200).json(result);
  return next();
});

sequenceGenerationRouter.post('/preflight', async (req, res, next) => {
  /**
   * Same arguments as /generate. Resolves the source, membership and expansion coverage the Generation would use
   * without creating a Generation.
   */
  const request = parseGenerateSequenceRequest(req.body.input);
  const result = await preflightGeneration(db, request);
  res.status(200).json(result);
  return next();
});
