import { InfoHint } from '../../shared/ui/InfoHint'
import { activeRunCandidates } from '@foreman-code/contracts/run-snapshots'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { useLocation, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { WorkflowRunSummary } from '@foreman-code/contracts'
import type { RepeatGraphScopeV3, WorkspaceBoardInspection } from '@foreman-code/contracts/wave25'
import { Button, Dialog } from '../../shared/ui/nocturne'
import { WorkspaceExecutionLocationSettings } from '../settings/WorkspaceExecutionLocationSettings'
import { RunBoardSlot } from '../run-board'
import { runsSelectorApi, useRunSummaries, useSelectedRun, useSelectedRunSnapshot } from '../runs-selector'
import { BoardNavigationControls } from './BoardNavigationControls'
import { CurrentRunObserver } from './CurrentRunObserver'
import { WorkflowBoardContext } from './context'
import { boardLiveRunSnapshotKey } from './keys'
import { ActivitiesPopover } from './ActivitiesPopover'
import { RunActivityPanel } from './RunActivityPanel'
import { shortRunId } from './runFacts'
import { useInspectionPresentation } from './inspect/presentation'
import { useWorkflowSidePanel } from './useWorkflowSidePanel'
import { WorkflowMemoryDialog, WorkflowSidePanel, type WorkflowCollaborationSlots } from './WorkflowSidePanel'
import { useWorkflowOperatorDock } from './operatorDockContext'
import './workflowBoard.css'

/** This component is keyed by workspace/workflow only, NEVER by selected Run. */
export function WorkflowBoard({ workspaceId, workflowId, run: requestedRun, selectRun, inspection, selectInspection, summaries, summariesReadAt, children, selectedAgentId, selectDraftAgent, collaborationSlots }: {
  workspaceId: string; workflowId: string; run?: RepeatGraphScopeV3
  selectedAgentId?: string; selectDraftAgent?(agentId?: string): void
  inspection: WorkspaceBoardInspection; selectInspection(inspection: WorkspaceBoardInspection): void
  selectRun(scope?: RepeatGraphScopeV3): void; summaries: readonly WorkflowRunSummary[]; summariesReadAt?: number; children: ReactNode
  collaborationSlots?: WorkflowCollaborationSlots
}) {
  const location = useLocation()
  const router = useRouter()
  const side = useWorkflowSidePanel(workspaceId, workflowId, requestedRun)
  const [sidePanelHost, setSidePanelHost] = useState<HTMLDivElement | null>(null)
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
    selection.current.generation++
    selectRun(scope)
  }, [selectRun])
  const selectedRun = useSelectedRun({ workspaceId, workflowId })
  const navigationSelection = useMemo(() => ({ ...selectedRun,
    selectRun: (runId: string | null) => {
      selection.current.generation++
      return selectedRun.selectRun(runId)
    },
  }), [selectedRun])
  // Canonical and legacy Run links share the pinned canvas and retained editor.
  const legacyRun = requestedRun?.workspaceId === workspaceId && requestedRun.workflowId === workflowId
    && !location.search.selectedRunId ? requestedRun : undefined
  // A Run picked from Runs opens on this Board (live node cards and their native
  // subagents), not on the separate saved-topology page; only legacy Runs without a
  // captured version stay there.
  const picked = useSelectedRunSnapshot(selectedRun).snapshot
  const pickedRunId = location.search.selectedRunId
  useEffect(() => {
    if (picked?.kind !== 'available' || picked.runId !== pickedRunId || location.pathname.includes('/runs/')) return
    selectRun({ workspaceId, workflowId, runId: picked.runId, workflowVersionId: picked.workflowVersionId, executionSemanticsVersion: 3 })
  }, [picked, pickedRunId, location.pathname, selectRun, workspaceId, workflowId])
  // A live Run takes over the Board so its nodes and native subagents show real
  // state. "Stop showing this run" returns to editing and is not undone.
  const dismissed = useRef(new Set<string>())
  const shownRunId = useRef<string | undefined>(undefined)
  if (shownRunId.current && shownRunId.current !== legacyRun?.runId) dismissed.current.add(shownRunId.current)
  shownRunId.current = legacyRun?.runId
  // Workspace details are a large, rarely refreshed read; the per-workflow Run list is
  // small and polled, so a Run started elsewhere takes over without waiting for details.
  const autoLive = !requestedRun && !pickedRunId && !location.pathname.includes('/runs/')
  const listed = useRunSummaries({ workspaceId, workflowId }, autoLive)
  const candidates = activeRunCandidates(
    summaries.filter(item => item.workspaceId === workspaceId && item.workflowId === workflowId), listed.items,
  )
  // Wait for the first workflow read so an older workspace projection cannot select a completed Run.
  const liveId = autoLive && listed.isSuccess ? candidates.filter(item => !dismissed.current.has(item.id))
    .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0]?.id : undefined
  const liveSnapshot = useQuery({ queryKey: boardLiveRunSnapshotKey(workspaceId, workflowId, liveId),
    queryFn: ({ signal }) => runsSelectorApi.snapshot({ workspaceId, workflowId, runId: liveId! }, { signal }),
    enabled: Boolean(liveId), staleTime: Infinity }).data?.snapshot
  useEffect(() => {
    if (!liveId || liveSnapshot?.kind !== 'available' || liveSnapshot.runId !== liveId) return
    selectRun({ workspaceId, workflowId, runId: liveId, workflowVersionId: liveSnapshot.workflowVersionId, executionSemanticsVersion: 3 })
  }, [liveId, liveSnapshot, selectRun, workspaceId, workflowId])
  const boardSelection = legacyRun ? { ...selectedRun, identity: { ...selectedRun.identity, runId: null } } : selectedRun
  const current = boardSelection.active && !boardSelection.invalid && boardSelection.identity.runId === null
  const currentRef = useRef(current)
  currentRef.current = current
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
    if (open && !currentRef.current) return
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
    if (!current) setRunsOpen(false)
  }, [current, setRunsOpen])
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
    openLocation: () => setLocationOpen(true), openRuns: () => setRunsOpen(true), activeRuns, authoringActive: current,
    navigationControls: current ? <BoardNavigationControls workspaceId={workspaceId} workflowId={workflowId} selection={navigationSelection} /> : undefined,
  }), [workspaceId, workflowId, legacyRun, chooseRun, getSelectionToken, inspection, selectInspection, selectedAgentId, selectDraftAgent, activeRuns, setRunsOpen, setLocationOpen, navigationSelection, current, side.panel, side.agentSelection?.nodeId, side.selectPanel, sidePanelHost, side.memoryOpen])
  const authoringEvent = (event: SyntheticEvent) => {
    if (event.target instanceof Element && event.target.closest('.workflow-side-panel')) return
    // React capture also covers descendants portalled outside the inert subtree.
    if (!currentRef.current) { event.preventDefault(); event.stopPropagation() }
  }
  return <WorkflowBoardContext.Provider value={value}>
    <div ref={toolbar} className="unified-workflow-board" data-testid="unified-workflow-board" style={{ flexDirection: 'column' }}>
      <nav className="workflow-collaboration-toolbar" aria-label="Workflow views">
        <span>{legacyRun || pickedRunId ? 'Selected Run' : 'Editing draft'}</span>
        <Button size="sm" variant="ghost" aria-pressed={side.view === 'graph'} onClick={() => side.selectView('graph')}>Graph</Button>
        <Button size="sm" variant="ghost" aria-pressed={side.view === 'overview'} onClick={() => side.selectView('overview')}>Overview</Button>
        <Button size="sm" variant="ghost" onClick={() => side.setMemoryOpen(true)}>Memory board</Button>
        <Button size="sm" variant="ghost" aria-pressed={side.panel.kind === 'group_chat'} onClick={() => side.selectPanel({ kind: 'group_chat' })}>Group chat</Button>
      </nav>
      {!current ? <header className="board-topbar" aria-label="Board toolbar"
        style={{ position: 'static', flex: '0 0 auto', flexWrap: 'wrap', justifyContent: 'flex-end', padding: 'var(--space-2)', boxSizing: 'border-box', minWidth: 0 }}>
        <BoardNavigationControls workspaceId={workspaceId} workflowId={workflowId} selection={navigationSelection} />
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
      {side.view === 'overview' ? <section className="workflow-overview-slot" aria-label="Workflow Overview">
        {collaborationSlots?.overview?.() ?? <p role="status">Workflow Overview is not available yet.</p>}
      </section> : null}
      <WorkflowSidePanel scope={side.scope} opener={side.opener} runId={legacyRun?.runId ?? pickedRunId} selection={side.panel} agentSelection={side.agentSelection} onSelect={side.selectPanel} bodyRef={setSidePanelHost}
        modalOpen={side.memoryOpen} slots={collaborationSlots} />
      </div>
      <WorkflowMemoryDialog open={side.memoryOpen} onOpenChange={side.setMemoryOpen} slots={collaborationSlots} />
    </div>
  </WorkflowBoardContext.Provider>
}

function RunContextLabel({ scope }: { scope: RepeatGraphScopeV3 }) {
  return <span>Run <code title={scope.runId}>{shortRunId(scope.runId)}</code></span>
}
