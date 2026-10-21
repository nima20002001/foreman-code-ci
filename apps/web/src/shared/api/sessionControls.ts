import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { agentChatRoot } from './agentChat'
import { SessionControlRequestSchema, SessionControlStateSchema, type SessionControlRequest } from '@foreman-code/contracts'
import { apiClient, type RequestOptions } from './client'
import { agentChatConversationPath } from './agentChat'

function path(conversationId: string, workspaceId?: string) {
  const root = workspaceId ? agentChatConversationPath(workspaceId, conversationId)
    : `/api/operator/conversations/${encodeURIComponent(conversationId)}`
  return `${root}/session-controls`
}
export const sessionControlsApi = {
  readContext(context: AgentChatContext, executionId?: string, options?: RequestOptions) {
    const { workspaceId, ...query } = context
    const parameters = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) if (value !== undefined) parameters.set(key, value)
    if (executionId) parameters.set('executionId', executionId)
    return apiClient.request(`${agentChatRoot(workspaceId)}/session-controls?${parameters}`, SessionControlStateSchema, options)
  },
  changeContext(context: AgentChatContext, request: SessionControlRequest, executionId?: string) {
    const { workspaceId, ...query } = context
    return apiClient.request(`${agentChatRoot(workspaceId)}/session-controls`, SessionControlStateSchema,
      { method: 'POST', body: { context: query, request: SessionControlRequestSchema.parse(request),
        ...(executionId ? { executionId } : {}) } })
  },
  read(conversationId: string, workspaceId?: string, options?: RequestOptions) {
    return apiClient.request(path(conversationId, workspaceId), SessionControlStateSchema, options)
  },
  change(conversationId: string, request: SessionControlRequest, workspaceId?: string) {
    return apiClient.request(path(conversationId, workspaceId), SessionControlStateSchema,
      { method: 'POST', body: SessionControlRequestSchema.parse(request) })
  },
}
