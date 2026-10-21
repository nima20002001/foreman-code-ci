import { z } from 'zod'
import { CancelOperatorTurnRequestSchema, CancelOperatorTurnResponseSchema, RespondOperatorInteractionRequestSchema,
  ChatStopRequestSchema, ChatQueueCancelRequestSchema, ChatControlReceiptSchema,
  ChatSendRequestSchema, ChatDeliveryReceiptSchema, DeliveryTargetSchema, EngineChatReadbackSchema,
  GetOperatorConversationResponseSchema, SendOperatorMessageRequestSchema, SendOperatorMessageResponseSchema,
  type DeliveryTarget } from '@foreman-code/contracts'
import { ReadAgentChatRequestSchema, ReadAgentChatResponseSchema } from '@foreman-code/contracts/agent-chat'
import { defineOperatorTool } from '../definition.js'
import type { OperatorRequestContext } from '../types.js'
import { operatorDeliveryBridge } from '../../../modules/workflow-chat/deliveryBridgeAccess.js'
import type { ChatDeliveryRouter } from '../../../modules/workflow-chat/delivery.js'
import { DomainError } from '../../../modules/errors.js'

const controlOutput = z.object({ ...CancelOperatorTurnResponseSchema.partial().shape, ...z.object(ChatControlReceiptSchema.shape).partial().shape,
  state: z.union([CancelOperatorTurnResponseSchema.shape.state, ChatControlReceiptSchema.shape.state]).optional(),
}).strict().superRefine((value, context) => {
  const parsed = z.union([CancelOperatorTurnResponseSchema, ChatControlReceiptSchema]).safeParse(value)
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
})
function assertConversation(conversationId: string, target: DeliveryTarget): void {
  if (target.kind !== 'operator_conversation' || target.conversationId !== conversationId) {
    throw new DomainError('CHAT_TARGET_SCOPE_MISMATCH', 'This target does not belong to the selected Operator conversation.', 403)
  }
}

