import { useQuery } from '@tanstack/react-query'
import { RepeatGraphScopeV3Schema, RunHandoffsReadSchema,
  type RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { ApiError, apiClient, type RequestOptions } from '../../shared/api/client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'

export const runHandoffsKey = (scope: RepeatGraphScopeV3, generation = sessionGeneration()) =>
  ['workbench', 'run-handoffs', generation, scope.workspaceId, scope.workflowId,
    scope.runId, scope.workflowVersionId, 3] as const

export async function readRunHandoffs(scope: RepeatGraphScopeV3, options?: RequestOptions) {
  RepeatGraphScopeV3Schema.parse(scope)
  const generation = sessionGeneration()
  const result = await apiClient.request(`/api/management/workspaces/${encodeURIComponent(scope.workspaceId)}`
    + `/runs/${encodeURIComponent(scope.runId)}/handoffs`, RunHandoffsReadSchema, options)
  if (result.scope.workspaceId !== scope.workspaceId || result.scope.workflowId !== scope.workflowId
    || result.scope.runId !== scope.runId || result.scope.workflowVersionId !== scope.workflowVersionId) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Handoff usage belongs to a different Run or saved version.' })
  }
  assertSession(generation)
  return result
}

export function useRunHandoffsQuery(scope: RepeatGraphScopeV3, enabled: boolean) {
  return useQuery({ queryKey: runHandoffsKey(scope), enabled,
    queryFn: ({ signal }) => readRunHandoffs(scope, { signal }), retry: false,
    staleTime: 1000, gcTime: 60_000, refetchOnWindowFocus: enabled,
    refetchInterval: (state) => {
      const error = state.state.error
      if (ApiError.is(error) && [401, 403, 404].includes(error.status)) return false
      return enabled && state.state.data?.runState !== 'completed' ? 2500 : false
    } })
}
