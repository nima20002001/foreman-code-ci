import { useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { useBlocker, useLocation, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { CurrentWorkspaceDetails } from '@foreman-code/contracts/wave25'
import { boardSearchForInspection, type WorkspaceBoardInspection, boardSearchForRun, staysOnWorkflowBoard, type RepeatGraphScopeV3, type WorkflowBoardLocation } from '@foreman-code/contracts/wave25'
import { Button, ErrorState } from '../shared/ui/nocturne'
import { PersistedWorkflowBoundary } from '../features/graph/PersistedWorkflowBoundary'
import { WorkflowBoard } from '../features/workflow-board/WorkflowBoard'
import { BoardLoading } from '../features/workflow-board/BoardLoading'
import { useProtectedAccessError } from '../shared/api/useProtectedAccessError'
import { clearCurrentRunAccess, revokeCurrentRunWorkspace } from '../features/workflow-board/currentRunQuery'
import { ApiError } from '../shared/api/client'
import { queryKeys, useManagedWorkflowQuery, useWorkspaceDetailsQuery } from '../shared/api/query'
import { WorkspaceSelection } from './WorkspaceRoute'
import { RunsSelectorSearchSchema, withoutRunsSelectorSearch,
  resolveRunsSelectorBoardLocation as resolveWorkflowBoardLocation } from '../features/runs-selector'
import { clearSelectedSubagentHash } from '../features/runs-selector/search'
import { UnsavedChangesContext, type EditorRegistration, type LeaveTarget } from '../shared/ui/unsavedChanges'

function cacheWorkspaceProjection(client: ReturnType<typeof useQueryClient>, workspaceId: string, details: CurrentWorkspaceDetails) {
  client.setQueryData(queryKeys.agents(workspaceId), { agents: details.agents })
  for (const workflow of details.workflows) client.setQueryData(queryKeys.workflow(workspaceId, workflow.id), { workflow })
}

/** Parent route remains mounted for both historical deep links and canonical Run selection. */
/** Paths this route owns: the board, a workflow draft and a pinned Run graph. */
const BOARD_PATH = /^\/workspaces\/[^/]+(?:\/workflows\/[^/]+\/(?:draft|runs\/.+))?\/?$/u

export function WorkspaceRouteEntry() {
  const location = useLocation()
  const last = useRef<WorkflowBoardLocation | undefined>(undefined)
  let selection: WorkflowBoardLocation
  try {
    selection = resolveWorkflowBoardLocation(location.pathname, location.search)
    assertHistoryPin(selection, location.search.selectedRunId)
  }
  catch {
    // While navigating away, this route renders once with the next page's URL before it unmounts.
    // Keep the board that was shown instead of flashing an error for a URL that is not a board link.
    if (last.current && !BOARD_PATH.test(location.pathname)) return <WorkspaceBoardRoute selection={last.current} />
    return <ErrorState title="Invalid board selection" description="Open a valid workflow or Run link." />
  }
  last.current = selection
  return <WorkspaceBoardRoute selection={selection} />
}

function WorkspaceBoardRoute({ selection }: { selection: WorkflowBoardLocation }) {
  const { workspaceId, workflowId: requestedId, search, run } = selection
  const navigate = useNavigate(), client = useQueryClient()
  const location = useLocation(), selectedRunId = location.search.selectedRunId
  const workspace = useWorkspaceDetailsQuery(workspaceId)
  const managed = useManagedWorkflowQuery(workspaceId, requestedId ?? '')
  const denied = useProtectedAccessError(workspace), managedDenied = useProtectedAccessError(managed)
  const details = denied ? undefined : workspace.data
  const managedWorkflow = managedDenied ? undefined : managed.data?.workflow
  const workflowId = requestedId ?? details?.workflows[0]?.id
  const workflow = details?.workflows.find((item) => item.id === workflowId) ?? managedWorkflow
  useEffect(() => {
    if (!denied) return
    if (denied.status === 401) clearCurrentRunAccess(client)
    else revokeCurrentRunWorkspace(client, workspaceId)
  }, [denied, client, workspaceId])
  useEffect(() => { if (details) cacheWorkspaceProjection(client, workspaceId, details) }, [client, workspaceId, details])
  useEffect(() => {
    // Resolve an unpinned workspace default only, but NEVER retarget a pinned Run.
    if (run || selectedRunId) return
    const detailsKey = queryKeys.workspaceDetails(workspaceId), managedKey = queryKeys.managedWorkflow(workspaceId, requestedId ?? '')
    type Managed = NonNullable<ReturnType<typeof useManagedWorkflowQuery>['data']>
    const latest = client.getQueryData<CurrentWorkspaceDetails>(detailsKey)
    const catalog = client.getQueryData<Managed>(managedKey)
    if (!latest || requestedId && (latest.workflows.some((item) => item.id === requestedId)
      || catalog?.workflow.id === requestedId
      || client.getQueryState(managedKey)?.fetchStatus === 'fetching')) return
    if (requestedId === latest.workflows[0]?.id) return
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, replace: true, search: (previous) => {
      const current = client.getQueryData<CurrentWorkspaceDetails>(detailsKey)
      const saved = client.getQueryData<Managed>(managedKey)
      if (!current || previous.runId || previous.selectedRunId || previous.workflowId !== search.workflowId || previous.workflowId && (
        current.workflows.some((item) => item.id === previous.workflowId)
        || saved?.workflow.id === previous.workflowId
        || client.getQueryState(managedKey)?.fetchStatus === 'fetching')) return previous
      const next = { ...previous }, fallback = current.workflows[0]?.id
      if (fallback) next.workflowId = fallback
      else delete next.workflowId
      if (requestedId) delete next.agentId
      return next
    } })
  }, [requestedId, run, selectedRunId, search.workflowId, workspaceId, navigate, client, details, managed.data, managed.fetchStatus])
  const selectRun = useCallback((scope?: RepeatGraphScopeV3) => {
    if (!workflowId) return
    if (scope && (scope.workspaceId !== workspaceId || scope.workflowId !== workflowId)) throw new Error('Run selection belongs to a different board.')
    // Explicit legacy Run/Current actions replace, rather than combine, history pins.
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, replace: Boolean(selectedRunId),
      hash: (previous) => run?.runId === scope?.runId ? previous ?? '' : clearSelectedSubagentHash(previous ?? ''),
      search: (previous) => boardSearchForRun(withoutRunsSelectorSearch(previous), workflowId, scope) })
  }, [workflowId, workspaceId, navigate, run?.runId, selectedRunId])
  useEffect(() => {
    if (!run || !location.pathname.includes('/runs/')) return
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, replace: true, hash: true,
      search: previous => boardSearchForInspection(withoutRunsSelectorSearch(previous), run.workflowId, run, {
        runNodeId: previous.runNodeId, runRelationshipId: previous.runRelationshipId,
        runExchangeKey: previous.runExchangeKey,
      }) })
  }, [run, location.pathname, navigate, workspaceId])
  const selectInspection = useCallback((inspection: WorkspaceBoardInspection) => {
    if (!workflowId || !run) return
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, hash: true, search: (previous) => {
      if (previous.selectedRunId && previous.selectedRunId !== run.runId) return previous
      return { ...boardSearchForInspection(withoutRunsSelectorSearch(previous), workflowId, run, inspection),
        selectedRunId: previous.selectedRunId }
    } })
  }, [workflowId, run, workspaceId, navigate])
  const selectDraftAgent = useCallback((agentId?: string) => {
    if (!workflowId) return
    // Read the latest search in the updater; an unrelated selection must not lose history.
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, hash: true, search: (previous) => {
      if (previous.workflowId && previous.workflowId !== workflowId) return previous
      const board = resolveWorkflowBoardLocation(location.pathname, previous)
      const next = { ...boardSearchForRun(withoutRunsSelectorSearch(board.search), workflowId, board.run),
        runNodeId: board.search.runNodeId, runRelationshipId: board.search.runRelationshipId,
        runExchangeKey: board.search.runExchangeKey, selectedRunId: previous.selectedRunId }
      if (agentId) next.agentId = agentId
      else delete next.agentId
      return next
    } })
  }, [workflowId, workspaceId, location.pathname, navigate])

  if (workspace.isPending && !details) return <WorkspaceSelection workspaceId={workspaceId} state="loading" slots={{ graph: <BoardLoading /> }} />
  if (!details) {
    const notFound = ApiError.is(workspace.error) && workspace.error.status === 404
    return <WorkspaceSelection workspaceId={workspaceId} state={notFound ? 'not-found' : 'error'}
      stateMessage="This workspace cannot be opened with the current access.">
      <Button variant="secondary" onClick={() => void workspace.refetch()}>Retry workspace request</Button>
    </WorkspaceSelection>
  }
  return <WorkspaceSelection workspaceId={workspaceId} selectedAgentId={search.agentId} activeWorkflowId={workflowId}
    state={workflowId ? 'ready' : 'empty'} allowBoardWithoutLocation
    slots={{ workspace: <strong data-testid="workspace-name">{details.workspace.name}</strong>, graph: workflowId ? (
      <BoardHistoryNavigationBoundary key={JSON.stringify([workspaceId, workflowId])}>
        <WorkflowBoard key={JSON.stringify([workspaceId, workflowId])} workspaceId={workspaceId} workflowId={workflowId}
          run={run} selectRun={selectRun} summaries={details.runs} summariesReadAt={workspace.dataUpdatedAt} selectInspection={selectInspection}
          selectedAgentId={search.agentId} selectDraftAgent={selectDraftAgent}
          inspection={{ runNodeId: search.runNodeId, runRelationshipId: search.runRelationshipId, runExchangeKey: search.runExchangeKey }}>
          <PersistedWorkflowBoundary workspaceId={workspaceId} workflowId={workflowId} workflow={workflow}
            updateFailures={workspace.isError ? [{ id: 'WORKSPACE_UPDATES_UNAVAILABLE', message: 'Workspace updates unavailable. Local edits are kept.',
              pending: workspace.isFetching, retry: () => void workspace.refetch() }] : []} />
        </WorkflowBoard>
      </BoardHistoryNavigationBoundary>
    ) : undefined }} />
}

