import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { RunBoardSnapshotGetInput } from '@foreman-code/contracts/run-snapshots'
import { subagentsApi } from './client'
import { SUBAGENT_LIMITS } from '@foreman-code/contracts/subagents'
import { isTransientReadError } from '../../shared/api/readFailure'
import { ApiError } from '../../shared/api/client'
import { sessionGeneration } from '../../shared/api/sessionBoundary'

export type SubagentsScope = RunBoardSnapshotGetInput
export const subagentsKey = (scope: SubagentsScope) => ['run-subagents', sessionGeneration(), scope.workspaceId, scope.workflowId, scope.runId] as const
export const accessFailed = (error: unknown) => Boolean(error) && !isTransientReadError(error)
const pollInterval = (error: unknown) => accessFailed(error) ? false : 2500
export function useRunSubagents(scope: SubagentsScope) {
  return useInfiniteQuery({
    queryKey: [...subagentsKey(scope), 'list'], initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const page = await subagentsApi.list({ workspaceId: scope.workspaceId, runId: scope.runId, limit: SUBAGENT_LIMITS.page, cursor: pageParam }, { signal })
      if (page.items.some(({ subagent }) => subagent.workflowId !== scope.workflowId)) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Subagents belong to a different workflow.' })
      }
      return page
    },
    getNextPageParam: (page, _pages, _cursor, cursors) => page.nextCursor
      && !cursors.includes(page.nextCursor) ? page.nextCursor : undefined,
    retry: false, staleTime: 1000, gcTime: 60_000,
    refetchInterval: (query) => pollInterval(query.state.error),
  })
}
export function useSubagentDetail(scope: SubagentsScope, subagentId: string) {
  return useQuery({ queryKey: [...subagentsKey(scope), subagentId, 'detail'],
    queryFn: async ({ signal }) => {
      const detail = await subagentsApi.detail({ workspaceId: scope.workspaceId, runId: scope.runId, subagentId }, { signal })
      if (detail.subagent.workflowId !== scope.workflowId) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Subagent belongs to a different workflow.' })
      return detail
    }, retry: false, staleTime: 1000, gcTime: 60_000,
    refetchInterval: (query) => pollInterval(query.state.error),
  })
}
export function useSubagentMessages(scope: SubagentsScope, subagentId: string, enabled: boolean) {
  return useInfiniteQuery({ queryKey: [...subagentsKey(scope), subagentId, 'messages'], enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => subagentsApi.messages({ workspaceId: scope.workspaceId, runId: scope.runId, subagentId, cursor: pageParam }, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false, staleTime: 1000, gcTime: 60_000,
    refetchInterval: (query) => enabled ? pollInterval(query.state.error) : false,
  })
}
export function useSubagentTools(scope: SubagentsScope, subagentId: string, enabled: boolean) {
  return useInfiniteQuery({ queryKey: [...subagentsKey(scope), subagentId, 'tools'], enabled,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => subagentsApi.tools({ workspaceId: scope.workspaceId, runId: scope.runId, subagentId, cursor: pageParam }, { signal }),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false, staleTime: 1000, gcTime: 60_000,
    refetchInterval: (query) => enabled ? pollInterval(query.state.error) : false,
  })
}
