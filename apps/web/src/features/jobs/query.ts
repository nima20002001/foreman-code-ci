import type { WorkflowJobPage } from '@foreman-code/contracts/job-verification'
import type { JobQueueTicket } from '@foreman-code/contracts/job-admission'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { jobsClient } from './client'
import { useBlockingReadError } from '../../shared/api/readFailure'
import { jobAccessLost, jobReadRetry, loadedChunks } from './model'

export const jobKeys = {
  workflowHistory: (workspaceId: string, workflowId: string) => ['jobs', workspaceId, 'workflow', workflowId] as const,
  workflowQueue: (workspaceId: string, workflowId: string) => ['jobs', workspaceId, 'workflow-queue', workflowId] as const,
  definitions: (workspaceId: string) => ['jobs', workspaceId, 'definitions'] as const,
  execution: (workspaceId: string, id: string) => ['jobs', workspaceId, 'execution', id] as const,
  logs: (workspaceId: string, id: string, attemptId: string) => ['jobs', workspaceId, 'logs', id, attemptId] as const,
  artifacts: (workspaceId: string, id: string) => ['jobs', workspaceId, 'artifacts', id] as const,
}
export function useJobDefinitions(workspaceId: string) {
  const query = useQuery({ queryKey: jobKeys.definitions(workspaceId), queryFn: ({ signal }) => jobsClient.definitions(workspaceId, { signal }), retry: jobReadRetry })
  const blocked = useBlockingReadError(query)
  return { ...query, data: blocked ? undefined : query.data }
}
export function useJobExecution(workspaceId: string, id: string) {
  const query = useQuery({ queryKey: jobKeys.execution(workspaceId, id), queryFn: ({ signal }) => jobsClient.execution(workspaceId, id, { signal }), retry: jobReadRetry, gcTime: 0, placeholderData: () => undefined, refetchInterval: query => jobAccessLost(query.state.error) ? false : query.state.data?.process.phase === 'terminal' ? 5000 : 3000 })
  const blocked = useBlockingReadError(query)
  return { ...query, data: blocked ? undefined : query.data }
}
export function useJobLogs(workspaceId: string, id: string, attemptId: string, enabled: boolean) {
  const query = useInfiniteQuery({ queryKey: jobKeys.logs(workspaceId, id, attemptId), initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => jobsClient.logs(workspaceId, id, attemptId, pageParam, { signal }),
    getNextPageParam: (page, _pages, cursor) => page.nextCursor > cursor ? page.nextCursor : undefined,
    maxPages: 5, enabled, retry: jobReadRetry, gcTime: 0, placeholderData: () => undefined,
  })
  const blocked = useBlockingReadError(query)
  return { ...query, blocked: Boolean(blocked),
    chunks: !enabled || blocked ? [] : loadedChunks(query.data?.pages),
    pages: !enabled || blocked ? [] : query.data?.pages ?? [] }
}
export function useJobArtifacts(workspaceId: string, id: string, enabled: boolean) {
  const query = useQuery({ queryKey: jobKeys.artifacts(workspaceId, id), queryFn: ({ signal }) => jobsClient.artifacts(workspaceId, id, { signal }), enabled, retry: jobReadRetry, gcTime: 0, refetchInterval: query => enabled && !jobAccessLost(query.state.error) ? 5000 : false })
  const blocked = useBlockingReadError(query)
  return { ...query, data: !enabled || blocked ? undefined : query.data }
}

export function useWorkflowJobHistory(workspaceId: string, workflowId: string, enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: jobKeys.workflowHistory(workspaceId, workflowId),
    initialPageParam: undefined as NonNullable<WorkflowJobPage['nextCursor']> | undefined,
    queryFn: ({ signal, pageParam }) => jobsClient.workflowHistory(workspaceId, workflowId,
      pageParam ? { cursor: pageParam } : {}, { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    enabled, retry: jobReadRetry,
    refetchInterval: query => enabled && !jobAccessLost(query.state.error) ? 5000 : false,
  })
  const items = new Map<string, WorkflowJobPage['items'][number]>()
  for (const page of query.data?.pages ?? []) {
    for (const item of page.items) items.set(item.execution.id, item)
  }
  return { ...query, items: query.isError ? [] : [...items.values()] }
}

export function useWorkflowJobQueue(workspaceId: string, workflowId: string, enabled: boolean) {
  const query = useInfiniteQuery({
    queryKey: jobKeys.workflowQueue(workspaceId, workflowId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => jobsClient.queuePage(workspaceId,
      { workflowId, historyBeforeSequence: pageParam }, { signal }),
    getNextPageParam: page => page.nextHistoryCursor ?? undefined,
    enabled, retry: jobReadRetry,
    refetchInterval: query => enabled && !jobAccessLost(query.state.error) ? 5000 : false,
  })
  const tickets = new Map<string, JobQueueTicket>()
  for (const page of query.data?.pages ?? []) {
    for (const ticket of page.tickets) {
      if (!tickets.has(ticket.id)) tickets.set(ticket.id, ticket)
    }
  }
  return { ...query, tickets: query.isError ? [] : [...tickets.values()] }
}
