import { useQueryClient } from '@tanstack/react-query'
import type { CurrentWorkspaceDetails } from '@foreman-code/contracts/wave25'
import { apiClient } from '../../shared/api/client'
import { queryKeys } from '../../shared/api/query'
import { nextDraftApi } from '../graph/nextDraft/transport'
import { runSummariesQuery, runsSelectorApi } from '../runs-selector'
import { boardDraftContextKey, boardLiveRunSnapshotKey } from './keys'
import { isActiveRun } from './runFacts'

/** Hover/focus prefetch of what a Board shows first, in parallel and under the keys the
 * Board reads, so opening a workflow shows its draft and active Run without a waterfall.
 * Workspace details are not re-read: the sidebar only lists workflows of the open workspace. */
export function usePrefetchWorkflowBoard() {
  const client = useQueryClient()
  return (workspaceId: string, workflowId: string) => {
    void client.prefetchQuery({ queryKey: queryKeys.managedWorkflow(workspaceId, workflowId), staleTime: 10_000,
      queryFn: ({ signal }) => apiClient.getManagedWorkflow(workspaceId, workflowId, { signal }) })
    void client.prefetchQuery({ queryKey: boardDraftContextKey(workspaceId, workflowId), staleTime: 3000,
      queryFn: ({ signal }) => nextDraftApi.context(workspaceId, workflowId, { signal }) })
    void client.prefetchInfiniteQuery(runSummariesQuery({ workspaceId, workflowId }))
    const runs = client.getQueryData<CurrentWorkspaceDetails>(queryKeys.workspaceDetails(workspaceId))?.runs ?? []
    for (const run of runs) if (run.workflowId === workflowId && isActiveRun(run)) {
      void client.prefetchQuery({ queryKey: boardLiveRunSnapshotKey(workspaceId, workflowId, run.id), staleTime: Infinity,
        queryFn: ({ signal }) => runsSelectorApi.snapshot({ workspaceId, workflowId, runId: run.id }, { signal }) })
    }
  }
}
