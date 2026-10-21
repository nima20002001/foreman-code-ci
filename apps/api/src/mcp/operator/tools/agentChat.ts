import { z } from 'zod'
import {
  EnsureAgentChatConversationRequestSchema, CancelQueuedAgentChatTurnRequestSchema, RespondAgentChatInteractionRequestSchema,
  AgentChatStateResponseSchema, AgentChatSendResponseSchema, AgentChatStateSchema,
  ReadAgentChatRequestSchema, ReadAgentChatResponseSchema, AgentChatMessageCommandSchema,
  AgentChatTurnSchema, AgentChatResetResponseSchema,
} from '@foreman-code/contracts/agent-chat'
import { ChatDeliveryIntentSchema, ChatSendRequestSchema, ChatStopRequestSchema, ChatQueueCancelRequestSchema,
  ChatDeliveryReceiptSchema, ChatControlReceiptSchema, DeliveryTargetSchema, EngineChatReadbackSchema,
  parseSessionCommand, type DeliveryTarget } from '@foreman-code/contracts'
import { MessageAttachmentRefsSchema } from '@foreman-code/contracts/files'
import {
  AgentChatReadToolInputSchema, AgentChatReadToolOutputSchema, AgentChatSendToolInputSchema, AgentChatInterruptToolInputSchema,
} from '@foreman-code/contracts/selected-run-chat'

import { DomainError } from '../../../modules/errors.js'
import { defineOperatorTool, type OperatorToolDefinition } from '../definition.js'
import { conversationFileTools } from './conversationFiles.js'
import type { OperatorRequestContext } from '../types.js'
import type { ChatDeliveryRouter } from '../../../modules/workflow-chat/delivery.js'

const workspace = z.string().min(1)
const conversation = z.string().min(1)
const deliveryInputs = ReadAgentChatRequestSchema.shape.deliveryInputs
const retainedInputs = ReadAgentChatResponseSchema.shape.deliveryInputs
const exactRead = z.object({ workspaceId: workspace, target: DeliveryTargetSchema,
  cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional(),
  commandId: z.string().min(1).optional(), receiptId: z.string().min(1).optional(), deliveryInputs }).strict()
const readAlternatives = z.union([AgentChatReadToolInputSchema, exactRead])
const readInput = z.object({ ...AgentChatReadToolInputSchema.shape,
  ...exactRead.partial().shape, workspaceId: workspace }).strict().superRefine((value, context) => validate(readAlternatives, value, context))
const presentation = z.object({ state: EngineChatReadbackSchema.shape.state, capabilities: EngineChatReadbackSchema.shape.capabilities }).extend({ nativeTurnId: z.string().optional() })
const canonicalRead = z.union([EngineChatReadbackSchema.safeExtend({ deliveryInputs: retainedInputs }),
  z.object({ target: DeliveryTargetSchema, state: ReadAgentChatResponseSchema, receipts: z.array(ChatDeliveryReceiptSchema), delivery: presentation }).strict(),
  z.object({ target: DeliveryTargetSchema, receipts: z.array(ChatDeliveryReceiptSchema).optional(), deliveryInputs: retainedInputs.unwrap() }).strict(),
  z.object({ target: DeliveryTargetSchema, receipts: z.array(ChatDeliveryReceiptSchema), controls: z.array(ChatControlReceiptSchema).optional() }).strict()])
const readOutputAlternatives = z.union([AgentChatReadToolOutputSchema, canonicalRead])
// MCP discovery requires one object envelope. Every accepted result still validates against its exact canonical arm.
const readOutput = z.object({ ...AgentChatReadToolOutputSchema.shape, ...z.object(EngineChatReadbackSchema.shape).partial().shape,
  target: z.union([AgentChatReadToolOutputSchema.shape.target.unwrap(), DeliveryTargetSchema]).optional(),
  state: z.union([ReadAgentChatResponseSchema, EngineChatReadbackSchema.shape.state]).optional(),
  capabilities: z.union([AgentChatStateSchema.shape.capabilities, EngineChatReadbackSchema.shape.capabilities]).optional(),
  messages: z.union([AgentChatStateSchema.shape.messages, EngineChatReadbackSchema.shape.messages]).optional(),
  receipts: z.union([ReadAgentChatResponseSchema.shape.receipts.unwrap(), z.array(ChatDeliveryReceiptSchema)]).optional(),
  delivery: presentation.optional(), deliveryInputs: retainedInputs, controls: z.array(ChatControlReceiptSchema).optional(),
}).strict().superRefine((value, context) => validate(readOutputAlternatives, value, context))

