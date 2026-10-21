import { z } from 'zod'
import { CiActivitySchema } from './ciHost.js'
import { GraphIdSchema, IdSchema, TimestampSchema } from './schemaPrimitives.js'

export const RUN_STATUS_LIMITS = { ci: 20, errors: 10, messageLength: 500 } as const
export const DEFAULT_STUCK_EXECUTION_IDLE_MS = 60 * 60_000

/** Read-only, bounded view of an Agent's own Run for interval checks (Foreman Code MCP run_status_get). */
export const AgentRunStatusSchema = z.object({
  run: z.object({
    id: IdSchema,
    executionState: z.string().min(1),
    outcome: z.string().min(1).nullable(),
    stopRequested: z.boolean(),
  }).strict(),
  /** The calling Agent's node and execution in this Run. */
  self: z.object({ nodeId: GraphIdSchema, executionId: IdSchema }).strict(),
  nodes: z.array(z.object({
    nodeId: GraphIdSchema,
    name: z.string(),
    /** The latest execution's lifecycle; not_started before any execution. */
    state: z.enum(['not_started', 'queued', 'starting', 'running', 'waiting', 'completed']),
    outcome: z.enum(['succeeded', 'failed', 'canceled']).nullable(),
    executions: z.number().int().nonnegative(),
    /** Executions that were interval checks. */
    checks: z.number().int().nonnegative(),
    lastStartedAt: TimestampSchema.nullable(),
    lastFinishedAt: TimestampSchema.nullable(),
  }).strict()).max(1000),
  /** The Run's most recent CI tickets, newest first. */
  ci: z.array(z.object({ nodeId: GraphIdSchema, ticket: CiActivitySchema }).strict()).max(RUN_STATUS_LIMITS.ci),
  /** Recent failed executions, CI tickets and stuck-execution warnings, newest first. */
  errors: z.array(z.object({
    nodeId: GraphIdSchema.nullable(),
    executionId: IdSchema.nullable(),
    ciTicketId: IdSchema.nullable(),
    code: z.string().min(1).max(100),
    message: z.string().max(RUN_STATUS_LIMITS.messageLength),
    at: TimestampSchema.nullable(),
  }).strict()).max(RUN_STATUS_LIMITS.errors),
}).strict()
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>
