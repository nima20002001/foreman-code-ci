import { InfoHint } from '../../../shared/ui/InfoHint'
import { useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RepeatGraphScopeV3Schema } from '@foreman-code/contracts/wave25'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { ApiError } from '../../../shared/api/client'
import { useLocalHumanAccessQuery } from '../../../shared/api/settingsExperience'
import { sessionGeneration } from '../../../shared/api/sessionBoundary'
import { useWorkflowBoard } from '../context'
import { currentRunKey } from '../currentRunQuery'
import { canUseBoardAction } from '../permissions'
import { assertActionScope, runActionsClient, type RunActionSelection } from './client'
import { actionKey } from './state'
import { needsRunRefresh, type ActionRun } from './policy'
import { Approvals } from './Approvals'
import { FailureDetails, SavedRepeatPolicy } from './FailureDetails'
import { StartControls } from './StartControls'
import { StopControl, StopReceipt } from './StopControl'
import './actions.css'

function SelectedRunActions({ selection, access }: {
  selection: RunActionSelection; access: ReturnType<typeof useLocalHumanAccessQuery>
}) {
  const cache = useQueryClient(), board = useWorkflowBoard()
  const principal = access.isError ? undefined : access.data?.principal
  const livePrincipal = !!principal && Date.parse(principal.expiresAt) > Date.now()
  const allowed = (action: ManagementAction, creating = false) => livePrincipal && !!principal && canUseBoardAction(
    principal.grants, action, creating ? { workspaceId: selection.workspaceId, workflowId: selection.workflowId } : selection)
  const statusKey = actionKey(selection, 'status', board?.run?.workflowVersionId ?? null)
  const status = useQuery({ queryKey: statusKey, enabled: allowed('runs:read'),
    queryFn: async ({ signal }) => {
      const value = await runActionsClient.status(selection, { signal })
      const previous = cache.getQueryData<ActionRun>(statusKey)
      if (previous) assertActionScope(value, previous)
      if (board) {
        if (board.workspaceId !== selection.workspaceId || board.workflowId !== selection.workflowId
          || !board.run || board.run.runId !== selection.runId) throw new Error('The contextual controls do not match the URL-selected Board Run.')
        if (board.run) assertActionScope(value, board.run)
      }
      return value
    }, retry: false, gcTime: 0, staleTime: 1000, refetchOnWindowFocus: true, refetchOnReconnect: 'always',
    // Contextual status owns bounded polling and explicit client refreshes.
    meta: { refetchOnApiReconnect: false },
    refetchInterval: (query) => {
      // A transient read failure keeps bounded polling; authority, not-found and
      // scope/identity failures stop until an explicit refresh.
      const error = query.state.error
      if (error && (!ApiError.is(error) || [401, 403, 404].includes(error.status))) return false
      // No accepted status yet after a transient failure: keep trying (bounded).
      if (!query.state.data) return error ? 5000 : false
      return needsRunRefresh(query.state.data) ? 5000 : false
    },
    refetchIntervalInBackground: false })
  const capability = useQuery({ queryKey: actionKey(selection, 'capabilities'), enabled: allowed('runs:read'),
    queryFn: ({ signal }) => runActionsClient.capabilities({ signal }), retry: false, gcTime: 0,
    staleTime: 30_000, refetchOnWindowFocus: false, refetchOnReconnect: false })
  const run = !allowed('runs:read') || status.isError ? undefined : status.data
  const { workspaceId, workflowId, runId } = selection
  const workflowVersionId = allowed('runs:read') ? status.data?.workflowVersionId : undefined
  const scope = useMemo(() => workflowVersionId ? RepeatGraphScopeV3Schema.parse({
    workspaceId, workflowId, runId, workflowVersionId, executionSemanticsVersion: 3,
  }) : undefined, [workspaceId, workflowId, runId, workflowVersionId])
  const refresh = () => {
    void access.refetch()
    void cache.invalidateQueries({ queryKey: statusKey, exact: true })
    if (scope) void cache.invalidateQueries({ queryKey: currentRunKey(scope), exact: true })
  }
  const sync = useMutation({ retry: false, gcTime: 0, mutationFn: async () => {
    const authorization = await access.refetch()
    if (authorization.isError || !authorization.data || Date.parse(authorization.data.principal.expiresAt) <= Date.now()
      || !canUseBoardAction(authorization.data.principal.grants, 'runs:read', selection)) throw new Error('Current Run read permission is unavailable.')
    const [fresh, capabilities] = await Promise.all([status.refetch(), capability.refetch()])
    if (fresh.isError) throw fresh.error
    if (capabilities.isError) throw capabilities.error
    if (scope) await cache.invalidateQueries({ queryKey: currentRunKey(scope), exact: true }, { throwOnError: true })
    return 'Client state refreshed.'
  } })
  return <section className="run-actions" aria-label="Selected Run actions">
    <h3>Actions for the selected Run</h3>
    <p>Run <code>{selection.runId}</code> · workflow <code>{selection.workflowId}</code>.</p>
    <button type="button" disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? 'Refreshing client state…' : 'Refresh / reconnect client state'}</button>
    {sync.data ? <p role="status">{sync.data}</p> : null}
    {sync.isError ? <p role="alert">Synchronization failed: {sync.error.message} No command was sent.</p> : null}
    {!allowed('runs:read') ? <p role="status">Run read permission is unavailable or still being checked. No cached private details authorize actions.</p>
      : status.isPending ? <p role="status">Reading the exact Run’s bounded current state…</p> : null}
    {status.isError ? <p role="alert">Current Run state is unavailable: {status.error.message} Cached state is not shown as current evidence.</p> : null}
    {status.isError && scope ? <StopReceipt scope={scope} /> : null}
    {scope && run ? <>
      <p role="status">Recorded {run.executionState} · {run.outcome} · saved version <code>{scope.workflowVersionId}</code>.
        {run.stopCause ? ` Recorded Stop cause: ${run.stopCause}.` : ''}</p>
      {run.failure ? <p role="status">Run failed: {run.failure.message} <code>{run.failure.code}</code></p> : null}
      {capability.isError ? <p role="alert">Runtime capabilities are unavailable. New Start and Stop are disabled until a refresh succeeds.</p> : null}
      <StopControl scope={scope} run={run} permitted={allowed('runs:stop')}
        available={!capability.isError && capability.data?.stopAvailable === true} refresh={refresh} />
      <Approvals scope={scope} run={run} canRead={allowed('interactions:read')} canRespond={allowed('interactions:respond')} refresh={refresh} />
      <FailureDetails scope={scope} />
      <section aria-label="Execution recovery availability"><h4>Execution recovery<InfoHint label="Execution recovery">No owned-execution Resume capability is advertised by the current Board API. Where supported, native reconciliation and approval resumption are backend-owned and ownership-fenced. A reconnect or successful refresh does not prove provider restart recovery.</InfoHint></h4>
        <button type="button" disabled title="A runs:resume grant or a schema name alone is not an advertised owned-execution recovery capability.">Resume execution — unavailable</button>
      </section>
      <StartControls scope={scope} run={run} permitted={allowed('runs:start', true)}
        available={!capability.isError && capability.data?.runtimeAdmission === true} refresh={refresh}
        viewRun={board ? (next) => board.selectRun(next) : undefined} />
      <SavedRepeatPolicy scope={scope} />
    </> : null}
  </section>
}

/** The only public mount point. Selection is supplied by the URL-owned Board;
 * changing Run or principal tears down private Query observers and command forms. */
export function RunActions(props: RunActionSelection) {
  const access = useLocalHumanAccessQuery(), board = useWorkflowBoard()
  return <SelectedRunActions key={JSON.stringify([sessionGeneration(), props.workspaceId, props.workflowId, props.runId,
    board?.workspaceId, board?.workflowId, board?.run?.runId, board?.run?.workflowVersionId, board?.run?.executionSemanticsVersion])}
    selection={props} access={access} />
}
