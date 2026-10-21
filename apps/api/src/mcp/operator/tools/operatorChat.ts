import { z } from 'zod'
import { IdSchema, OperatorActivityPageSchema, OperatorActivityQuerySchema,
  CreateOperatorConversationRequestSchema, CreateOperatorConversationResponseSchema,
  OperatorConversationDeletionInputSchema, DeleteOperatorConversationResponseSchema,
  ListOperatorConversationsResponseSchema,
  GetOperatorConversationResponseSchema, SendOperatorMessageRequestSchema, SendOperatorMessageResponseSchema } from '@foreman-code/contracts'
import { OperatorConversationHistoryPageSchema, OperatorConversationHistoryQuerySchema,
  OperatorHandoffHistoryPageSchema, OperatorHistoryCursorSchema } from '@foreman-code/contracts/operator-chat'
import { defineOperatorTool } from '../definition.js'

/** Existing Operator conversation tools; availability and legacy semantics remain service-owned. */
export const operatorChatTools = [
  defineOperatorTool({
    name: 'operator_chat_create',
    requires: [['operator_chat:write', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Create an owner-bound Operator draft using the current saved Operator defaults. '
      + 'Empty drafts stay hidden from operator_chat_list and the sidebar until the first message is sent. '
      + 'Keep the returned conversation ID to send or read it with operator_chat_get. '
      + 'commandId is optional and generated when omitted. Supply an ID and reuse it with the same title '
      + 'after a lost response to recover the same draft, even if defaults have changed. '
      + 'Reusing it with a different title is a conflict. Requires global operator_chat:write.',
    inputSchema: CreateOperatorConversationRequestSchema,
    outputSchema: CreateOperatorConversationResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, { commandId, title }) => ({
    conversation: await context.services.operatorChat!.create(context.principal, title, commandId ? { commandId, source: 'mcp' } : undefined),
  }),
  }),
  defineOperatorTool({
    name: 'operator_chat_delete',
    requires: [['operator_chat:write', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Soft-delete an owned idle Operator chat, removing it from history and revoking its delegated '
      + 'chat credentials. Stop an active turn first. Requires global operator_chat:write. Reuse commandId with '
      + 'the same conversationId after an uncertain response; a replay does not delete the chat again after '
      + 'restoration. New outcomes include the saved deletion revision; historical replays retain their original response. Use operator_chat_restore to undo and operator_chat_list to read persisted history.',
    inputSchema: OperatorConversationDeletionInputSchema,
    outputSchema: DeleteOperatorConversationResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId, commandId }) => context.services.operatorChat!.setDeleted(conversationId, context.principal, true, { commandId, source: 'mcp' }),
  }),
  defineOperatorTool({
    name: 'operator_chat_restore',
    requires: [['operator_chat:write', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Restore an owned deleted Operator chat to history. Previously revoked delegated chat credentials '
      + 'stay revoked. Requires global operator_chat:write and an idle chat. Reuse commandId with the same '
      + 'conversationId after an uncertain response; a replay does not restore the chat again after another deletion. '
      + 'New outcomes include the restored revision; historical replays retain their original response. Read back with operator_chat_list or operator_chat_get, requiring operator_chat:read.',
    inputSchema: OperatorConversationDeletionInputSchema,
    outputSchema: DeleteOperatorConversationResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId, commandId }) => context.services.operatorChat!.setDeleted(conversationId, context.principal, false, { commandId, source: 'mcp' }),
  }),
  defineOperatorTool({
    name: 'operator_chat_list',
    requires: [['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'List this caller\'s persisted Operator conversations with messages, matching sidebar history. '
      + 'Empty drafts are retained but hidden until the first message is sent; '
      + 'read a draft by its creation ID with operator_chat_get. Returns only conversations owned by this '
      + 'principal and excludes deleted conversations. Requires global operator_chat:read.',
    inputSchema: z.object({}).strict(),
    outputSchema: ListOperatorConversationsResponseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context) => ({
      conversations: await context.services.operatorChat!.list(context.principal),
    }),
  }),
  defineOperatorTool({
    name: 'operator_chat_get',
    requires: [['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Read an owned Operator conversation snapshot, including its harness handoff parent and recent persisted messages and activities. activitySnapshot.observation reports pending native history reads with unavailable status, lastError, failedAt, lastSuccess and consecutiveFailures; retained activity is unconfirmed until history recovers. nativeSubmission identifies the observed Claude input message for the active request. Use operator_chat_history_get and operator_chat_activity_get to page older records. Message acceptedModel identifies the model from that message\'s immutable accepted turn configuration, when recorded. Requires operator_chat:read.',
    inputSchema: z.object({ conversationId: z.string().min(1) }).strict(), outputSchema: GetOperatorConversationResponseSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId }) => context.services.operatorChat!.get(conversationId, context.principal),
  }),
  defineOperatorTool({
    name: 'operator_chat_history_get',
    requires: [['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Page the persisted messages and acceptance receipts of an owned Operator conversation, including messages omitted from operator_chat_get. Pages are oldest-first; pass nextCursor as before to read older records. Cursors are decimal strings bound to this conversation. Requires global operator_chat:read.',
    inputSchema: OperatorConversationHistoryQuerySchema.extend({ conversationId: IdSchema }),
    outputSchema: OperatorConversationHistoryPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId, ...query }) => context.services.operatorChat!.history(conversationId, context.principal, query),
  }),
  defineOperatorTool({
    name: 'operator_chat_activity_get',
    requires: [['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Page persisted activity of an owned Operator conversation, including records omitted from operator_chat_get. Supply requestId and activityId to read one persisted item regardless of its age. Pages are oldest-first; pass nextCursor as before to read older records. Cursors are decimal strings bound to this conversation. Requires global operator_chat:read.',
    inputSchema: OperatorActivityQuerySchema.extend({ conversationId: IdSchema }),
    outputSchema: OperatorActivityPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId, ...query }) => context.services.operatorChat!.activityPage(conversationId, context.principal, query),
  }),
  defineOperatorTool({
    name: 'operator_chat_send',
    requires: [['operator_chat:write', 'global'], ['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Use operator_chat_controls_update for bare /compact, /plan and /plan off. For one Plan task send sessionMode: plan with its task text. Send an owned Operator message and return protected conversation state. Reserve configurationVersionId from operator_chat_get. For a different harness, also supply forkExpectedRevision and defaultsRevision from agent_defaults_get; existing chats retain their access policy. A showThinking-only change retains the owned native session and immutable prior turn configuration. Reuse the exact request ID and command fields after a lost response. Set recovery to receipt to read acceptance without starting or retrying native work; OPERATOR_RECEIPT_NOT_FOUND is not proof of non-delivery. Requires operator_chat:read and operator_chat:write, including receipt-only recovery.',
    inputSchema: z.object({ conversationId: z.string().min(1), request: SendOperatorMessageRequestSchema }).strict(),
    outputSchema: SendOperatorMessageResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId, request }) => context.services.operatorChat!.send(conversationId, request, context.principal),
  }),
  defineOperatorTool({
    name: 'operator_handoff_history_get',
    requires: [['operator_handoff:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Read older user and assistant text from an ancestor of this credential-bound fork, up to its frozen handoff cutoff. This tool cannot read other conversations or tool/approval payloads. Requires the delegated operator_handoff:read grant.',
    inputSchema: z.object({ sourceConversationId: z.string().min(1).optional(), before: OperatorHistoryCursorSchema.optional() }).strict(),
    outputSchema: OperatorHandoffHistoryPageSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, { sourceConversationId, before }) => context.services.operatorChat!.handoffHistory(context.principal, sourceConversationId, before),
  }),
]
