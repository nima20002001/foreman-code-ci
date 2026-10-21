import { MemoryBoardSurface } from './MemoryBoardSurface'
import { InfoHint } from '../../shared/ui/InfoHint'
import { activeRunCandidates } from '@foreman-code/contracts/run-snapshots'
import { MasterOverview } from '../workflow-hierarchy/MasterOverview'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { useLocation, useRouter } from '@tanstack/react-router'
import type { ExecutionRef, WorkflowRunSummary } from '@foreman-code/contracts'
import type { RepeatGraphScopeV3, WorkspaceBoardInspection } from '@foreman-code/contracts/wave25'
import { Alert, Button, Dialog, Icon, IconButton } from '../../shared/ui/nocturne'
import { WorkspaceExecutionLocationSettings } from '../settings/WorkspaceExecutionLocationSettings'
import { RunBoardSlot } from '../run-board'
import { useRunSummaries, useSelectedRun, useSelectedRunSnapshot } from '../runs-selector'
import { BoardNavigationControls } from './BoardNavigationControls'
import { CurrentRunObserver } from './CurrentRunObserver'
import { WorkflowBoardContext, type WorkflowAuthoringActions } from './context'
import { ActivitiesPopover } from './ActivitiesPopover'
import { RunActivityPanel } from './RunActivityPanel'
import { shortRunId } from './runFacts'
import { useInspectionPresentation } from './inspect/presentation'
import { useWorkflowSidePanel } from './useWorkflowSidePanel'
import { WorkflowMemoryDialog, WorkflowSidePanel, type WorkflowCollaborationSlots } from './WorkflowSidePanel'
import { useWorkflowOperatorDock } from './operatorDockContext'
import { useBrowserPanelRelease } from './useBrowserPanelRelease'
import { useCollaborationUISlots } from '../../shared/ui/collaborationSlots'
import { createWorkflowExecutionChatSlot } from '../workflow-hierarchy/execution-chat/createWorkflowExecutionChatSlot'
import { SelectedRunControls } from './actions/SelectedRunControls'
import { GroupChatPanel } from './GroupChatPanel'
import './workflowBoard.css'