// Preserve omission before the legacy next_turn default is applied; explicit auto is never inferred.
const legacyRequest = z.object({ ...AgentChatMessageCommandSchema.shape, intent: ChatDeliveryIntentSchema.optional() }).strict()
  .superRefine((value, context) => validate(AgentChatMessageCommandSchema, value, context))
const legacyMessage = z.object({ ...AgentChatSendToolInputSchema.shape.message.unwrap().shape,
  intent: ChatDeliveryIntentSchema.optional() }).strict()
  .superRefine((value, context) => validate(AgentChatSendToolInputSchema.shape.message.unwrap(), value, context))
const legacySend = z.object({ ...AgentChatSendToolInputSchema.shape, request: legacyRequest.optional(), message: legacyMessage.optional() }).strict()
  .superRefine((value, context) => validate(AgentChatSendToolInputSchema, value, context))
const exactSend = ChatSendRequestSchema.safeExtend({ workspaceId: workspace })
const sendInput = z.object({ ...legacySend.shape, ...z.object(exactSend.shape).partial().shape, workspaceId: workspace,
  attachments: MessageAttachmentRefsSchema.optional() }).strict()
  .superRefine((value, context) => validate(z.union([legacySend, exactSend]), value, context))
const sendOutputAlternatives = z.union([AgentChatSendResponseSchema, ChatDeliveryReceiptSchema])
const sendOutput = z.object({ ...AgentChatResetResponseSchema.partial().shape, turn: AgentChatTurnSchema.optional(),
  replayWarning: z.unknown().optional(),
  ...z.object(ChatDeliveryReceiptSchema.shape).partial().shape, state: z.union([ReadAgentChatResponseSchema, EngineChatReadbackSchema, ChatDeliveryReceiptSchema.shape.state]).optional(),
  receipt: ChatDeliveryReceiptSchema.optional(),
}).strict().superRefine((value, context) => validate(sendOutputAlternatives, value, context))
const controlOutput = z.object({ ...AgentChatStateResponseSchema.partial().shape, ...z.object(ChatControlReceiptSchema.shape).partial().shape,
  state: z.union([AgentChatStateSchema, ChatControlReceiptSchema.shape.state]).optional(), receipt: ChatControlReceiptSchema.optional(),
}).strict().superRefine((value, context) => validate(z.union([
  AgentChatStateResponseSchema.extend({ receipt: ChatControlReceiptSchema.optional() }), ChatControlReceiptSchema,
]), value, context))
const exactStop = ChatStopRequestSchema.extend({ workspaceId: workspace })
const stopInput = z.object({ ...z.object(AgentChatInterruptToolInputSchema.shape).partial().shape, ...exactStop.partial().shape, workspaceId: workspace }).strict()
  .superRefine((value, context) => validate(z.union([AgentChatInterruptToolInputSchema, exactStop]), value, context))
const legacyCancel = CancelQueuedAgentChatTurnRequestSchema.extend({ workspaceId: workspace, conversationId: conversation, turnRequestId: z.string().min(1) })
const exactCancel = ChatQueueCancelRequestSchema.extend({ workspaceId: workspace })
const cancelInput = z.object({ ...legacyCancel.partial().shape, ...exactCancel.partial().shape, workspaceId: workspace }).strict()
  .superRefine((value, context) => validate(z.union([legacyCancel, exactCancel]), value, context))
const legacyCancelAll = z.object({ workspaceId: workspace, conversationId: conversation, commandId: z.string().min(1).optional() }).strict()
const cancelAllInput = z.object({ ...legacyCancelAll.partial().shape, ...exactCancel.partial().shape, workspaceId: workspace }).strict()
  .superRefine((value, context) => validate(z.union([legacyCancelAll, exactCancel]), value, context))

function validate(schema: z.ZodType, value: unknown, context: z.RefinementCtx): void {
  const parsed = schema.safeParse(value)
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
}
function bridge(context: OperatorRequestContext) {
  const value = context.services.agentChat?.deliveryBridge
  if (!value) throw new DomainError('CHAT_DELIVERY_UNAVAILABLE', 'Exact-target delivery is unavailable.', 503)
  return value
}
function agentScope(workspaceId: string, target: DeliveryTarget): void {
  if (target.kind === 'operator_conversation' || target.agent.workspaceId !== workspaceId) {
    throw new DomainError('CHAT_TARGET_SCOPE_MISMATCH', 'This target does not belong to the selected workspace.', 403)
  }
}

