import {
  ReadSelectedRunChatResponseSchema, SelectedRunChatSelectionSchema,
  type SelectedRunChatSelection,
} from '@foreman-code/contracts/selected-run-chat'
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
