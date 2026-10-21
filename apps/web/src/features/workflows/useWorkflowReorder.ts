import { useCallback, useRef } from 'react'
import { commandWasRejected } from '../../shared/api/commandAttempt'
import { useWorkflowOrderMutation } from '../../shared/api/workflowOrder'
import { useNavigationOrderStore } from '../workspaces/navigationOrder'

export function useWorkflowReorder(workspaceId: string, orderRevision: number) {
  const mutation = useWorkflowOrderMutation(workspaceId)
  const inFlight = useRef(false)
  const announce = useNavigationOrderStore(state => state.announce)
  const unresolved = mutation.isError && !commandWasRejected(mutation.error)

  const save = useCallback((ids: readonly string[]) => {
    if (inFlight.current || unresolved) return
    inFlight.current = true
    mutation.mutate({ workspaceId, workflowIds: [...ids], expectedRevision: orderRevision, commandId: crypto.randomUUID() }, {
      onSuccess: () => announce('Workflow order saved.'),
      onSettled: () => { inFlight.current = false },
    })
  }, [announce, mutation, orderRevision, unresolved, workspaceId])

  const retry = () => {
    if (inFlight.current || !unresolved || !mutation.variables) return
    inFlight.current = true
    mutation.mutate(mutation.variables, {
      onSuccess: () => announce('Workflow order saved.'),
      onSettled: () => { inFlight.current = false },
    })
  }

  return { mutation, save, retry, unresolved }
}
