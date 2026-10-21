import { useEffect, useMemo } from 'react'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import type { WorkflowHierarchyReadInput, WorkflowReportsPage } from '@foreman-code/contracts'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { readHierarchy, readHierarchyReports } from './client'
import { isTransientReadError } from '../../shared/api/readFailure'

export const hierarchyKey = (scope: WorkflowHierarchyReadInput, generation = sessionGeneration()) =>
  ['workflow-hierarchy', generation, scope.workspaceId, scope.workflowId, scope.runId ?? null, scope.workflowVersionId ?? null] as const
export const hierarchyReportKey = (scope: WorkflowHierarchyReadInput) => [...hierarchyKey(scope), 'reports', 'children'] as const
/** Lifecycle notifications refresh one bounded page per visible branch, never its loaded history. */
export function refreshHierarchyReports(cache: QueryClient, scope: WorkflowHierarchyReadInput) {
  const queryKey = hierarchyReportKey(scope)
  cache.setQueriesData<InfiniteData<WorkflowReportsPage>>({ queryKey }, current => current && ({
    pages: current.pages.slice(0, 1), pageParams: current.pageParams.slice(0, 1),
  }))
  return cache.invalidateQueries({ queryKey })
}

type ReportHistory = InfiniteData<WorkflowReportsPage, string | undefined>
const historyPageLimit = 20

function nextHistoryCursor(pages: WorkflowReportsPage[], params: (string | undefined)[]) {
  let page = pages.at(-1)
  const visited = new Set<string>()
  while (page?.nextCursor && !visited.has(page.nextCursor)) {
    const cursor = page.nextCursor
    visited.add(cursor)
    const index = params.indexOf(cursor)
    if (index === -1) return cursor
    page = pages[index]
  }
  return undefined
}

function refreshHistoryHead(current: ReportHistory | undefined, latest: WorkflowReportsPage): ReportHistory {
  if (!current?.pages.length) return { pages: [latest], pageParams: [undefined] }
  const headIndex = current.pageParams.lastIndexOf(undefined)
  const head = current.pages[headIndex]
  const sameWindow = head && head.nextCursor === latest.nextCursor && head.items.length === latest.items.length
    && head.items.every((report, index) => report.id === latest.items[index]?.id)
  if (sameWindow) return { ...current, pages: current.pages.map((page, index) => index === headIndex ? latest : page) }
  // New reads go at the end so eviction removes older windows, while pagination
  // continues from the last fetched page or its already cached continuation.
  return { pages: [...current.pages, latest].slice(-historyPageLimit),
    pageParams: [...current.pageParams, undefined].slice(-historyPageLimit) }
}

/** Reopening reads one newest page; older cursor windows stay in Query's cache. */
export function useHierarchyReportHistory(scope: WorkflowHierarchyReadInput, workflowNodeId: string, { enabled = true } = {}) {
  const cache = useQueryClient()
  const generation = sessionGeneration()
  const { workspaceId, workflowId, runId, workflowVersionId } = scope
  const queryKey = useMemo(() => [...hierarchyKey({ workspaceId, workflowId, runId, workflowVersionId }, generation),
    'report-history', workflowNodeId], [workspaceId, workflowId, runId, workflowVersionId, workflowNodeId, generation])
  const query = useInfiniteQuery({ queryKey, enabled: enabled && !!runId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => readHierarchyReports({ workspaceId,
      workflowId, runId: runId!, workflowNodeId, limit: 20,
      ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    getNextPageParam: (_page, pages, _param, params) => nextHistoryCursor(pages, params),
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
    refetchOnMount: false, maxPages: historyPageLimit,
  })
  const refresh = useMutation({
    mutationKey: [...queryKey, 'refresh'], retry: false,
    mutationFn: () => readHierarchyReports({ workspaceId, workflowId, runId: runId!, workflowNodeId, limit: 20 }),
    onSuccess: latest => cache.setQueryData<ReportHistory>(queryKey, current => refreshHistoryHead(current, latest)),
  })
  const refreshLatest = refresh.mutate
  useEffect(() => {
    if (enabled && runId && cache.getQueryData(queryKey)) refreshLatest()
  }, [cache, enabled, runId, queryKey, refreshLatest])
  return { ...query, refresh }
}
export function useHierarchy(scope: WorkflowHierarchyReadInput, { enabled = true } = {}) {
  const current = !scope.runId && !scope.workflowVersionId
  return useQuery({ queryKey: hierarchyKey(scope), enabled, queryFn: ({ signal }) => readHierarchy(scope, { signal }),
    retry: false, staleTime: current ? 30_000 : Infinity, refetchOnMount: 'always', refetchOnWindowFocus: current,
    refetchInterval: query => {
      if (!enabled || !current || query.state.error && !isTransientReadError(query.state.error)) return false
      return 30_000
    }, refetchIntervalInBackground: false })
}
export function useHierarchyReports(scope: WorkflowHierarchyReadInput, parentNodeId: string, enabled: boolean) {
  return useInfiniteQuery({ queryKey: [...hierarchyReportKey(scope), parentNodeId], enabled: enabled && !!scope.runId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => readHierarchyReports({ workspaceId: scope.workspaceId,
      workflowId: scope.workflowId, runId: scope.runId!, parentNodeId, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined, retry: false, staleTime: Infinity,
    refetchOnWindowFocus: false, refetchOnMount: 'always', maxPages: 20,
  })
}