/** Actual HTTP control services and native receipt fence, including current owner/grant rechecks. */
export function createOperatorControlTools(delivery?: Pick<ChatDeliveryRouter, 'stop' | 'cancel'>) {
  const router = (context: OperatorRequestContext) => {
    const owner = context.services.operatorChat
    const resolved = delivery ?? (owner ? operatorDeliveryBridge(owner)?.router : undefined)
    if (!resolved) throw new DomainError('CHAT_DELIVERY_UNAVAILABLE', 'Operator queue controls are unavailable.', 503)
    return resolved
  }
  const enabled = (services: OperatorRequestContext['services']) => !!delivery
    || !!services.operatorChat && !!operatorDeliveryBridge(services.operatorChat)
  return [
  defineOperatorTool({
    name: 'operator_chat_cancel',
    requires: [['operator_chat:cancel', 'global'], ['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat || !!delivery,
    description: 'Stop only the exact active reply in your Operator conversation; queued work is preserved. Legacy requestId comes from readback; reuse commandId after response loss (omission uses a deterministic receipt for that request). Or pass canonical request {target, commandId, scope: active_turn, expectedNativeTurnId?}. Reuse the identical command, never the next active reply. Cancellation acknowledgement is not native terminal evidence. Requires operator_chat:cancel and operator_chat:read.',
    inputSchema: z.object({ conversationId: z.string().min(1), request: z.union([CancelOperatorTurnRequestSchema,
      ChatStopRequestSchema.extend({ scope: ChatStopRequestSchema.shape.scope.extract(['active_turn']) })]) }).strict(),
    outputSchema: controlOutput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: async (context, { conversationId, request }) => {
      if ('target' in request) {
        assertConversation(conversationId, request.target)
        return router(context).stop(context.principal, request)
      }
      return { state: await context.services.operatorChat!.cancel(conversationId, request.requestId, context.principal, request.commandId, 'mcp') }
    },
  }),
  defineOperatorTool({
    name: 'operator_chat_cancel_queued', requires: [['operator_chat:cancel', 'global'], ['operator_chat:read', 'global']], enabled,
    description: 'Cancel one still-queued Operator input by exact receiptId. Pass conversationId and canonical request {target, commandId, selection: {kind: one, receiptId}}. Never stops an active reply. Reuse the same command after response loss; a submitted input cannot be queue-canceled.',
    inputSchema: z.object({ conversationId: z.string().min(1), request: ChatQueueCancelRequestSchema.extend({
      selection: ChatQueueCancelRequestSchema.shape.selection.options[0] }) }).strict(),
    outputSchema: ChatControlReceiptSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId, request }) => {
      assertConversation(conversationId, request.target)
      return router(context).cancel(context.principal, request)
    },
  }),
  defineOperatorTool({
    name: 'operator_chat_cancel_all_queued', requires: [['operator_chat:cancel', 'global'], ['operator_chat:read', 'global']], enabled,
    description: 'Cancel only currently queued inputs in the selected Operator conversation. Pass conversationId and canonical request {target, commandId, selection: {kind: all}}. Preserve the active reply. Reuse the exact command to reconcile a lost response.',
    inputSchema: z.object({ conversationId: z.string().min(1), request: ChatQueueCancelRequestSchema.extend({
      selection: ChatQueueCancelRequestSchema.shape.selection.options[1] }) }).strict(),
    outputSchema: ChatControlReceiptSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (context, { conversationId, request }) => {
      assertConversation(conversationId, request.target)
      return router(context).cancel(context.principal, request)
    },
  }),
  defineOperatorTool({
    name: 'operator_chat_respond',
    requires: [['operator_chat:respond', 'global'], ['operator_chat:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Answer the pending native request in your Operator conversation using offered nativeRequestId and '
      + 'optionId plus active model requestId from operator_chat_get. For a standalone session request with no active '
      + 'model request, use nativeRequestId as requestId. For questions and forms, supply response matching '
      + 'the option input schema. Check responseAvailability.available and its message first. Reuse commandId and '
      + 'identical input after response loss. An uncertain response is never resent. '
      + 'Read operator_chat_get activitySnapshot for the saved decision and providerAcknowledged: '
      + 'a recorded answer alone is not delivery confirmation; native consumption may confirm it later. '
      + 'Requires operator_chat:respond and operator_chat:read.',
    inputSchema: z.object({ conversationId: z.string().min(1), request: RespondOperatorInteractionRequestSchema }).strict(),
    outputSchema: CancelOperatorTurnResponseSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, { conversationId, request }) => ({
    state: await context.services.operatorChat!.respond(conversationId, request, context.principal, 'mcp'),
  }),
  }),
  ]
}

export const operatorControlTools = createOperatorControlTools()

const deliveryPresentation = z.object({ state: EngineChatReadbackSchema.shape.state, capabilities: EngineChatReadbackSchema.shape.capabilities }).extend({ nativeTurnId: z.string().optional() })
const exactReadOutput = z.union([
  z.object({ target: DeliveryTargetSchema, state: GetOperatorConversationResponseSchema,
    receipts: z.array(ChatDeliveryReceiptSchema), delivery: deliveryPresentation }).strict(),
  z.object({ target: DeliveryTargetSchema, receipts: z.array(ChatDeliveryReceiptSchema).optional(),
    deliveryInputs: ReadAgentChatResponseSchema.shape.deliveryInputs.unwrap() }).strict(),
  z.object({ target: DeliveryTargetSchema, receipts: z.array(ChatDeliveryReceiptSchema), controls: z.array(ChatControlReceiptSchema).optional() }).strict(),
])
const readOutput = z.object({ ...GetOperatorConversationResponseSchema.partial().shape,
  revision: GetOperatorConversationResponseSchema.shape.revision.removeDefault().optional(),
  activeRequestId: GetOperatorConversationResponseSchema.shape.activeRequestId.removeDefault().optional(),
  target: DeliveryTargetSchema.optional(), state: GetOperatorConversationResponseSchema.optional(),
  receipts: z.array(ChatDeliveryReceiptSchema).optional(), controls: z.array(ChatControlReceiptSchema).optional(),
  delivery: deliveryPresentation.optional(), deliveryInputs: ReadAgentChatResponseSchema.shape.deliveryInputs,
}).strict().superRefine((value, context) => {
  const parsed = z.union([GetOperatorConversationResponseSchema, exactReadOutput]).safeParse(value)
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
})
const sendOutput = z.object({ ...z.object(ChatDeliveryReceiptSchema.shape).partial().shape,
  state: z.union([GetOperatorConversationResponseSchema, ChatDeliveryReceiptSchema.shape.state]).optional(),
  replayed: z.boolean().optional(), receipt: ChatDeliveryReceiptSchema.optional(),
}).strict().superRefine((value, context) => {
  const parsed = z.union([SendOperatorMessageResponseSchema, ChatDeliveryReceiptSchema]).safeParse(value)
  if (!parsed.success) for (const issue of parsed.error.issues) context.addIssue({ code: 'custom', path: issue.path, message: issue.message })
})

/** D replaces only its two existing get/send definitions with these adapters after C0 extraction; history/lifecycle stay intact. */
export function createOperatorDeliveryTools(delivery?: Pick<ChatDeliveryRouter, 'read' | 'send'>) {
  const router = (context: OperatorRequestContext) => {
    const service = context.services.operatorChat
    const value = delivery ?? (service ? operatorDeliveryBridge(service)?.router : undefined)
    if (!value) throw new DomainError('CHAT_DELIVERY_UNAVAILABLE', 'Operator delivery readback is unavailable.', 503)
    return value
  }
  return [
    defineOperatorTool({ name: 'operator_chat_get', requires: [['operator_chat:read', 'global']],
      enabled: services => !!services.operatorChat || !!delivery,
      description: 'Read the owned Operator conversation. Omit all new fields to retain the existing snapshot envelope and history controls. Supply target {kind: operator_conversation, conversationId} for canonical delivery capabilities and receipts. commandId/receiptId reads one persisted command without dispatch. deliveryInputs {cursor?, limit?, receiptId?, bodyCursor?} reads exact immutable input/file pins for prepared input that never reached native user history. Targets and bodies remain owner-authorized.',
      inputSchema: z.object({ conversationId: z.string().min(1), target: DeliveryTargetSchema.optional(),
        cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional(),
        commandId: z.string().min(1).optional(), receiptId: z.string().min(1).optional(),
        deliveryInputs: ReadAgentChatRequestSchema.shape.deliveryInputs }).strict(), outputSchema: readOutput,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: (context, { conversationId, target, ...input }) => {
        if (!target && Object.values(input).every(value => value === undefined)) return context.services.operatorChat!.get(conversationId, context.principal)
        const selected = target ?? { kind: 'operator_conversation' as const, conversationId }
        assertConversation(conversationId, selected)
        return router(context).read(context.principal, { ...input, target: selected })
      },
    }),
    defineOperatorTool({ name: 'operator_chat_send', requires: [['operator_chat:write', 'global'], ['operator_chat:read', 'global']],
      enabled: services => !!services.operatorChat || !!delivery,
      description: 'Send exact Operator input. Legacy request/requestId preserves omitted-intent behavior and accepted settings/configuration pins; explicit intent uses common auto/steer/next_turn/interrupt_and_send admission. Or use canonical request {target, commandId, intent, content, attachments?, sessionMode?, expectedNativeTurnId?}; it uses the selected conversation’s accepted settings. Auto never interrupts, and menu selection is not sending. Reuse the exact command after response loss. Bare session controls remain operator_chat_controls_update.',
      inputSchema: z.object({ conversationId: z.string().min(1), request: z.union([SendOperatorMessageRequestSchema, ChatSendRequestSchema]) }).strict(),
      outputSchema: sendOutput,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: (context, { conversationId, request }) => {
        if ('target' in request) {
          assertConversation(conversationId, request.target)
          return router(context).send(context.principal, request)
        }
        return context.services.operatorChat!.send(conversationId, request, context.principal)
      },
    }),
  ]
}
