import { WorkflowHierarchyReadResultSchema, WorkflowReportsPageSchema,
  type WorkflowHierarchyReadInput, type WorkflowReportsReadInput } from '@foreman-code/contracts'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'

export function hierarchyPath(scope: { workspaceId: string; workflowId: string }): string {
  return `/api/management/workspaces/${encodeURIComponent(scope.workspaceId)}/workflows/${encodeURIComponent(scope.workflowId)}/hierarchy`
}
export async function readHierarchy(input: WorkflowHierarchyReadInput, options?: RequestOptions) {
  const query = new URLSearchParams()
  if (input.runId) query.set('runId', input.runId)
  if (input.workflowVersionId) query.set('workflowVersionId', input.workflowVersionId)
  const result = await apiClient.request(`${hierarchyPath(input)}?${query}`, WorkflowHierarchyReadResultSchema, options)
  if (result.workspaceId !== input.workspaceId || result.workflowId !== input.workflowId
    || input.runId && result.run?.runId !== input.runId
    || input.workflowVersionId && result.workflowVersionId !== input.workflowVersionId) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The hierarchy belongs to another saved selection.' })
  }
  return result
}
export async function readHierarchyReports(input: WorkflowReportsReadInput, options?: RequestOptions) {
  const query = new URLSearchParams({ runId: input.runId, limit: String(input.limit) })
  if (input.parentNodeId) query.set('parentNodeId', input.parentNodeId)
  if (input.workflowNodeId) query.set('workflowNodeId', input.workflowNodeId)
  if (input.cursor) query.set('cursor', input.cursor)
  const result = await apiClient.request(`${hierarchyPath(input)}/reports?${query}`, WorkflowReportsPageSchema, options)
  if (result.workspaceId !== input.workspaceId || result.workflowId !== input.workflowId || result.runId !== input.runId
    || result.items.some(item => item.execution.runId !== input.runId || item.execution.workflowVersionId !== result.workflowVersionId
      || item.agent.workspaceId !== input.workspaceId || item.agent.workflowId !== input.workflowId
      || input.parentNodeId && item.parentNodeId !== input.parentNodeId
      || input.workflowNodeId && item.agent.workflowNodeId !== input.workflowNodeId)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The reports belong to another Run or branch.' })
  }
  return result
}
