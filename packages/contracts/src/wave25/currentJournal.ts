import { optionalCommandId } from '../management/commands.js'
import { z } from 'zod'
import { RunOutcomeSchema } from '../index.js'
import { GraphDigestSchema, GraphIdSchema } from './graphPrimitives.js'
import { CurrentRunScopeSchema } from './currentWorkflowFoundation.js'

/** Extracted journal identities/state, independent of any retired editor or
 * execution contract. These are not new native Stop or settlement receipts. */
const scope = { workspaceId: GraphIdSchema, workflowId: GraphIdSchema, draftId: GraphIdSchema }
export const CurrentJournalReadInputSchema = z.object({
  ...scope, action: z.literal('read_edits'), intentId: GraphIdSchema.optional(),
}).strict()
const command = z.object({ ...scope, intentId: GraphIdSchema, commandId: optionalCommandId(GraphIdSchema) }).strict()
export const CurrentJournalAdvanceInputSchema = command.extend({ action: z.literal('stop_and_save') }).strict()
export const CurrentJournalDiscardInputSchema = command.extend({ action: z.literal('discard_edits') }).strict()
export const CurrentJournalRunPinSchema = CurrentRunScopeSchema.extend({
  agentConfigurationVersionIds: z.record(GraphIdSchema, GraphIdSchema),
}).strict()
export const CurrentJournalRunStateSchema = z.object({
  pin: CurrentJournalRunPinSchema, terminal: z.boolean(), settled: z.boolean(), outcome: RunOutcomeSchema,
  cleanupPending: z.boolean(), nativePending: z.boolean(), interactionPending: z.boolean(), reviewPending: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.settled !== (value.terminal && !value.cleanupPending && !value.nativePending
    && !value.interactionPending && !value.reviewPending)) {
    context.addIssue({ code: 'custom', message: 'Settlement requires terminal and every obligation to be closed.' })
  }
})
export const CurrentJournalStopSchema = z.object({
  input: z.object({ workspaceId: GraphIdSchema, runId: GraphIdSchema, commandId: GraphIdSchema }).strict(),
  receipt: z.object({ runId: GraphIdSchema, status: z.enum(['accepted', 'already_terminal', 'not_owner']),
    processStopped: z.literal(false) }).strict().optional(),
}).strict()
const CurrentJournalAgentPinSchema = z.object({
  agentId: GraphIdSchema, metadataRevision: z.number().int().nonnegative().nullable(),
  configurationVersionId: GraphIdSchema.nullable(),
}).strict()
export const CurrentJournalIdentitySchema = z.object({
  id: GraphIdSchema, ownerPrincipalId: GraphIdSchema,
  workspaceId: GraphIdSchema, workflowId: GraphIdSchema, draftId: GraphIdSchema,
  stageCommandId: GraphIdSchema, stageInputHash: GraphDigestSchema,
  advanceCommandId: GraphIdSchema, advanceInputHash: GraphDigestSchema,
  discardCommandId: GraphIdSchema, discardInputHash: GraphDigestSchema,
  expectedRevision: z.number().int().nonnegative(), savedWorkflowRevision: z.number().int().nonnegative(),
  expectedWorkflowVersionId: GraphIdSchema.nullable(),
  agentPins: z.array(CurrentJournalAgentPinSchema), affected: z.array(CurrentJournalRunPinSchema),
  stops: z.array(CurrentJournalStopSchema), saveInputHash: GraphDigestSchema,
  state: z.enum(['staged', 'stopping', 'waiting', 'saving', 'blocked', 'uncertain', 'saved', 'discarded']),
  saveAttempted: z.boolean(),
  error: z.object({ code: z.string(), message: z.string(), uncertain: z.boolean() }).strict().optional(),
  createdAt: z.string(), updatedAt: z.string(),
}).strict()
export type CurrentJournal = z.infer<typeof CurrentJournalIdentitySchema>
export type CurrentJournalReadInput = z.infer<typeof CurrentJournalReadInputSchema>
export type CurrentJournalAdvanceInput = z.infer<typeof CurrentJournalAdvanceInputSchema>
export type CurrentJournalDiscardInput = z.infer<typeof CurrentJournalDiscardInputSchema>
export type CurrentJournalRunState = z.infer<typeof CurrentJournalRunStateSchema>
