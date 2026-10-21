import { optionalCommandId } from './management/commands.js'
import { z } from 'zod'
import { ApprovalResponseOptionSchema, PendingNativeInteractionSchema } from './index.js'

const id = z.string().min(1).max(512)
const timestamp = z.iso.datetime()
const revision = z.string().regex(/^[1-9][0-9]*$/)
export const SUBAGENT_LIMITS = { page: 100, text: 24000, toolBytes: 32000 } as const
const SubagentNativeModeSchema = z.enum(['claude-agent', 'codex-collab', 'codex-multi-agent-v2', 'opencode-task'])
export type SubagentNativeMode = z.infer<typeof SubagentNativeModeSchema>
const SubagentCapabilitySchema = z.object({
  support: z.enum(['supported', 'unsupported', 'unverified']),
  qualification: z.enum(['passed', 'unverified', 'failed']), reasonCode: id.optional(),
}).strict()
export const SubagentCapabilitiesSchema = z.object({
  lifecycle: SubagentCapabilitySchema, transcript: SubagentCapabilitySchema,
  toolCalls: SubagentCapabilitySchema, toolResults: SubagentCapabilitySchema,
  sendInput: SubagentCapabilitySchema, inputTiming: z.enum(['active', 'idle', 'active-and-idle', 'none']),
  interrupt: SubagentCapabilitySchema, historyReadback: SubagentCapabilitySchema, executionResume: SubagentCapabilitySchema,
}).strict()
export type SubagentCapabilities = z.infer<typeof SubagentCapabilitiesSchema>
const SubagentCoverageSchema = z.object({
  transcript: z.enum(['complete', 'partial', 'unavailable']), tools: z.enum(['complete', 'partial', 'unavailable']), gaps: z.boolean(),
}).strict()
export const RunSubagentSchema = z.object({
  schemaVersion: z.literal(1), id, revision,
  workspaceId: id, workflowId: id, workflowVersionId: id, runId: id,
  parentNodeId: id, parentAgentId: id, parentExecutionId: id, parentAttemptKey: id, parentSubagentId: id.nullable(),
  provider: z.enum(['claude', 'codex', 'opencode']), nativeMode: SubagentNativeModeSchema,
  native: z.object({ parentSessionId: id, childSessionId: id.optional(), agentId: id.optional(), taskId: id.optional(),
    spawnToolUseId: id.optional(), currentTurnId: id.optional(), agentPath: id.optional() }).strict(),
  profile: z.object({ deviceId: id, harnessInstanceId: id, providerVersion: id,
    sdkVersion: id.optional(), schemaIdentity: id.optional(), qualificationId: id.optional() }).strict(),
  name: z.string().max(512).nullable(),
  status: z.enum(['pending', 'running', 'waiting', 'interrupting', 'completed', 'failed', 'canceled', 'unknown']),
  evidence: z.enum(['confirmed', 'reconciling', 'unknown']),
  firstObservedAt: timestamp, startedAt: timestamp.nullable(), finishedAt: timestamp.nullable(), lastObservedAt: timestamp,
  coverage: SubagentCoverageSchema, capabilities: SubagentCapabilitiesSchema,
}).strict().superRefine((value, context) => {
  const provider = value.nativeMode === 'claude-agent' ? 'claude' : value.nativeMode === 'opencode-task' ? 'opencode' : 'codex'
  if (value.provider !== provider || !(provider === 'claude' ? value.native.agentId : value.native.childSessionId)) {
    context.addIssue({ code: 'custom', path: ['native'], message: 'Exact provider child identity is required.' })
  }
})
export type RunSubagent = z.infer<typeof RunSubagentSchema>
const SubagentAvailableActionsSchema = z.object({ sendInput: z.boolean(), interrupt: z.boolean(),
  respond: z.boolean().optional(), blockedReason: id.nullable() }).strict()
export type SubagentAvailableActions = z.infer<typeof SubagentAvailableActionsSchema>
export const RunSubagentDetailSchema = z.object({ subagent: RunSubagentSchema, availableActions: SubagentAvailableActionsSchema,
  pendingInteraction: z.lazy(() => PendingNativeInteractionSchema).optional() }).strict()
const SubagentSourceSchema = z.object({ executionId: id, sequence: z.number().int().nonnegative(), connectionId: id.optional(),
  nativeEventId: id.optional(), nativeTurnId: id.optional(), generation: z.string().max(512).optional() }).strict()
export type SubagentSource = z.infer<typeof SubagentSourceSchema>
export const SubagentTruncationSchema = z.object({ truncated: z.boolean(), originalBytes: z.number().int().nonnegative() }).strict()
export const RunSubagentMessageSchema = z.object({ id, subagentId: id, revision, sequence: z.number().int().nonnegative(),
  nativeMessageId: id, nativeBlockId: id.optional(), parentToolUseId: id.optional(), role: z.enum(['user', 'assistant']),
  text: z.string().max(SUBAGENT_LIMITS.text), final: z.boolean(), occurredAt: timestamp,
  source: SubagentSourceSchema, truncation: SubagentTruncationSchema }).strict()
