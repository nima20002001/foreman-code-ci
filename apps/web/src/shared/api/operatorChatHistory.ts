import {
  OperatorConversationHistoryPageSchema, OperatorConversationHistoryQuerySchema,
  type OperatorConversationHistoryQuery,
} from '@foreman-code/contracts/operator-chat'
import { apiClient, type RequestOptions } from './client'

/** Read-only, owner-scoped receipts. Never turn recovered history into a new POST. */
export function getOperatorConversationHistory(
  conversationId: string, query: Partial<OperatorConversationHistoryQuery> = {}, options?: RequestOptions,
) {
  const input = OperatorConversationHistoryQuerySchema.parse(query)
  const params = new URLSearchParams({ limit: String(input.limit) })
  if (input.before) params.set('before', input.before)
  return apiClient.request(`/api/operator/conversations/${encodeURIComponent(conversationId)}/history?${params}`,
    OperatorConversationHistoryPageSchema, options)
}
