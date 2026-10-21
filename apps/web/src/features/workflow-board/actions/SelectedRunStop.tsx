import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { useLocalHumanAccessQuery } from '../../../shared/api/settingsExperience'
import { useProtectedAccessError } from '../../../shared/api/useProtectedAccessError'
import { Alert, Button } from '../../../shared/ui/nocturne'
import { runActionsClient, type RunActionSelection } from './client'
import { StopControl } from './StopControl'
import { actionKey } from './state'
import { needsRunRefresh } from './policy'
import { canUseBoardAction } from '../permissions'
import { hierarchyKey } from '../../workflow-hierarchy/queries'

/** Reuses the Board's exact Stop command, receipt and cleanup reconciliation. */
export function SelectedRunStop({ scope }: {
  scope: RunActionSelection & Partial<Pick<RepeatGraphScopeV3, 'workflowVersionId'>>
}) {
  const access = useLocalHumanAccessQuery(), cache = useQueryClient()
  const principal = access.isError ? undefined : access.data?.principal
  const live = !!principal && Date.parse(principal.expiresAt) > Date.now()
  const read = live && !!principal && canUseBoardAction(principal.grants, 'runs:read', scope)
  const stop = live && !!principal && canUseBoardAction(principal.grants, 'runs:stop', scope)
  const status = useQuery({ queryKey: actionKey(scope, 'status', scope.workflowVersionId ?? null), enabled: read,
    queryFn: ({ signal }) => runActionsClient.status(scope, { signal }), retry: false, staleTime: 1000, gcTime: 0,
    refetchOnWindowFocus: true, refetchOnReconnect: true,
    refetchInterval: query => query.state.error ? false : query.state.data && needsRunRefresh(query.state.data) ? 5000 : false,
    refetchIntervalInBackground: false })
  const capability = useQuery({ queryKey: actionKey(scope, 'capabilities'), enabled: read,
    queryFn: ({ signal }) => runActionsClient.capabilities({ signal }), retry: false, staleTime: 30_000, gcTime: 0 })
  const denied = useProtectedAccessError(status)
  const refresh = () => {
    void access.refetch(); void status.refetch(); void capability.refetch()
    void cache.invalidateQueries({ queryKey: hierarchyKey({ workspaceId: scope.workspaceId,
      workflowId: scope.workflowId, runId: scope.runId }), exact: true })
  }
  if (!read || denied) return <p role="status">Run controls are unavailable with your current access.</p>
  if (status.isPending) return <p role="status">Reading Run controls…</p>
  if (status.error || !status.data) return <Alert tone="warning" title="Run controls could not be refreshed.">
    <Button size="sm" onClick={refresh}>Retry Run controls</Button></Alert>
  const runScope: RepeatGraphScopeV3 = { workspaceId: scope.workspaceId, workflowId: scope.workflowId,
    runId: scope.runId, workflowVersionId: status.data.workflowVersionId, executionSemanticsVersion: 3 }
  return <section aria-label="Stop selected Run">
    {capability.error ? <p role="alert">Stop availability could not be refreshed. Retry before sending a command.</p> : null}
    <StopControl scope={runScope} run={status.data} permitted={stop}
      available={!capability.isError && capability.data?.stopAvailable === true} refresh={refresh} />
  </section>
}
