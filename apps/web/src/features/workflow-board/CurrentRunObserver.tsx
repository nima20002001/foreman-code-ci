import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { queryKeys } from '../../shared/api/query'
import { runsSelectorKeys } from '../runs-selector/query'
import { useCurrentRunQuery } from './currentRunQuery'

export function CurrentRunObserver({ scope }: { scope: RepeatGraphScopeV3 }) {
  const current = useCurrentRunQuery(scope)
  const client = useQueryClient()
  const { workspaceId, workflowId } = scope
  const state = current.data?.state.run.executionState
  const outcome = current.data?.state.run.outcome
  const cleanupPending = current.data?.state.run.cleanupPending
  useEffect(() => {
    if (!state || current.isError) return
    void client.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
    void client.invalidateQueries({ queryKey: runsSelectorKeys.list({ workspaceId, workflowId }) })
  }, [client, workspaceId, workflowId, state, outcome, cleanupPending, current.isError])
  return null
}
