import { z } from 'zod'
import { RunInputSchema } from '../index.js'
import {
  AGENT_INTERVAL_MIN_SECONDS, AGENT_INTERVAL_MAX_SECONDS,
} from './workflowShape.js'

/** A check observes its Run without predecessor bindings or repeat routing. */
export const IntervalCheckAcceptedInputSchema = z.object({
  executionSemanticsVersion: z.literal(3),
  runInput: RunInputSchema,
  occurrence: z.null(),
  entry: z.null(),
  predecessors: z.array(z.never()).length(0),
  tick: z.object({
    index: z.number().int().min(1),
    everySeconds: z.number().int().min(AGENT_INTERVAL_MIN_SECONDS).max(AGENT_INTERVAL_MAX_SECONDS),
  }).strict(),
}).strict()
