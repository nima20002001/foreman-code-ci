import { RunPlacementGetInputSchema, RunPlacementGetResultSchema, NodePlacementChoicesInputSchema, NodePlacementChoicesResultSchema, type NodePlacementChoicesInput } from '@foreman-code/contracts/placement-readback'
import type { z } from 'zod'
import { ApiError, apiClient, type RequestOptions } from '../../shared/api/client'

export type RunPlacementScope = z.infer<typeof RunPlacementGetInputSchema>
export async function readNodePlacement(raw: RunPlacementScope, options?: RequestOptions) {
  const input = RunPlacementGetInputSchema.parse(raw)
  const part = encodeURIComponent
  const response = await apiClient.request(`/api/management/workspaces/${part(input.workspaceId)}/workflows/${part(input.workflowId)}/runs/${part(input.runId)}/nodes/${part(input.nodeId)}/placement`, RunPlacementGetResultSchema, options)
  if (response.workspaceId !== input.workspaceId || response.workflowId !== input.workflowId || response.runId !== input.runId || response.nodeId !== input.nodeId
    || (response.readback.evidence === 'accepted' && (response.readback.placement.runId !== input.runId || response.readback.placement.nodeId !== input.nodeId))) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Computer evidence belongs to a different Run node.' })
  }
  return response
}

export async function readPlacementChoices(raw: NodePlacementChoicesInput, options?: RequestOptions) {
  const input = NodePlacementChoicesInputSchema.parse(raw)
  const part = encodeURIComponent
  const query = new URLSearchParams({ agentConfigurationVersionId: input.agentConfigurationVersionId })
  const response = await apiClient.request(`/api/management/workspaces/${part(input.workspaceId)}/workflows/${part(input.workflowId)}/nodes/${part(input.nodeId)}/placement-choices?${query}`, NodePlacementChoicesResultSchema, options)
  if (response.workspaceId !== input.workspaceId || response.workflowId !== input.workflowId || response.nodeId !== input.nodeId
    || response.agentConfigurationVersionId !== input.agentConfigurationVersionId) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Computer choices belong to a different saved node configuration.' })
  }
  return response
}
