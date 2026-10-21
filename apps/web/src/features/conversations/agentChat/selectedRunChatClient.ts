import {
  ReadSelectedRunChatResponseSchema, SelectedRunChatSelectionSchema,
  SendSelectedRunChatRequestSchema, type SelectedRunChatSelection, type SelectedRunChatExecution,
} from '@foreman-code/contracts/selected-run-chat'
import { AgentChatSendResponseSchema, ReadAgentChatResponseSchema,
  type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { apiClient, ApiError, type RequestOptions } from '../../../shared/api/client'
import { agentChatRoot } from '../../../shared/api/agentChat'
import { sameSelectedTarget } from './selectedRunChatModel'

export const selectedRunChatPath = (selection: SelectedRunChatSelection) =>
  `${agentChatRoot(selection.workspaceId)}/workflows/${encodeURIComponent(selection.workflowId)}`
  + `/runs/${encodeURIComponent(selection.runId)}/nodes/${encodeURIComponent(selection.workflowNodeId)}`

function invalid(): never {
  throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Chat identity changed.' }, 409)
}

export const selectedRunChatApi = {
  async state(selection: SelectedRunChatExecution, options?: RequestOptions) {
    const result = await selectedRunChatApi.read(selection, options)
    if (result.kind !== 'selected') throw new ApiError({ code: 'AGENT_CHAT_UNAVAILABLE',
      message: 'The selected execution is unavailable for follow-up.' }, 409)
    return ReadAgentChatResponseSchema.parse(result.state)
  },
  send(selection: SelectedRunChatExecution, input: SendAgentChatMessageRequest, options?: RequestOptions) {
    const { context, ...message } = input
    if (context.workflowId !== selection.workflowId || context.runId !== selection.runId
      || context.workflowNodeId !== selection.workflowNodeId) invalid()
    const parsed = SendSelectedRunChatRequestSchema.parse({ selection, message })
    return apiClient.request(`${selectedRunChatPath(selection)}/messages`, AgentChatSendResponseSchema,
      { ...options, method: 'POST', body: { ...parsed.message, executionId: selection.executionId } })
  },
  async read(input: SelectedRunChatSelection, options?: RequestOptions) {
    const selection = SelectedRunChatSelectionSchema.parse(input)
    const query = selection.executionId ? `?${new URLSearchParams({ executionId: selection.executionId })}` : ''
    const result = await apiClient.request(`${selectedRunChatPath(selection)}${query}`, ReadSelectedRunChatResponseSchema, options)
    const actual = result.kind === 'selected' ? result.selection : result.target
    // Non-selected envelopes have no execution field. They still must match the exact Run/node.
    if (!sameSelectedTarget({ ...selection, executionId: result.kind === 'selected' ? selection.executionId : undefined }, actual)) invalid()
    return result
  },
}
