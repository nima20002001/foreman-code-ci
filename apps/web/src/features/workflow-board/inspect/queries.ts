import { useInfiniteQuery, useQuery, type QueryClient, type QueryKey } from '@tanstack/react-query'
import type { RepeatGraphScopeV3, RunExecutionDetail } from '@foreman-code/contracts/wave25'
import { sessionGeneration } from '../../../shared/api/sessionBoundary'
import { readRunExecution, readRunExecutionBindings, readRunExecutions, readRunInspectionVersion, type ExecutionFilters } from '../runDetailsClient'

/** Separate from current-state and Stop invalidations: historical page count must
 * never determine the work done by an automatic refresh. */
export const runInspectionQueryKey = (scope: RepeatGraphScopeV3) =>
  ['workbench', 'run-inspection', sessionGeneration(), scope.workspaceId, scope.workflowId, scope.runId, scope.workflowVersionId, 3] as const

const explicitHistory = {
  meta: { refetchOnApiReconnect: false },
  retry: false, staleTime: Infinity, gcTime: 60_000, refetchOnWindowFocus: false,
  refetchOnReconnect: false, refetchOnMount: false, maxPages: 5,
} as const
export function useRunVersionQuery(scope: RepeatGraphScopeV3, enabled = true) {
  return useQuery({ queryKey: [...runInspectionQueryKey(scope), 'version'], enabled,
    queryFn: ({ signal }) => readRunInspectionVersion(scope, { signal }),
    retry: false, staleTime: Infinity, gcTime: 60_000, refetchOnMount: 'always', refetchOnWindowFocus: false, refetchOnReconnect: false })
}
export function executionPagesKey(scope: RepeatGraphScopeV3, filters: ExecutionFilters) {
  return [...runInspectionQueryKey(scope), 'executions', filters.workflowNodeId ?? null, filters.occurrenceId ?? null] as const
}
export function useExecutionPages(scope: RepeatGraphScopeV3, filters: ExecutionFilters, enabled: boolean) {
  return useInfiniteQuery({ ...explicitHistory, queryKey: executionPagesKey(scope, filters), enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => readRunExecutions(scope, filters, pageParam, { signal }),
    getNextPageParam: (page, _pages, _param, params) =>
      page.pageInfo.nextCursor && !params.includes(page.pageInfo.nextCursor) ? page.pageInfo.nextCursor : undefined,
  })
}
export function useExecutionQuery(scope: RepeatGraphScopeV3, executionId?: string, enabled = true) {
  return useQuery({ queryKey: [...runInspectionQueryKey(scope), 'execution', executionId ?? null],
    enabled: enabled && !!executionId, queryFn: ({ signal }) => readRunExecution(scope, executionId!, { signal }),
    retry: false, staleTime: Infinity, gcTime: 60_000, refetchOnMount: 'always', refetchOnReconnect: false, refetchOnWindowFocus: false })
}
export function bindingsPagesKey(scope: RepeatGraphScopeV3, detail: RunExecutionDetail) {
  return [...runInspectionQueryKey(scope), 'bindings', detail.execution.executionId, detail.acceptedInput.digest] as const
}
export function useBindingPages(scope: RepeatGraphScopeV3, detail: RunExecutionDetail, enabled: boolean) {
  return useInfiniteQuery({ ...explicitHistory, queryKey: bindingsPagesKey(scope, detail), enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => readRunExecutionBindings(scope, detail, pageParam, { signal }),
    getNextPageParam: (page, _pages, _param, params) =>
      page.pageInfo.nextCursor && !params.includes(page.pageInfo.nextCursor) ? page.pageInfo.nextCursor : undefined,
  })
}
/** Cancel an in-flight next page before explicitly refreshing the first page.
 * Even after many "Load more" clicks, refresh does ONE page request. */
export async function refreshFirstInspectionPage(client: QueryClient, key: QueryKey) {
  await client.cancelQueries({ queryKey: key, exact: true })
  await client.resetQueries({ queryKey: key, exact: true })
}
