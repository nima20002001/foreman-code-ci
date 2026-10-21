import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { ApiError } from '../../shared/api/client'
import { useBlockingReadError } from '../../shared/api/readFailure'
import { runsSelectorApi } from './client'
import { flattenRunPages, nextRunsCursor, RUNS_MAX_PAGES, RUNS_PAGE_SIZE } from './presentation'
import type { RunsSelectorScope } from './types'
import type { SelectedRunState } from './useSelectedRun'

export const runsSelectorKeys = {
  all: ['runs-selector'] as const,
  list: ({ workspaceId, workflowId }: RunsSelectorScope) => ['runs-selector', 'list', workspaceId, workflowId] as const,
  snapshot: (selection: SelectedRunState) => ['runs-selector', 'snapshot', selection.identity.workspaceId,
    selection.identity.workflowId, selection.identity.runId, selection.generation.id] as const,
}

export function isRunAccessError(error: unknown) {
  return ApiError.is(error) && [401, 403, 404].includes(error.status)
}
export function runReadErrorLabel(error: unknown, subject: 'run' | 'list' = 'run') {
  if (ApiError.is(error)) {
    if (error.status === 401) return 'Access unavailable'
    if (error.status === 403) return 'No access'
    if (error.status === 404) return subject === 'run' ? 'Run not found' : 'Not found'
  }
  return 'Load failed'
}
const retry = (count: number, error: unknown) => !isRunAccessError(error) && count < 1

/** Shared by the hook and hover prefetch so both fill the same cache entry. */
export const runSummariesQuery = ({ workspaceId, workflowId }: RunsSelectorScope) => ({
  queryKey: runsSelectorKeys.list({ workspaceId, workflowId }),
  queryFn: ({ pageParam, signal }: { pageParam: string | undefined; signal: AbortSignal }) => runsSelectorApi.list({ workspaceId, workflowId,
    limit: RUNS_PAGE_SIZE, ...(pageParam === undefined ? {} : { cursor: pageParam }) }, { signal }),
  initialPageParam: undefined as string | undefined,
  getNextPageParam: nextRunsCursor,
  // The cap stops forward paging rather than evicting the newest page.
  maxPages: RUNS_MAX_PAGES,
  staleTime: 5_000,
  gcTime: 60_000,
})

export function useRunSummaries(identity: RunsSelectorScope, enabled = true) {
  // Callers may pass a selection that also carries runId; the list is workflow-scoped.
  const query = useInfiniteQuery({
    ...runSummariesQuery(identity),
    enabled,
    retry,
    // The Board also reads this list to notice a Run started elsewhere; the read is a small indexed page.
    refetchInterval: (query) => enabled && !isRunAccessError(query.state.error) ? 5_000 : false,
    placeholderData: () => undefined,
  })
  // A forbidden background refetch must not leave authorized-looking cached rows.
  const items = isRunAccessError(query.error) ? [] : flattenRunPages(query.data?.pages)
  return { ...query, data: isRunAccessError(query.error) ? undefined : query.data, items }
}

/** An authorized single-Run read, independent of whichever summary pages are loaded.
 * `unavailable/legacy_run` confirms the Run exists; it is not a missing Run.
 */
export function useSelectedRunSnapshot(selection: SelectedRunState) {
  const { identity, generation } = selection
  const query = useQuery({
    queryKey: runsSelectorKeys.snapshot(selection),
    queryFn: async ({ signal }) => {
      if (identity.runId === null) throw new Error('Select a Run before reading its snapshot.')
      const result = await runsSelectorApi.snapshot({ ...identity, runId: identity.runId }, { signal })
      if (!selection.isCurrent(generation)) throw new DOMException('Run selection changed.', 'AbortError')
      return result
    },
    enabled: selection.active && !selection.invalid && identity.runId !== null,
    retry: (count, error) => !(error instanceof Error && error.name === 'AbortError') && retry(count, error),
    // An Agent can request CI after the immutable Board capture was first read.
    refetchInterval: query => isRunAccessError(query.state.error) ? false : 3000,
    staleTime: 0,
    gcTime: 0,
    placeholderData: () => undefined,
  })
  const current = selection.isCurrent(generation)
  const blocked = useBlockingReadError(query)
  const snapshot = current && !blocked ? query.data?.snapshot : undefined
  const activitySnapshot = snapshot ? query.data?.activitySnapshot : undefined
  return { ...query, data: snapshot ? { snapshot, activitySnapshot } : undefined, snapshot, activitySnapshot }
}