/** The frozen resolver validates legacy pins; the extension must also pin a workflow. */
function assertHistoryPin(board: WorkflowBoardLocation, selectedRunId: unknown) {
  if (selectedRunId !== undefined && (!board.workflowId || (board.run && board.run.runId !== selectedRunId))) {
    throw new Error('Invalid or conflicting history selection.')
  }
}

function projectBoardDeparture(target: LeaveTarget) {
  const search = RunsSelectorSearchSchema.parse(target.search)
  const board = resolveWorkflowBoardLocation(target.pathname, search)
  assertHistoryPin(board, search.selectedRunId)
  const projectedSearch = search.selectedRunId && board.workflowId
    ? boardSearchForRun(withoutRunsSelectorSearch(search), board.workflowId, board.run)
    : withoutRunsSelectorSearch(search)
  return { target: { ...target, search: projectedSearch }, board,
    runId: search.selectedRunId ?? board.run?.runId ?? null,
    history: Boolean(search.selectedRunId || target.pathname.includes('/runs/')) }
}

/** Adapt this route's existing registrations, not the shared guard or frozen contracts.
 * The live registration getters retain the original draft, save/discard and recovery rules.
 */
export function BoardHistoryNavigationBoundary({ children }: { children: ReactNode }) {
  const parent = useContext(UnsavedChangesContext)
  const editors = useRef(new Map<string, EditorRegistration>())
  const context = useMemo(() => parent && ({ ...parent,
    register(id: string, editor: EditorRegistration) {
      editors.current.set(id, editor)
      const unregister = parent.register(id, {
        get current() { return editor.current },
        blocks(current, next) {
          try {
            const from = projectBoardDeparture(current), to = projectBoardDeparture(next)
            if (staysOnWorkflowBoard(from.target, to.target)) return false
            return editor.blocks?.(from.target, to.target) ?? true
          } catch { return true }
        },
      })
      return () => { editors.current.delete(id); unregister() }
    },
  }), [parent])
  useBlocker({ enableBeforeUnload: false, shouldBlockFn: async ({ current, next }) => {
    let from: ReturnType<typeof projectBoardDeparture>, to: ReturnType<typeof projectBoardDeparture>
    try { from = projectBoardDeparture(current); to = projectBoardDeparture(next) }
    catch { return false } // Invalid/departing routes still go through the original guard.
    if (!from.history && !to.history) return false
    if (from.board.workspaceId !== to.board.workspaceId || !from.board.workflowId
      || from.board.workflowId !== to.board.workflowId || from.runId === to.runId) return false
    // hidden/inert cannot cover body portals. Keep navigation put until their
    // own Close/Save/Discard guard settles them; never force-dismiss an editor.
    const portal = document.querySelector<HTMLElement>('dialog[open], .n-agent-popover')
    if (portal) { portal.querySelector<HTMLElement>('button')?.focus(); return true }
    const ids = [...editors.current].filter(([, entry]) => entry.current.busy || entry.current.uncertain
      || entry.current.scope === 'surface' && entry.current.dirty).map(([id]) => id)
    // Same-workflow navigation preserves the document draft, not permission to
    // abandon a pending Start/Save or an edited contextual form.
    return ids.length > 0 ? !parent || !await parent.request(ids) : false
  } })
  return <UnsavedChangesContext.Provider value={context}>{children}</UnsavedChangesContext.Provider>
}
