import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'
import type { WorkflowReorderInput } from '@foreman-code/contracts/management'
import type { CurrentWorkspaceDetails } from '@foreman-code/contracts/wave25'
import { apiClient } from './client'
import { queryKeys } from './query'
import { assertSession, sessionGeneration, sessionIsSwitching, SessionChangedError } from './sessionBoundary'

type WorkflowPages = InfiniteData<Awaited<ReturnType<typeof apiClient.listManagedWorkflowPage>>, string | undefined>

/** Replace selected slots so unloaded or unselected workflows keep their places. */
function reorderItems<T>(items: T[], ids: readonly string[], identify: (item: T) => string): T[] {
  const selected = new Set(ids)
  const byId = new Map<string, T[]>()
  for (const item of items) {
    const id = identify(item)
    const matches = byId.get(id) ?? []
    matches.push(item)
    byId.set(id, matches)
  }
  const ordered = [...selected].flatMap(id => byId.get(id) ?? [])
  let index = 0
  return items.map(item => selected.has(identify(item)) ? ordered[index++]! : item)
}

function reorderPages(data: WorkflowPages, ids: readonly string[], revision?: number): WorkflowPages {
  const items = reorderItems(data.pages.flatMap(page => page.items), ids, item => item.workflow.id)
  let offset = 0
  return { ...data, pages: data.pages.map(page => {
    const next = { ...page, items: items.slice(offset, offset + page.items.length) }
    if (revision !== undefined) next.orderRevision = revision
    offset += page.items.length
    return next
  }) }
}

export function useWorkflowOrderMutation(workspaceId: string) {
  const client = useQueryClient()
  const pageKey = [...queryKeys.managedWorkflows(workspaceId), 'pages']
  const detailsKey = queryKeys.workspaceDetails(workspaceId)
  return useMutation({
    mutationKey: queryKeys.workflowOrderMutation(workspaceId),
    retry: false,
    mutationFn: (input: WorkflowReorderInput) => apiClient.reorderWorkflows(input),
    onMutate: async (input) => {
      const generation = sessionGeneration()
      await Promise.all([
        client.cancelQueries({ queryKey: pageKey }),
        client.cancelQueries({ queryKey: detailsKey }),
      ])
      assertSession(generation)
      if (sessionIsSwitching()) throw new SessionChangedError()
      const pages = client.getQueriesData<WorkflowPages>({ queryKey: pageKey })
      const details = client.getQueryData<CurrentWorkspaceDetails>(detailsKey)
      client.setQueriesData<WorkflowPages>({ queryKey: pageKey }, data =>
        data ? reorderPages(data, input.workflowIds) : data)
      client.setQueryData<CurrentWorkspaceDetails>(detailsKey, data => data ? {
        ...data, workflows: reorderItems(data.workflows, input.workflowIds, item => item.id),
      } : data)
      return { generation, pages, details }
    },
    onSuccess: (result, input, context) => {
      if (context?.generation !== sessionGeneration() || sessionIsSwitching()) return
      client.setQueriesData<WorkflowPages>({ queryKey: pageKey }, data =>
        data ? reorderPages(data, input.workflowIds, result.value.orderRevision) : data)
    },
    onError: (_error, _input, context) => {
      if (context?.generation !== sessionGeneration() || sessionIsSwitching()) return
      for (const [key, previous] of context.pages) {
        if (!previous) continue
        const ids = previous.pages.flatMap(page => page.items.map(item => item.workflow.id))
        client.setQueryData<WorkflowPages>(key, data => data ?
          reorderPages(data, ids, previous.pages[0]?.orderRevision) : data)
      }
      if (context.details) {
        const ids = context.details.workflows.map(item => item.id)
        client.setQueryData<CurrentWorkspaceDetails>(detailsKey, data => data ? {
          ...data, workflows: reorderItems(data.workflows, ids, item => item.id),
        } : data)
      }
    },
    onSettled: async (_result, _error, _input, context) => {
      if (context?.generation !== sessionGeneration() || sessionIsSwitching()) return
      await Promise.all([
        client.invalidateQueries({ queryKey: pageKey }),
        client.invalidateQueries({ queryKey: detailsKey }),
      ])
    },
  })
}