/** D may bind the common router directly; existing composition obtains it from the installed Agent bridge. */
export function createAgentChatTools(delivery?: Pick<ChatDeliveryRouter, 'send' | 'read' | 'stop' | 'cancel'>): readonly OperatorToolDefinition[] {
  const router = (context: OperatorRequestContext) => delivery ?? bridge(context).router
  return [
  ...conversationFileTools,
  defineOperatorTool({
    name: 'agent_chat_ensure_conversation',
    requires: [['agent_chat:write', 'resource'], ['agent_chat:read', 'resource']],
    enabled: services => !!services.agentChat,
    description: 'Prepare the stored Agent conversation before its first attachment. Pass workspaceId and context '
      + '{workflowId, workflowNodeId, agentId, runId?}, plus executionId for a selected Run execution. '
      + 'Returns the same persisted conversation on retry without sending a message or starting a native session. '
      + 'Requires agent_chat:read and agent_chat:write in that conversation scope.',
    inputSchema: EnsureAgentChatConversationRequestSchema.extend({ workspaceId: workspace }),
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, { workspaceId, context: query, executionId }) => ({ state: await context.services.agentChat!
      .ensureConversation(context.principal, { workspaceId, ...query }, executionId) }),
  }),
  defineOperatorTool({
    name: 'agent_chat_read',
    requires: [['agent_chat:read', 'resource']],
    enabled: s => !!s.agentChat || !!delivery,
    description: 'Use workspaceId plus exact target for live execution, waiting-coordinator or standalone chat; target contains every observed execution/activation identity. Exact-target reads accept cursor/limit, commandId or receiptId for reconciliation, and deliveryInputs {cursor?, limit?, receiptId?, bodyCursor?} for immutable original input and file pins even before native adoption. No target resolution or native creation occurs on this arm. Pass conversationId with query to read a retained conversation in that exact Agent context, including its previousConversationId history link. Read the chat for one workflow Agent node with query, or an exact historical Run node with selection: {workflowId, runId, workflowNodeId, executionId?}. Supply exactly one selector. Historical selection uses the immutable Run snapshot, works after removing the Agent, and returns kind selected, execution_selection_required, or unavailable. When multiple executions exist, choose executionId explicitly; never choose another execution because it has a session. sourceTranscript contains the execution’s public messages while starting, running and completed, independently of chat session availability. It is bounded to the latest 100 messages and 128 KiB of text, with explicit truncation. Follow-up chat forks only a completed execution; the parent Run may still be working. A selected result includes state and a complete key, or null key until a conversation exists. Reads never attach, create, fork or resume a native session. Returns the conversation, native session, delivery receipts, messages, public activity, capabilities and why sending is blocked. activitySnapshot.observation reports pending native history reads with unavailable status, lastError, failedAt, lastSuccess and consecutiveFailures; retained activity is unconfirmed until history recovers. When availability.canSend is true, the first message may create the conversation and its separate native session; an unavailable source must not be replaced. Pass history: {limit, before?} to retrieve complete follow-up messages omitted from the byte-bounded snapshot (including a single oversized message); follow history.nextCursor until null. Pass receipts: {limit, before?} to page all retained delivery receipts; follow receipts.nextCursor until null. Pages are oldest-first and begin with the newest page when before is omitted. hasMoreTurns marks legacy overflow: sending is blocked, not all receipts fit in state.turns, and queued receipts can be canceled with agent_chat_cancel_queued or agent_chat_interrupt. Unconfirmed deliveries are never treated as canceled. Pass executionActivity: {cursor?, executionId?, before?, itemId?, limit?} with query.runId to read the live public activity of that Run Agent\u2019s newest 20 executions (labeled Execution, Attempt n, Loop n or Occurrence n): messages plus tool, shell command, file, MCP, plan, reasoning-summary and subagent steps with status and bounded output previews, ordered by execution then native sequence. Without cursor it returns the newest window; pass the returned cursor to receive only changed entries (hasMoreChanges means read again now). executionId with before pages older entries; executionId with itemId returns one entry with bounded bodies (message 64 KiB, arguments 16,000 bytes and output 24,000 bytes); truncation is explicit. Public pages are bounded to 200 items and 256 KiB. Cursors are opaque and also include execution-state changes, including unfinished tools becoming unknown after an execution finishes. Requires agent_chat:read.',
    inputSchema: readInput, outputSchema: readOutput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, raw) => {
    if (raw.target) {
      const { workspaceId, ...input } = exactRead.parse(raw)
      agentScope(workspaceId, input.target)
      return router(context).read(context.principal, input)
    }
    const { workspaceId, query, selection, conversationId, history, receipts, executionActivity, deliveryInputs } = AgentChatReadToolInputSchema.parse(raw)
    if (executionActivity && !query?.runId) {
      throw new DomainError('AGENT_CHAT_EXECUTION_ACTIVITY_REQUIRES_RUN', 'executionActivity requires query with runId.', 400)
    }
    if (selection) {
      const selected = await context.services.agentChat!.readSelectedRun(context.principal, { selection: { workspaceId, ...selection },
        ...(history ? { history } : {}), ...(receipts ? { receipts } : {}) })
      if (!deliveryInputs) return selected
      if (selected.kind !== 'selected') throw new DomainError('CHAT_TARGET_SELECTION_REQUIRED', 'Choose an exact target before reading retained delivery inputs.', 409)
      const target = 'deliveryTarget' in selected ? DeliveryTargetSchema.parse(selected.deliveryTarget) : selected.key
        ? { kind: 'agent_conversation' as const, conversationId: selected.key.conversationId,
          agent: { workspaceId, workflowId: selected.key.workflowId, workflowNodeId: selected.key.workflowNodeId, agentId: selected.key.agentId } }
        : undefined
      if (!target) throw new DomainError('CHAT_TARGET_RESOLVER_UNAVAILABLE', 'Read the selected execution target before requesting its retained inputs.', 503)
      if (target.kind === 'workflow_execution' && target.execution.executionId !== selected.selection.executionId) {
        throw new DomainError('CHAT_TARGET_SCOPE_MISMATCH', 'The selected execution target changed.', 409)
      }
      return { ...selected, deliveryInputs: await bridge(context).readAgentInputs(context.principal, workspaceId,
        { target }, deliveryInputs) }
    }
    const state = conversationId
      ? await context.services.agentChat!.readConversation(context.principal, workspaceId, conversationId)
      : await context.services.agentChat!.read(context.principal, workspaceId, query!)
    if (conversationId && (state.context.workflowId !== query!.workflowId
      || state.context.workflowNodeId !== query!.workflowNodeId || state.context.agentId !== query!.agentId
      || state.context.runId !== query!.runId)) {
      throw new DomainError('AGENT_CHAT_CONTEXT_STALE', 'The conversation belongs to another Agent context.', 409)
    }
    const id = state.conversation?.id
    return { ...state,
      ...(conversationId ? { deliveryTarget: { kind: 'agent_conversation', conversationId,
        agent: { workspaceId, workflowId: state.context.workflowId, workflowNodeId: state.context.workflowNodeId, agentId: state.context.agentId } },
        deliveryTargetState: 'existing' } : {}),
      ...(id && history ? { history: await context.services.agentChat!.history(context.principal, workspaceId, id, history.before, history.limit) } : {}),
      ...(id && receipts ? { receipts: await context.services.agentChat!.receipts(context.principal, workspaceId, id, receipts.before, receipts.limit) } : {}),
      ...(executionActivity && query?.runId ? { executionActivity: await context.services.agentChat!.executionActivity(context.principal, workspaceId,
        { ...query, runId: query.runId }, executionActivity) } : {}),
      ...(deliveryInputs ? { deliveryInputs: await bridge(context).readAgentInputs(context.principal, workspaceId,
        { query, ...(conversationId ? { conversationId } : {}), ...('deliveryTarget' in state && state.deliveryTarget ? { target: DeliveryTargetSchema.parse(state.deliveryTarget) } : {}) }, deliveryInputs) } : {}),
    }
  },
  }),
  defineOperatorTool({
    name: 'agent_chat_send',
    requires: [['agent_chat:write', 'resource'], ['agent_chat:read', 'resource']],
    enabled: s => !!s.agentChat || !!delivery,
    description: 'For an exact live target pass workspaceId, target, commandId, intent, content and optional attachment pins/sessionMode/expectedNativeTurnId. Explicit auto steers only through actual capability and the observed native turn; otherwise it queues or starts now. Auto never interrupts. Steer is text-only with no mode change; same-mode Plan task text can steer. interrupt_and_send is explicit and returns continuation links without changing workflow stop state. Omitted legacy intent remains next_turn. Send content /new with intent next_turn to start a fresh conversation for the same Agent node on its saved execution computer. The previous conversation stays in history; the result has reset {requestId, previousConversationId}, state and replayed instead of a model turn. No native prompt is sent until the next ordinary message. Reuse the identical requestId after a lost response. /new takes no attachments or sessionMode. Use agent_chat_controls_update for bare /compact, /plan and /plan off. For one Plan task send sessionMode: plan with its task text through the same admission. Send a message to a workflow Agent chat using request. content and request metadata accept up to 768 KiB as UTF-8 JSON; saved context and configuration also count toward the Worker 1 MiB request limit. Shorten oversized messages or upload their content as an attachment. content may be empty only when attachments contains at least one fileId/revisionId pin for an existing conversation. For historical selection, instead supply selection: {workflowId, runId, workflowNodeId, executionId} and message with the usual message fields except context; Agent identity comes from the snapshot. The follow-up forks and recovers on the original accepted execution computer and profile; unavailable placement fails without changing hosts. Never supply both forms. intent next_turn queues after the active turn (or starts now when idle); steer adds text only to the active turn when capabilities.steer allows it and needs expectedNativeTurnId; steering may retain the active applied mode, including same-mode Plan task text, but mode changes require next_turn or interrupt_and_send; attachments are rejected for steer before admission, so use next_turn or interrupt_and_send for files; interrupt_and_send stops the active turn and sends once. Set expectedConversationId to the conversation id read before (null for the first message). Reuse the exact requestId and input after a lost response: the stored receipt is returned and nothing is resent. For old interrupt_and_send receipts whose target was not retained, replayWarning AGENT_CHAT_LEGACY_TARGET_UNVERIFIABLE means readback only: content, intent and context match, but the supplied target was not verified or applied (including a changed or omitted target). Do not interpret that receipt as a new command or verified target match. Never starts or changes a workflow Run. Requires agent_chat:write and agent_chat:read.',
    inputSchema: sendInput, outputSchema: sendOutput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, raw) => {
      if (raw.target) {
        const { workspaceId, ...request } = exactSend.parse(raw)
        agentScope(workspaceId, request.target)
        return router(context).send(context.principal, request)
      }
      const explicit = raw.request?.intent !== undefined || raw.message?.intent !== undefined
      const { workspaceId, request, selection, message } = AgentChatSendToolInputSchema.parse(raw)
      if (selection && message?.intent === 'auto') throw new DomainError('CHAT_TARGET_REQUIRED', 'Use the exact canonical target from readback for automatic delivery.', 409)
      if (selection && message) return context.services.agentChat!.sendSelectedRunCommand(context.principal,
        { selection: { workspaceId, ...selection }, message }, 'mcp')
      const chat = context.services.agentChat!
      if (request!.intent === 'auto' && !chat.deliveryBridge) {
        throw new DomainError('CHAT_DELIVERY_UNAVAILABLE', 'Automatic delivery is unavailable.', 503)
      }
      if (explicit && chat.deliveryBridge && parseSessionCommand(request!.content).kind !== 'new') {
        return chat.deliveryBridge.sendAgent(context.principal, workspaceId, request!)
      }
      return chat.sendCommand(context.principal, workspaceId, request!, 'mcp')
    },
  }),
  defineOperatorTool({
    name: 'agent_chat_interrupt',
    requires: [['agent_chat:cancel', 'resource'], ['agent_chat:read', 'resource']],
    enabled: s => !!s.agentChat || !!delivery,
    description: 'Stop chat only, never Stop Run. With exact target and commandId, set scope active_turn to preserve queued work or active_and_queued to stop and cancel its queue. Supply the observed expectedNativeTurnId when available. Legacy conversationId/requestId without scope retains active_and_queued; explicit active_turn preserves the queue. Historical selection checks its complete saved key. Reuse the identical command after response loss; never retarget to a later active turn. Requires agent_chat:cancel and agent_chat:read.',
    inputSchema: stopInput,
    outputSchema: controlOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (context, raw) => {
      if (raw.target) {
        const { workspaceId, ...request } = exactStop.parse(raw); agentScope(workspaceId, request.target)
        return router(context).stop(context.principal, request)
      }
      const { workspaceId, conversationId, selection, ...request } = AgentChatInterruptToolInputSchema.parse(raw)
      if (selection) return { state: await context.services.agentChat!.interruptSelectedRun(context.principal,
        { key: { workspaceId, conversationId, ...selection }, request }, 'mcp') }
      if (request.scope) return bridge(context).stopAgent(context.principal, workspaceId, conversationId, { ...request, scope: request.scope })
      return { state: await context.services.agentChat!.interrupt(context.principal, workspaceId, conversationId, request, 'mcp') }
    },
  }),
  defineOperatorTool({
    name: 'agent_chat_cancel_queued',
    requires: [['agent_chat:cancel', 'resource'], ['agent_chat:read', 'resource']],
    enabled: s => !!s.agentChat || !!delivery,
    description: 'Cancel one queued Agent input without stopping the active turn. Use exact target with selection {kind: one, receiptId} and commandId, or legacy conversationId/turnRequestId/requestId. Fails after native submission. Reuse the original command after response loss. Requires agent_chat:cancel and agent_chat:read.',
    inputSchema: cancelInput,
    outputSchema: controlOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (context, raw) => {
      if (raw.target) {
        const { workspaceId, ...request } = exactCancel.parse(raw); agentScope(workspaceId, request.target)
        if (request.selection.kind !== 'one') throw new DomainError('CHAT_QUEUE_SELECTION_INVALID', 'Use agent_chat_cancel_all_queued for all queued inputs.', 400)
        return router(context).cancel(context.principal, request)
      }
      const { workspaceId, conversationId, turnRequestId, ...request } = legacyCancel.parse(raw)
      return { state: await context.services.agentChat!.cancelQueued(context.principal, workspaceId, conversationId, turnRequestId, request, 'mcp') }
    },
  }),
  defineOperatorTool({
    name: 'agent_chat_cancel_all_queued', requires: [['agent_chat:cancel', 'resource'], ['agent_chat:read', 'resource']],
    enabled: s => !!delivery || !!s.agentChat?.deliveryBridge,
    description: 'Cancel only the currently queued inputs for this exact target. Never stops active work, resumes a Run, or cancels delegated children. Pass target, selection {kind: all}, workspaceId and commandId; a standalone conversationId is also accepted. Replay the same command after response loss.',
    inputSchema: cancelAllInput, outputSchema: controlOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (context, raw) => {
      if (raw.target) {
        const { workspaceId, ...request } = exactCancel.parse(raw); agentScope(workspaceId, request.target)
        if (request.selection.kind !== 'all') throw new DomainError('CHAT_QUEUE_SELECTION_INVALID', 'Select all queued inputs for this command.', 400)
        return router(context).cancel(context.principal, request)
      }
      const { workspaceId, conversationId, commandId } = legacyCancelAll.parse(raw)
      return bridge(context).cancelAgent(context.principal, workspaceId, conversationId, { commandId, selection: { kind: 'all' } })
    },
  }),
  defineOperatorTool({
    name: 'agent_chat_respond',
    requires: [['agent_chat:respond', 'resource'], ['agent_chat:read', 'resource']],
    enabled: s => !!s.agentChat,
    description: 'Answer the pending native approval or input request in an Agent chat with an offered option. '
      + 'Standalone Codex forms are bound to their native session and request, without a turn ID. '
      + 'For questions and forms, supply response matching the option input schema. Reuse requestId with the same '
      + 'choice and response after a lost response; uncertain delivery is never resent. '
      + 'Read agent_chat_read activitySnapshot for the saved decision and providerAcknowledged: '
      + 'a recorded answer alone is not delivery confirmation; native consumption may confirm it later. '
      + 'Requires agent_chat:respond and agent_chat:read.',
    inputSchema: RespondAgentChatInteractionRequestSchema.extend({ workspaceId: workspace, conversationId: conversation }),
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, { workspaceId, conversationId, ...request }) => ({ state: await context.services.agentChat!.respond(context.principal, workspaceId, conversationId, request, 'mcp') }),
  }),
  ]
}

export const agentChatTools = createAgentChatTools()
