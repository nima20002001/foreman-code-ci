import { z } from 'zod'
import {
  EnsureAgentChatConversationRequestSchema, CancelQueuedAgentChatTurnRequestSchema, RespondAgentChatInteractionRequestSchema,
  AgentChatStateResponseSchema, AgentChatSendResponseSchema,
} from '@foreman-code/contracts/agent-chat'
import {
  AgentChatReadToolInputSchema, AgentChatReadToolOutputSchema, AgentChatSendToolInputSchema, AgentChatInterruptToolInputSchema,
} from '@foreman-code/contracts/selected-run-chat'

import { DomainError } from '../../../modules/errors.js'
import { defineOperatorTool, type OperatorToolDefinition } from '../definition.js'
import { conversationFileTools } from './conversationFiles.js'

const workspace = z.string().min(1)
const conversation = z.string().min(1)

/** Operator MCP parity for the Board's selected-Agent chat. Same services, receipts and authorization as HTTP. */
export const agentChatTools: readonly OperatorToolDefinition[] = [
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
    enabled: s => !!s.agentChat,
    description: 'Pass conversationId with query to read a retained conversation in that exact Agent context, including its previousConversationId history link. Read the chat for one workflow Agent node with query, or an exact historical Run node with selection: {workflowId, runId, workflowNodeId, executionId?}. Supply exactly one selector. Historical selection uses the immutable Run snapshot, works after removing the Agent, and returns kind selected, execution_selection_required, or unavailable. When multiple executions exist, choose executionId explicitly; never choose another execution because it has a session. sourceTranscript contains the execution’s public messages while starting, running and completed, independently of chat session availability. It is bounded to the latest 100 messages and 128 KiB of text, with explicit truncation. Follow-up chat forks only a completed execution; the parent Run may still be working. A selected result includes state and a complete key, or null key until a conversation exists. Reads never attach, create, fork or resume a native session. Returns the conversation, native session, delivery receipts, messages, public activity, capabilities and why sending is blocked. activitySnapshot.observation reports pending native history reads with unavailable status, lastError, failedAt, lastSuccess and consecutiveFailures; retained activity is unconfirmed until history recovers. When availability.canSend is true, the first message may create the conversation and its separate native session; an unavailable source must not be replaced. Pass history: {limit, before?} to retrieve complete follow-up messages omitted from the byte-bounded snapshot (including a single oversized message); follow history.nextCursor until null. Pass receipts: {limit, before?} to page all retained delivery receipts; follow receipts.nextCursor until null. Pages are oldest-first and begin with the newest page when before is omitted. hasMoreTurns marks legacy overflow: sending is blocked, not all receipts fit in state.turns, and queued receipts can be canceled with agent_chat_cancel_queued or agent_chat_interrupt. Unconfirmed deliveries are never treated as canceled. Pass executionActivity: {cursor?, executionId?, before?, itemId?, limit?} with query.runId to read the live public activity of that Run Agent\u2019s newest 20 executions (labeled Execution, Attempt n, Loop n or Occurrence n): messages plus tool, shell command, file, MCP, plan, reasoning-summary and subagent steps with status and bounded output previews, ordered by execution then native sequence. Without cursor it returns the newest window; pass the returned cursor to receive only changed entries (hasMoreChanges means read again now). executionId with before pages older entries; executionId with itemId returns one entry with bounded bodies (message 64 KiB, arguments 16,000 bytes and output 24,000 bytes); truncation is explicit. Public pages are bounded to 200 items and 256 KiB. Cursors are opaque and also include execution-state changes, including unfinished tools becoming unknown after an execution finishes. Requires agent_chat:read.',
    inputSchema: AgentChatReadToolInputSchema, outputSchema: AgentChatReadToolOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, { workspaceId, query, selection, conversationId, history, receipts, executionActivity }) => {
    if (executionActivity && !query?.runId) {
      throw new DomainError('AGENT_CHAT_EXECUTION_ACTIVITY_REQUIRES_RUN', 'executionActivity requires query with runId.', 400)
    }
    if (selection) return context.services.agentChat!.readSelectedRun(context.principal, { selection: { workspaceId, ...selection },
      ...(history ? { history } : {}), ...(receipts ? { receipts } : {}) })
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
      ...(id && history ? { history: await context.services.agentChat!.history(context.principal, workspaceId, id, history.before, history.limit) } : {}),
      ...(id && receipts ? { receipts: await context.services.agentChat!.receipts(context.principal, workspaceId, id, receipts.before, receipts.limit) } : {}),
      ...(executionActivity && query?.runId ? { executionActivity: await context.services.agentChat!.executionActivity(context.principal, workspaceId,
        { ...query, runId: query.runId }, executionActivity) } : {}),
    }
  },
  }),
  defineOperatorTool({
    name: 'agent_chat_send',
    requires: [['agent_chat:write', 'resource'], ['agent_chat:read', 'resource']],
    enabled: s => !!s.agentChat,
    description: 'Send content /new with intent next_turn to start a fresh conversation for the same Agent node on its saved execution computer. The previous conversation stays in history; the result has reset {requestId, previousConversationId}, state and replayed instead of a model turn. No native prompt is sent until the next ordinary message. Reuse the identical requestId after a lost response. /new takes no attachments or sessionMode. Use agent_chat_controls_update for bare /compact, /plan and /plan off. For one Plan task send sessionMode: plan with its task text through the same admission. Send a message to a workflow Agent chat using request. content and request metadata accept up to 768 KiB as UTF-8 JSON; saved context and configuration also count toward the Worker 1 MiB request limit. Shorten oversized messages or upload their content as an attachment. content may be empty only when attachments contains at least one fileId/revisionId pin for an existing conversation. For historical selection, instead supply selection: {workflowId, runId, workflowNodeId, executionId} and message with the usual message fields except context; Agent identity comes from the snapshot. The follow-up forks and recovers on the original accepted execution computer and profile; unavailable placement fails without changing hosts. Never supply both forms. intent next_turn queues after the active turn (or starts now when idle); steer adds text only to the active turn when capabilities.steer allows it and needs expectedNativeTurnId; steering may retain the active applied mode but mode changes and /plan tasks require next_turn or interrupt_and_send; attachments are rejected for steer before admission, so use next_turn or interrupt_and_send for files; interrupt_and_send stops the active turn and sends once. Set expectedConversationId to the conversation id read before (null for the first message). Reuse the exact requestId and input after a lost response: the stored receipt is returned and nothing is resent. For old interrupt_and_send receipts whose target was not retained, replayWarning AGENT_CHAT_LEGACY_TARGET_UNVERIFIABLE means readback only: content, intent and context match, but the supplied target was not verified or applied (including a changed or omitted target). Do not interpret that receipt as a new command or verified target match. Never starts or changes a workflow Run. Requires agent_chat:write and agent_chat:read.',
    inputSchema: AgentChatSendToolInputSchema, outputSchema: AgentChatSendResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { workspaceId, request, selection, message }) => selection && message ? context.services.agentChat!.sendSelectedRunCommand(context.principal, { selection: { workspaceId, ...selection }, message }, 'mcp')
      : context.services.agentChat!.sendCommand(context.principal, workspaceId, request!, 'mcp'),
  }),
  defineOperatorTool({
    name: 'agent_chat_interrupt',
    requires: [['agent_chat:cancel', 'resource'], ['agent_chat:read', 'resource']],
    enabled: s => !!s.agentChat,
    description: 'Stop the active chat turn and cancel every queued message in this Agent conversation. For a selected historical Run, additionally pass selection: {workflowId, runId, workflowNodeId, agentId, executionId} from its readback key; every id is checked before any native action. Reuse requestId with identical input after a lost response; uncertain delivery is never resent. Requires agent_chat:cancel and agent_chat:read.',
    inputSchema: AgentChatInterruptToolInputSchema,
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (context, { workspaceId, conversationId, selection, ...request }) => ({ state: selection
      ? await context.services.agentChat!.interruptSelectedRun(context.principal, { key: { workspaceId, conversationId, ...selection }, request }, 'mcp')
      : await context.services.agentChat!.interrupt(context.principal, workspaceId, conversationId, request, 'mcp') }),
  }),
  defineOperatorTool({
    name: 'agent_chat_cancel_queued',
    requires: [['agent_chat:cancel', 'resource'], ['agent_chat:read', 'resource']],
    enabled: s => !!s.agentChat,
    description: 'Cancel one queued Agent chat message before it is sent to the Agent. Fails when it already started. Reuse requestId with identical input after a lost response; uncertain delivery is never resent. Requires agent_chat:cancel and agent_chat:read.',
    inputSchema: CancelQueuedAgentChatTurnRequestSchema.extend({ workspaceId: workspace, conversationId: conversation, turnRequestId: z.string().min(1) }),
    outputSchema: AgentChatStateResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (context, { workspaceId, conversationId, turnRequestId, ...request }) => ({ state: await context.services.agentChat!.cancelQueued(context.principal, workspaceId, conversationId, turnRequestId, request, 'mcp') }),
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
