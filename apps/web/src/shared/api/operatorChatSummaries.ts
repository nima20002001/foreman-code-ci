import { DeleteOperatorConversationResponseSchema, ListOperatorConversationSummariesResponseSchema } from '@foreman-code/contracts'
import { apiClient, type RequestOptions } from './client'

/** Status-only polling; all authentication/cancellation still uses the shared HTTP boundary. */
export function listOperatorConversationSummaries(options?: RequestOptions, limit?: number) {
  return apiClient.request(`/api/operator/conversations/summaries${limit === undefined ? '' : `?limit=${limit}`}`, ListOperatorConversationSummariesResponseSchema, options)
}

export function deleteOperatorConversation(id: string) {
  return apiClient.request(`/api/operator/conversations/${encodeURIComponent(id)}`, DeleteOperatorConversationResponseSchema, { method: 'DELETE' })
}
export function restoreOperatorConversation(id: string) {
  return apiClient.request(`/api/operator/conversations/${encodeURIComponent(id)}/restore`, DeleteOperatorConversationResponseSchema, { method: 'POST' })
}
