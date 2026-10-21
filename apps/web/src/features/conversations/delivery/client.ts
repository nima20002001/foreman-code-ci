import { z } from 'zod'
import {
  ChatSendRequestSchema, ChatStopRequestSchema, ChatQueueCancelRequestSchema, ChatDeliveryReceiptSchema,
  ChatControlReceiptSchema, DeliveryTargetSchema, EngineChatReadbackSchema, OperatorConversationStateSchema,
  type ChatSendRequest, type ChatStopRequest, type ChatQueueCancelRequest, type DeliveryTarget,
} from '@foreman-code/contracts'
import { ReadAgentChatResponseSchema } from '@foreman-code/contracts/agent-chat'
import { apiClient, ApiError, type RequestOptions } from '../../../shared/api/client'
import { sameDeliveryTarget } from '../../workflow-chat/draft'

const deliveryPresentationSchema = z.object({ state: EngineChatReadbackSchema.shape.state, capabilities: EngineChatReadbackSchema.shape.capabilities })
  .extend({ nativeTurnId: z.string().optional() })
const standaloneReadSchema = z.object({ target: DeliveryTargetSchema,
  state: z.union([ReadAgentChatResponseSchema, OperatorConversationStateSchema]),
  receipts: z.array(ChatDeliveryReceiptSchema), delivery: deliveryPresentationSchema })
export const deliveryReadSchema = z.union([EngineChatReadbackSchema, standaloneReadSchema])
const receiptReadSchema = z.object({ target: DeliveryTargetSchema, receipts: z.array(ChatDeliveryReceiptSchema) })
const retainedReadSchema = z.object({ target: DeliveryTargetSchema,
  deliveryInputs: ReadAgentChatResponseSchema.shape.deliveryInputs.unwrap() })
export type RetainedInputPage = z.infer<typeof retainedReadSchema>['deliveryInputs']
export type RetainedInput = RetainedInputPage['items'][number]
export type RetainedInputSelection = { cursor?: string; limit?: number; receiptId?: string; bodyCursor?: string }
export type DeliveryReadback = z.infer<typeof deliveryReadSchema>

export function chatDeliveryRoot(target: DeliveryTarget) {
  return target.kind === 'operator_conversation'
    ? `/api/operator/conversations/${encodeURIComponent(target.conversationId)}/deliveries`
    : `/api/workspaces/${encodeURIComponent(target.agent.workspaceId)}/agent-chat/deliveries`
}
function verify<T extends { target: DeliveryTarget }>(target: DeliveryTarget, response: T): T {
  if (!sameDeliveryTarget(target, response.target)) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Delivery returned a different target.' }, 409)
  return response
}
export const chatDeliveryClient = {
  async read(target: DeliveryTarget, options?: RequestOptions) {
    return verify(target, await apiClient.request(`${chatDeliveryRoot(target)}/read`, deliveryReadSchema,
      { ...options, method: 'POST', body: { target, limit: 50 } }))
  },
  async receipt(target: DeliveryTarget, commandId: string, options?: RequestOptions) {
    return verify(target, await apiClient.request(`${chatDeliveryRoot(target)}/read`, receiptReadSchema,
      { ...options, method: 'POST', body: { target, commandId } }))
  },
  async receiptById(target: DeliveryTarget, receiptId: string, options?: RequestOptions) {
    const result = verify(target, await apiClient.request(`${chatDeliveryRoot(target)}/read`, receiptReadSchema,
      { ...options, method: 'POST', body: { target, receiptId } }))
    if (result.receipts.some(receipt => receipt.id !== receiptId || !sameDeliveryTarget(receipt.target, target))) {
      throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The requested delivery receipt did not match this target.' }, 409)
    }
    return result
  },
  async inputs(target: DeliveryTarget, deliveryInputs: RetainedInputSelection = {}, options?: RequestOptions) {
    const page = verify(target, await apiClient.request(`${chatDeliveryRoot(target)}/read`, retainedReadSchema,
      { ...options, method: 'POST', body: { target, deliveryInputs } })).deliveryInputs
    if (page.items.some(item => !sameDeliveryTarget(item.target, target))) {
      throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Original inputs returned a different target.' }, 409)
    }
    return page
  },
  async page(target: DeliveryTarget, cursor: string, options?: RequestOptions) {
    return verify(target, await apiClient.request(`${chatDeliveryRoot(target)}/read`, EngineChatReadbackSchema,
      { ...options, method: 'POST', body: { target, cursor, limit: 50 } }))
  },
  async send(request: ChatSendRequest, options?: RequestOptions) {
    return verify(request.target, await apiClient.request(`${chatDeliveryRoot(request.target)}/send`, ChatDeliveryReceiptSchema,
      { ...options, method: 'POST', body: ChatSendRequestSchema.parse(request) }))
  },
  async stop(request: ChatStopRequest, options?: RequestOptions) {
    return verify(request.target, await apiClient.request(`${chatDeliveryRoot(request.target)}/stop`, ChatControlReceiptSchema,
      { ...options, method: 'POST', body: ChatStopRequestSchema.parse(request) }))
  },
  async cancel(request: ChatQueueCancelRequest, options?: RequestOptions) {
    return verify(request.target, await apiClient.request(`${chatDeliveryRoot(request.target)}/cancel`, ChatControlReceiptSchema,
      { ...options, method: 'POST', body: ChatQueueCancelRequestSchema.parse(request) }))
  },
}
