import { z } from 'zod'
import {
  ChatDeliveryReceiptSchema, WorkflowChatPostSchema, WorkflowChatPostRequestSchema,
  WorkflowChatPostResponseSchema, type WorkflowChatPostRequest,
} from '@foreman-code/contracts'
import { apiClient, type RequestOptions } from '../../shared/api/client'

// Transport envelopes compose C0 leaves; no feature-local post, target or receipt model.
const page = <T extends z.ZodTypeAny>(item: T) => z.object({ items: z.array(item),
  nextCursor: z.string().nullable(), hasMore: z.boolean(), revision: z.number().int().nonnegative() })
export const workflowChatPageSchema = page(WorkflowChatPostSchema).extend({
  bodyTruncations: z.array(z.object({ postId: z.string(), nextBodyCursor: z.string(), originalBytes: z.number() })).optional(),
})
const workflowChatBodySchema = z.object({ postId: z.string(), body: z.string(),
  nextBodyCursor: z.string().nullable(), revision: z.number().int().nonnegative() })
export const workflowDeliveryPageSchema = page(ChatDeliveryReceiptSchema)
export const workflowChatEventSchema = z.object({ revision: z.number().int().nonnegative(),
  post: WorkflowChatPostSchema.optional(), receipt: ChatDeliveryReceiptSchema.optional(),
  snapshotRequired: z.boolean().optional() })
export type WorkflowChatPage = z.infer<typeof workflowChatPageSchema>
export type WorkflowDeliveryPage = z.infer<typeof workflowDeliveryPageSchema>
export type WorkflowChatEvent = z.infer<typeof workflowChatEventSchema>
export type WorkflowChatScope = Pick<WorkflowChatPostRequest, 'workspaceId' | 'workflowId'>
export type WorkflowChatRead = { cursor?: string; limit?: number; runId?: string; postId?: string; commandId?: string }

export const workflowChatRoot = ({ workspaceId, workflowId }: WorkflowChatScope) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/chat`
function query(input: Record<string, string | number | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, String(value))
  return params.size ? `?${params}` : ''
}

export const workflowChatClient = {
  read(scope: WorkflowChatScope, selection: WorkflowChatRead = {}, options?: RequestOptions) {
    return apiClient.request(`${workflowChatRoot(scope)}${query(selection)}`, workflowChatPageSchema, options)
  },
  deliveries(scope: WorkflowChatScope, selection: WorkflowChatRead & { receiptId?: string } = {}, options?: RequestOptions) {
    return apiClient.request(`${workflowChatRoot(scope)}/deliveries${query(selection)}`, workflowDeliveryPageSchema, options)
  },
  body(scope: WorkflowChatScope, postId: string, bodyCursor?: string, options?: RequestOptions) {
    return apiClient.request(`${workflowChatRoot(scope)}${query({ mode: 'body', postId, bodyCursor })}`,
      workflowChatBodySchema, options)
  },
  post(request: WorkflowChatPostRequest, options?: RequestOptions) {
    return apiClient.request(`${workflowChatRoot(request)}/posts`, WorkflowChatPostResponseSchema,
      { ...options, method: 'POST', body: WorkflowChatPostRequestSchema.parse(request) })
  },
  cancel(scope: WorkflowChatScope, receiptId: string, commandId: string, options?: RequestOptions) {
    return apiClient.request(`${workflowChatRoot(scope)}/deliveries/${encodeURIComponent(receiptId)}/cancel`,
      ChatDeliveryReceiptSchema, { ...options, method: 'POST', body: { commandId } })
  },
}

export type WorkflowChatClient = typeof workflowChatClient
