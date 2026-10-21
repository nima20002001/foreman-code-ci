import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { RepeatGraphScopeV3Schema, type RepeatGraphCurrentV3, type RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { ApiError } from '../../shared/api/client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { assertRepeatCurrentProgress, repeatGraphClient, type RepeatGraphClient } from '../repeats/canonicalClient'

export const currentRunKey = (scope: RepeatGraphScopeV3, generation = sessionGeneration()) =>
  ['workbench', 'current-v3-run', generation, scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId, 3] as const

/** The same complete canonical V3 read supplies ordinary and configured-repeat facts.
 * Cached data is not current evidence after a failed, denied or regressed refresh. */
export function useCurrentRunQuery(scope?: RepeatGraphScopeV3, live = true, client: RepeatGraphClient = repeatGraphClient) {
  const cache = useQueryClient(), generation = sessionGeneration()
  const key = scope ? currentRunKey(scope, generation) : ['workbench', 'no-current-run', generation]
  return useQuery({ queryKey: key, enabled: !!scope,
    queryFn: async ({ signal }) => {
      const value = await client.current(RepeatGraphScopeV3Schema.parse(scope), { signal })
      assertSession(generation)
      assertRepeatCurrentProgress(cache.getQueryData<RepeatGraphCurrentV3>(key), value)
      return value
    }, retry: false, staleTime: 1000, refetchOnReconnect: 'always', refetchOnWindowFocus: live,
    // Reopening a workflow after a while shows Loading, not node states from the last visit.
    gcTime: 10_000,
    refetchInterval: (state) => {
      const error = state.state.error
      // Stop only on authority/not-found; a transient failure keeps polling.
      if (ApiError.is(error) && [401, 403, 404].includes(error.status)) return false
      const run = state.state.data?.state.run
      return live && (!run || run.executionState !== 'completed' || run.cleanupPending
        || run.pendingInteractionCount > 0 || run.unsettledReviewCount > 0) ? 1500 : false
    },
  })
}
export function clearCurrentRunAccess(client: QueryClient) {
  client.removeQueries({ queryKey: ['workbench', 'current-v3-run'] })
  client.removeQueries({ queryKey: ['workbench', 'pinned-v3-run-details'] })
  client.removeQueries({ queryKey: ['workbench', 'run-inspection'] })
  client.removeQueries({ queryKey: ['workbench', 'board-history'] })
  client.removeQueries({ queryKey: ['workbench', 'run-handoffs'] })
  client.removeQueries({ queryKey: ['workbench', 'board-run-discovery'] })
}
export function revokeCurrentRunWorkspace(client: QueryClient, workspaceId: string) {
  client.removeQueries({ predicate: (query) => ['current-v3-run', 'pinned-v3-run-details', 'run-inspection', 'board-run-discovery', 'board-history', 'run-handoffs'].includes(String(query.queryKey[1]))
    && query.queryKey[3] === workspaceId })
}