export type RunSubagentMessage = z.infer<typeof RunSubagentMessageSchema>
export const RunSubagentToolSchema = z.object({ id, subagentId: id, revision, sequence: z.number().int().nonnegative(), nativeToolId: id,
  nativeMessageId: id.optional(), parentToolUseId: id.optional(), name: z.string().max(512),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'canceled', 'unknown']),
  input: z.json().optional(), output: z.json().optional(), error: z.json().optional(),
  startedAt: timestamp.nullable(), finishedAt: timestamp.nullable(), durationMs: z.number().nonnegative().optional(),
  source: SubagentSourceSchema, truncation: SubagentTruncationSchema }).strict()
export type RunSubagentTool = z.infer<typeof RunSubagentToolSchema>
export const RunSubagentsListInputSchema = z.object({ workspaceId: id, runId: id, cursor: z.string().max(2048).optional(),
  limit: z.number().int().min(1).max(SUBAGENT_LIMITS.page).default(50) }).strict()
export const RunSubagentGetInputSchema = z.object({ workspaceId: id, runId: id, subagentId: id }).strict()
export const RunSubagentItemsInputSchema = RunSubagentsListInputSchema.extend({ subagentId: id }).strict()
const pageInfo = { nextCursor: z.string().nullable(), coverage: SubagentCoverageSchema }
export const RunSubagentsPageSchema = z.object({ items: z.array(RunSubagentDetailSchema).max(SUBAGENT_LIMITS.page), nextCursor: z.string().nullable(),
  projection: z.enum(['caught-up', 'catching-up']) }).strict()
export const RunSubagentMessagesPageSchema = z.object({ items: z.array(RunSubagentMessageSchema).max(SUBAGENT_LIMITS.page), ...pageInfo }).strict()
export const RunSubagentToolsPageSchema = z.object({ items: z.array(RunSubagentToolSchema).max(SUBAGENT_LIMITS.page), ...pageInfo }).strict()
export const RunSubagentInputSchema = RunSubagentGetInputSchema.extend({ commandId: optionalCommandId(id), expectedRevision: revision, text: z.string().min(1).max(SUBAGENT_LIMITS.text) }).strict()
export const RunSubagentInterruptSchema = RunSubagentGetInputSchema.extend({ commandId: optionalCommandId(id), expectedRevision: revision }).strict()
export const RunSubagentRespondSchema = RunSubagentInterruptSchema.extend({ nativeRequestId: z.string().min(1),
  optionId: id, response: z.json().optional() }).strict()
export const RunSubagentCommandReceiptSchema = z.object({ schemaVersion: z.literal(1), id, principalId: id,
  operation: z.enum(['run_subagent_input_v1', 'run_subagent_interrupt_v1', 'run_subagent_respond_v1']), commandId: id,
  workspaceId: id, runId: id, subagentId: id, expectedRevision: revision,
  nativeGeneration: id, nativeTurnId: id.nullable(), nativeCorrelationId: id,
  state: z.enum(['accepted', 'dispatching', 'acknowledged', 'rejected', 'uncertain']),
  acceptedAt: timestamp, updatedAt: timestamp, reasonCode: id.optional(),
  response: z.object({ nativeRequestId: z.string().min(1), nativeRequestType: z.string().min(1),
    option: z.lazy(() => ApprovalResponseOptionSchema) }).strict().optional(),
}).strict()
export type RunSubagentCommandReceipt = z.infer<typeof RunSubagentCommandReceiptSchema>

/** Native research support follows the observed mode contract. No app qualification follows from transport types or observed text. */
export function subagentCapabilities(mode: SubagentNativeMode): SubagentCapabilities {
  const unverified = { support: 'unverified', qualification: 'unverified' } as const
  const observed = { support: 'supported', qualification: 'unverified' } as const
  const codex = mode === 'codex-collab' || mode === 'codex-multi-agent-v2'
  if (mode === 'opencode-task') {
    const retired = { support: 'unsupported', qualification: 'unverified', reasonCode: 'HARNESS_RETIRED' } as const;
    return { lifecycle: retired, transcript: observed, historyReadback: observed, toolCalls: retired,
      toolResults: retired, sendInput: retired, inputTiming: 'none', interrupt: retired, executionResume: retired };
  }
  // Claude's probe did not preserve exact CLI identity; the app candidate remains behind its authority qualification.
  const observation = codex ? observed : unverified
  let sendInput: SubagentCapabilities['sendInput'] = unverified
  if (codex) {
    sendInput = observed
  } else if (mode === 'claude-agent') {
    sendInput = { ...unverified, support: 'unsupported', reasonCode: 'CLAUDE_DIRECT_INPUT_UNSUPPORTED' }
  }
  return { lifecycle: observation, transcript: observation, historyReadback: observation,
    toolCalls: codex ? observed : unverified, toolResults: codex ? observed : unverified,
    sendInput, inputTiming: codex ? 'active-and-idle' : 'none',
    interrupt: codex ? observed : unverified,
    executionResume: codex ? observed : unverified }
}
