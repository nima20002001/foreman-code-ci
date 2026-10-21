import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  WORKFLOW_KANBAN_LAYOUT_ROUTE, WorkflowKanbanLayoutReadSchema, type WorkflowKanbanLayout, type WorkflowKanbanLayoutRead,
} from '@foreman-code/contracts'
import { apiClient } from '../../../shared/api/client'
import { sessionGeneration } from '../../../shared/api/sessionBoundary'

const path = (workspaceId: string, workflowId: string) => WORKFLOW_KANBAN_LAYOUT_ROUTE
  .replace(':workspaceId', encodeURIComponent(workspaceId)).replace(':workflowId', encodeURIComponent(workflowId))
const kanbanLayoutKey = (workspaceId: string, workflowId: string) =>
  ['workflow-kanban-layout', sessionGeneration(), workspaceId, workflowId] as const

/** Server-owned Board layout of the workflow's Kanban object. Saves are optimistic and run in order;
 * a failed save rereads the persisted layout, so the Board never keeps showing an unsaved place. */
export function useKanbanLayout(workspaceId: string, workflowId: string, enabled = true) {
  const cache = useQueryClient()
  const queryKey = kanbanLayoutKey(workspaceId, workflowId)
  const mutationKey = ['workflow-kanban-layout-save', workspaceId, workflowId]
  const query = useQuery({ queryKey, retry: false, enabled,
    queryFn: ({ signal }) => apiClient.request(path(workspaceId, workflowId), WorkflowKanbanLayoutReadSchema, { signal }) })
  const mutation = useMutation({
    mutationKey, scope: { id: mutationKey.join(':') },
    mutationFn: (layout: WorkflowKanbanLayout) => apiClient.request(path(workspaceId, workflowId), WorkflowKanbanLayoutReadSchema,
      { method: 'PUT', body: { layout } }),
    onMutate: async (layout) => {
      await cache.cancelQueries({ queryKey })
      cache.setQueryData<WorkflowKanbanLayoutRead>(queryKey, { workspaceId, workflowId, layout })
    },
    onSettled: (_data, error) => {
      if (error || cache.isMutating({ mutationKey }) === 1) void cache.invalidateQueries({ queryKey })
    },
  })
  return { layout: query.data?.layout, readError: query.error, saveError: mutation.error, save: mutation.mutate }
}
