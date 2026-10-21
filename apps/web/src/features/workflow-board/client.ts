import { RunEventsPageSchema } from '@foreman-code/contracts/management'
import { CurrentRunDetailsSchema, CurrentRunPageSchema, RepeatGraphScopeV3Schema, type RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'

export async function readBoardRun(workspaceId: string, workflowId: string, runId: string, options?: RequestOptions) {
  const result = await apiClient.request(
    `/api/management/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}`,
    CurrentRunDetailsSchema, options)
  if (result.run.workspaceId !== workspaceId || result.run.workflowId !== workflowId || result.run.id !== runId) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The Run belongs to a different workflow.' })
  }
  return result
}
export function scopeForBoardRun(run: Awaited<ReturnType<typeof readBoardRun>>['run']): RepeatGraphScopeV3 {
  return RepeatGraphScopeV3Schema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
    runId: run.id, workflowVersionId: run.workflowVersionId,
    executionSemanticsVersion: run.executionSemanticsVersion })
}

/** Deliberate detail read, never part of the current-state polling loop. */
export async function readBoardHistory(scope: RepeatGraphScopeV3, cursor: string | null, options?: RequestOptions) {
  const query = new URLSearchParams({ limit: '50' })
  if (cursor !== null) query.set('cursor', cursor)
  const result = await apiClient.request(
    `/api/management/workspaces/${encodeURIComponent(scope.workspaceId)}/runs/${encodeURIComponent(scope.runId)}/events?${query}`,
    RunEventsPageSchema, options)
  if (result.items.some((item) => item.runId !== scope.runId)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'History contains a different Run identity.' })
  }
  return result
}

/** Saved V3 only, including past Runs. The version number never selects an engine. */
export async function readBoardRuns(workspaceId: string, workflowId: string, cursor: string | null = null, options?: RequestOptions) {
  const query = new URLSearchParams({ workflowId, limit: '20' })
  if (cursor !== null) query.set('cursor', cursor)
  const page = await apiClient.request(
    `/api/management/workspaces/${encodeURIComponent(workspaceId)}/runs?${query}`, CurrentRunPageSchema, options)
  if (page.items.some((run) => run.workspaceId !== workspaceId || run.workflowId !== workflowId)) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The Run list contains a different workflow scope.' })
  }
  return page
}
