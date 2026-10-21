import { useCallback, useContext } from 'react'
import { skipToken, useQuery } from '@tanstack/react-query'
import { type RunNodeLiveActivity } from '@foreman-code/contracts'
import { type CurrentRunDetails as GetRunResponse } from '@foreman-code/contracts/wave25'
import { queryKeys } from '../../shared/api/query'
import { shareRunResponseOrSelection } from '../../shared/api/runLiveCache'
import { GraphRuntimeContext } from './graphContexts'
import { selectGraphNodeActivity } from './runtimeIndex'

export function useGraphNodeRuntime(workflowNodeId: string, agentId: string | undefined) {
  const scope = useContext(GraphRuntimeContext)
  const select = useCallback((response: GetRunResponse) => scope && agentId
    ? selectGraphNodeActivity(response, scope, workflowNodeId, agentId) : undefined,
  [scope, workflowNodeId, agentId])
  const query = useQuery<GetRunResponse, Error, RunNodeLiveActivity | undefined>({
    queryKey: queryKeys.run(scope?.workspaceId ?? '', scope?.runId ?? ''),
    // Cache-only observers: skipToken gives a leaf no way to start or expose a fetch.
    queryFn: skipToken,
    enabled: false,
    refetchInterval: false,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    select,
    structuralSharing: shareRunResponseOrSelection,
  })
  const activity = query.data
  const unavailable = Boolean(scope?.runId && (!scope.overlayAllowed || scope.unavailable || !activity))
  return { activity: unavailable ? undefined : activity, unavailable }
}