/** This component is keyed by workspace/workflow only, NEVER by selected Run. */
export function WorkflowBoard({ workspaceId, workflowId, run: requestedRun, selectRun, inspection, selectInspection, summaries, summariesReadAt, children, selectedAgentId, selectDraftAgent, collaborationSlots: suppliedSlots }: {
  workspaceId: string; workflowId: string; run?: RepeatGraphScopeV3
  selectedAgentId?: string; selectDraftAgent?(agentId?: string): void
  inspection: WorkspaceBoardInspection; selectInspection(inspection: WorkspaceBoardInspection): void
  selectRun(scope?: RepeatGraphScopeV3): void; summaries: readonly WorkflowRunSummary[]; summariesReadAt?: number; children: ReactNode
  collaborationSlots?: WorkflowCollaborationSlots
}) {
  const location = useLocation()
  const router = useRouter()
  const sharedSlots = useCollaborationUISlots()
  const inheritedSlots = sharedSlots?.workflow?.({ workspaceId, workflowId })
  const executionChat = useMemo(() => sharedSlots?.executionChatViews
    ? createWorkflowExecutionChatSlot(sharedSlots.executionChatViews) : undefined, [sharedSlots?.executionChatViews])
  const collaborationSlots = useMemo<WorkflowCollaborationSlots | undefined>(() => sharedSlots || suppliedSlots
    ? { memoryAccess: sharedSlots?.memoryAccess, nodeBrowser: sharedSlots?.nodeBrowser, ...inheritedSlots, ...suppliedSlots,
      ...(executionChat ? { executionChat } : {}) }
    : undefined, [sharedSlots, inheritedSlots, suppliedSlots, executionChat])
  const browserRelease = useBrowserPanelRelease(collaborationSlots?.beforeBrowserHide)
  const side = useWorkflowSidePanel(workspaceId, workflowId, requestedRun, browserRelease.request)
  const { releaseBrowser } = side
  const [sidePanelHost, setSidePanelHost] = useState<HTMLDivElement | null>(null)
  const [authoringActions, setAuthoringActions] = useState<WorkflowAuthoringActions>()
  const registerAuthoringActions = useCallback((actions?: WorkflowAuthoringActions) => setAuthoringActions(actions), [])
  useWorkflowOperatorDock(side.scope, sidePanelHost, side.panel.kind === 'operator', side.memoryOpen, side.selectPanel, side.closeOperator)
  const selection = useRef({ location: router.history.location, generation: 0 })
  const getSelectionToken = useCallback(() => {
    if (selection.current.location !== router.history.location) {
      selection.current.location = router.history.location
      selection.current.generation++
    }
    return selection.current.generation
  }, [router])
  const chooseRun = useCallback((scope?: RepeatGraphScopeV3) => {
    if (scope?.runId !== requestedRun?.runId) releaseBrowser()
    selection.current.generation++
    selectRun(scope)
  }, [selectRun, requestedRun?.runId, releaseBrowser])
  const selectedRun = useSelectedRun({ workspaceId, workflowId })
  const navigationSelection = useMemo(() => ({ ...selectedRun,
    selectRun: (runId: string | null) => {
      if (runId !== selectedRun.identity.runId) releaseBrowser()
      selection.current.generation++
      return selectedRun.selectRun(runId)
    },
  }), [selectedRun, releaseBrowser])
  // Canonical and legacy links both render the immutable RunBoardSlot.
  const legacyRun = requestedRun?.workspaceId === workspaceId && requestedRun.workflowId === workflowId
    && !location.search.selectedRunId ? requestedRun : undefined
  const picked = useSelectedRunSnapshot(selectedRun).snapshot
  const pickedRunId = location.search.selectedRunId
  // Background Run facts update the counter; only explicit navigation selects a Run.
  const listed = useRunSummaries({ workspaceId, workflowId }, !requestedRun && !pickedRunId)
  const candidates = activeRunCandidates(
    summaries.filter(item => item.workspaceId === workspaceId && item.workflowId === workflowId), listed.items,
  )
  // A pinned Run link keeps the retained editor and the pinned canvas; a picked Run renders the saved Run board.
  const boardSelection = legacyRun ? { ...selectedRun, identity: { ...selectedRun.identity, runId: null } } : selectedRun
  const current = boardSelection.active && !boardSelection.invalid && boardSelection.identity.runId === null
  const currentRef = useRef(current)
  currentRef.current = current
  // The retained editor is hidden while a Run is shown, so its Activities button is unavailable;
  // the Run's own Activities and details open from the Board toolbar over this exact scope.
  const selectedRunId = boardSelection.active && !boardSelection.invalid ? boardSelection.identity.runId : null
  const detailsScope = useMemo<RepeatGraphScopeV3 | undefined>(() => {
    if (!selectedRunId) return undefined
    if (legacyRun?.runId === selectedRunId) return legacyRun
    return picked?.kind === 'available' && picked.runId === selectedRunId
      ? { workspaceId, workflowId, runId: selectedRunId, workflowVersionId: picked.workflowVersionId, executionSemanticsVersion: 3 }
      : undefined
  }, [selectedRunId, legacyRun, picked, workspaceId, workflowId])
  const detailsRef = useRef(detailsScope)
  detailsRef.current = detailsScope
  const locationKey = JSON.stringify(['board-location-dialog', workspaceId, workflowId])
  const locationOpen = useInspectionPresentation((state) => !!state.open[locationKey])
  const setLocationOpen = useCallback((open: boolean) => {
    if (!open || currentRef.current) useInspectionPresentation.getState().setOpen(locationKey, open)
  }, [locationKey])
  const runsKey = JSON.stringify(['board-run-drawer', workspaceId, workflowId])
  const runsOpen = useInspectionPresentation((state) => !!state.open[runsKey])
  const toolbar = useRef<HTMLDivElement>(null)
  const findActivitiesButton = useCallback(() => toolbar.current?.querySelector<HTMLButtonElement>('button[aria-label="Activities"]') ?? null, [])
  const setRunsOpen = useCallback((open: boolean) => {
    if (open && !currentRef.current && !detailsRef.current) return
    useInspectionPresentation.getState().setOpen(runsKey, open)
    if (!open) setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) {
        findActivitiesButton()?.focus()
      }
    }, 0)
  }, [runsKey, findActivitiesButton])
  const linkedInspection = legacyRun && (inspection.runNodeId || inspection.runRelationshipId || inspection.runExchangeKey)
    ? JSON.stringify([legacyRun, inspection]) : undefined
  useEffect(() => { if (linkedInspection) setRunsOpen(true) }, [linkedInspection, setRunsOpen])
  useEffect(() => {
    if (!current && !detailsScope) setRunsOpen(false)
  }, [current, detailsScope, setRunsOpen])
  useEffect(() => () => {
    useInspectionPresentation.getState().setOpen(runsKey, false)
    useInspectionPresentation.getState().setOpen(locationKey, false)
  }, [runsKey, locationKey])
  useEffect(() => {
    // The preserved editor owns a window-level undo/redo listener. inert only
    // blocks its DOM, not that listener. Leave text inputs and dialogs alone.
    const shortcut = (event: KeyboardEvent) => {
      if (currentRef.current || (!event.ctrlKey && !event.metaKey) || event.altKey
        || !['z', 'y', 's'].includes(event.key.toLowerCase())) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')) return
      event.preventDefault(); event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', shortcut, true)
    return () => window.removeEventListener('keydown', shortcut, true)
  }, [])
  const activeRuns = candidates.length
  // History is rendered only by RunBoardSlot. Do not feed legacy Run pins to the
  // hidden editor/SelectedRunCanvas, or fabricate missing version/semantics pins.
  const value = useMemo(() => ({ workspaceId, workflowId, run: legacyRun, selectRun: chooseRun, getSelectionToken, inspection, selectInspection, selectedAgentId, selectDraftAgent,
    sidePanel: side.panel, selectedPanelNodeId: side.agentSelection?.nodeId, selectSidePanel: side.selectPanel, sidePanelHost, memoryOpen: side.memoryOpen,
    executionChatMounted: !!collaborationSlots?.executionChat,
    canvasVisible: side.view === 'graph', teamNodeId: side.teamNodeId, selectTeam: side.selectTeam,
    collaborationFields: collaborationSlots,
    openLocation: () => setLocationOpen(true), openRuns: () => setRunsOpen(true), activeRuns, authoringActive: current, registerAuthoringActions,
    navigationControls: current && side.view === 'graph' ? <BoardNavigationControls workspaceId={workspaceId} workflowId={workflowId} selection={navigationSelection} /> : undefined,
  }), [workspaceId, workflowId, legacyRun, chooseRun, getSelectionToken, inspection, selectInspection, selectedAgentId, selectDraftAgent, activeRuns, setRunsOpen, setLocationOpen, navigationSelection, current, side.view, side.panel, side.agentSelection?.nodeId, side.selectPanel, sidePanelHost, side.memoryOpen, side.teamNodeId, side.selectTeam, collaborationSlots, registerAuthoringActions])
  const detailsValue = useMemo(() => detailsScope ? { ...value, run: detailsScope } : value, [value, detailsScope])
  const authoringEvent = (event: SyntheticEvent) => {
    if (event.target instanceof Element && event.target.closest('.workflow-side-panel')) return
    // React capture also covers descendants portalled outside the inert subtree.
    if (!currentRef.current) { event.preventDefault(); event.stopPropagation() }
  }
  const showExecution = (nodeId: string, execution: ExecutionRef) => {
    side.selectExecution({ ...execution, nodeId })
  }
  const suppliedOverview = collaborationSlots?.overview
  const overviewContent = side.memoryOpen ? null : suppliedOverview?.()
  return <WorkflowBoardContext.Provider value={value}>
    <div ref={toolbar} className="unified-workflow-board" data-testid="unified-workflow-board" style={{ flexDirection: 'column' }}>
      <nav className="workflow-collaboration-toolbar" aria-label="Workflow views">
        <span>{legacyRun || pickedRunId ? 'Selected Run' : 'Editing draft'}</span>
        <Button size="sm" variant="ghost" aria-pressed={side.view === 'graph'} onClick={() => side.selectView('graph')}>Graph</Button>
        <Button size="sm" variant="ghost" aria-pressed={side.view === 'overview'} onClick={() => side.selectView('overview')}>Overview</Button>
        <Button size="sm" variant="ghost" onClick={() => side.setMemoryOpen(true)}>Memory board</Button>
        <Button size="sm" variant="ghost" aria-pressed={side.panel.kind === 'group_chat'} onClick={() => side.selectPanel({ kind: 'group_chat' })}>Group chat</Button>
      </nav>
      {browserRelease.error ? <Alert tone="warning" title="Browser control release is unconfirmed.">
        {browserRelease.error} Use the retained browser recovery controls to reconcile the original release.</Alert> : null}
      {collaborationSlots?.browserRecovery?.()}
      {!current || side.view === 'overview' ? <header className="board-topbar" aria-label="Board toolbar"
        style={{ position: 'static', flex: '0 0 auto', flexWrap: 'wrap', justifyContent: 'flex-end', padding: 'var(--space-2)', boxSizing: 'border-box', minWidth: 0 }}>
        <BoardNavigationControls workspaceId={workspaceId} workflowId={workflowId} selection={navigationSelection}
          runsLabel={current && side.view === 'overview' ? 'Choose run' : undefined} />
        {detailsScope ? <IconButton label="Activities" onClick={() => setRunsOpen(true)}><Icon name="history" size={16} /></IconButton> : null}
        {boardSelection.active && !boardSelection.invalid && boardSelection.identity.runId ?
          <SelectedRunControls key={JSON.stringify(boardSelection.identity)} visible={!side.memoryOpen}
            scope={{ workspaceId, workflowId, runId: boardSelection.identity.runId,
              ...(picked?.kind === 'available' ? { workflowVersionId: picked.workflowVersionId } : {}) }} /> : null}
      </header> : null}
      <div className="workflow-collaboration-layout" data-panel-open={side.panel.kind !== 'none' && !side.memoryOpen}>
      <div className="workflow-collaboration-canvas" hidden={side.view !== 'graph'} inert={side.view !== 'graph'}>
      <RunBoardSlot selection={boardSelection}>
        <div className="workflow-board-authoring" onClickCapture={authoringEvent} onKeyDownCapture={authoringEvent} onSubmitCapture={authoringEvent}>
          {children}
          {legacyRun ? <CurrentRunObserver scope={legacyRun} /> : null}
          {legacyRun ? <div className="board-run-tag" role="status">
            <RunContextLabel scope={legacyRun} />
          </div> : null}
          <ActivitiesPopover open={current && runsOpen} onClose={() => setRunsOpen(false)} findAnchor={findActivitiesButton}>
            {current ? <RunActivityPanel summaries={summaries} summariesReadAt={summariesReadAt} /> : null}
          </ActivitiesPopover>
          <Dialog open={current && locationOpen} onOpenChange={setLocationOpen} title="Execution folder" closeLabel="Close execution folder"
            headerLeading={<InfoHint label="Execution folder">Where agents work on files. It applies to future runs; runs already started keep their folder.</InfoHint>}>
            <WorkspaceExecutionLocationSettings workspaceId={workspaceId} presentation="field" />
          </Dialog>
        </div>
      </RunBoardSlot>
      </div>
      {side.view === 'overview' ? <section className="workflow-overview-slot" aria-label="Workflow Overview"
        hidden={side.memoryOpen} inert={side.memoryOpen}>
        {suppliedOverview ? overviewContent : <MasterOverview workspaceId={workspaceId} workflowId={workflowId}
          visible={!side.memoryOpen}
          runId={legacyRun?.runId ?? pickedRunId}
          teamNodeId={side.teamNodeId} onTeam={side.selectTeam}
          onChat={(nodeId, execution) => side.selectPanel({ kind: 'agent', nodeId, tab: 'chat',
            ...(execution ? { executionId: execution.executionId } : {}) })}
          onSettings={nodeId => side.selectPanel({ kind: 'agent', nodeId, tab: 'settings' })}
          onReport={report => showExecution(report.agent.workflowNodeId, report.execution)}
          onExecution={(agent, execution) => showExecution(agent.workflowNodeId, execution)}
          onChooseMaster={current && authoringActions ? () => { side.selectView('graph'); authoringActions.openWorkflowSettings() } : undefined}
          onCurrentWorkflow={() => { void navigationSelection.selectRun(null) }}
          onCard={collaborationSlots?.reportCard} />}
      </section> : null}
      {detailsScope ? <WorkflowBoardContext.Provider value={detailsValue}>
        <ActivitiesPopover open={runsOpen} onClose={() => setRunsOpen(false)} findAnchor={findActivitiesButton}>
          <RunActivityPanel summaries={summaries} summariesReadAt={summariesReadAt} />
        </ActivitiesPopover>
      </WorkflowBoardContext.Provider> : null}
      <WorkflowSidePanel scope={side.scope} workspaceId={workspaceId} workflowId={workflowId}
        workflowVersionId={legacyRun?.workflowVersionId ?? (picked?.kind === 'available' ? picked.workflowVersionId : undefined)}
        opener={side.opener} runId={legacyRun?.runId ?? pickedRunId} selection={side.panel} agentSelection={side.agentSelection} onSelect={side.selectPanel} bodyRef={setSidePanelHost}
        onSelectTarget={side.selectChatTarget} onSelectRun={side.selectChatRun}
        modalOpen={side.memoryOpen} slots={{ ...collaborationSlots, groupChat: collaborationSlots?.groupChat ?? (() =>
          <GroupChatPanel workspaceId={workspaceId} workflowId={workflowId} runId={legacyRun?.runId ?? pickedRunId} onSelect={side.selectPanel} />) }} />
      </div>
      {collaborationSlots?.memoryBoard
        ? <WorkflowMemoryDialog open={side.memoryOpen} onOpenChange={side.setMemoryOpen} slots={collaborationSlots} />
        : side.memoryOpen && <MemoryBoardSurface scope={{ kind: 'workflow', workspaceId, workflowId }}
          scopeName="Workflow" dialog={{ open: true, onOpenChange: side.setMemoryOpen, historicalRun: Boolean(legacyRun || pickedRunId) }} />}
    </div>
  </WorkflowBoardContext.Provider>
}

function RunContextLabel({ scope }: { scope: RepeatGraphScopeV3 }) {
  return <span>Run <code title={scope.runId}>{shortRunId(scope.runId)}</code></span>
}
