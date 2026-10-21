import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { boardSidePanelFromSearch, readRunInspectionKey, runInspectionKey, type BoardSidePanel, type RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import type { WorkflowExecutionChatTarget } from '@foreman-code/contracts'
import type { RunsSelectorSearchSchema } from '../runs-selector/search'
import { useSelectedRun } from '../runs-selector/useSelectedRun'

/** Navigation belongs to the URL. Drafts and scroll stay in their existing local owners. */
export function useWorkflowSidePanel(workspaceId: string, workflowId: string, run?: RepeatGraphScopeV3,
  beforeBrowserHide?: () => void) {
  const location = useLocation(), navigate = useNavigate()
  const { generation, isCurrent, active, invalid, identity } = useSelectedRun({ workspaceId, workflowId })
  const search = location.search
  const pathname = location.pathname
  const scope = JSON.stringify([workspaceId, workflowId])
  const opener = useRef<HTMLElement | null>(null)
  const { boardPanel, boardNodeId, boardExecutionId, boardWaitingActivationId, boardAgentTab, browserSessionId, browserTabId } = search
  // Operator chat is the app's floating dialog, never a rail destination, so a stale `boardPanel=operator` link leaves the rail closed.
  const panel = useMemo<BoardSidePanel>(() => boardPanel === 'operator' ? { kind: 'none' }
    : boardSidePanelFromSearch({ boardPanel, boardNodeId, boardExecutionId, boardWaitingActivationId, boardAgentTab, browserSessionId, browserTabId }),
  [boardPanel, boardNodeId, boardExecutionId, boardWaitingActivationId, boardAgentTab, browserSessionId, browserTabId])
  const browserKey = JSON.stringify([workspaceId, workflowId, run?.runId ?? search.selectedRunId ?? search.runId,
    boardNodeId, boardExecutionId])
  const visible = panel.kind === 'browser' && search.boardMemory !== true
  const browser = useRef({ key: browserKey, visible, released: false, release: beforeBrowserHide })
  if (browser.current.key !== browserKey || browser.current.visible !== visible) {
    browser.current = { key: browserKey, visible, released: false, release: beforeBrowserHide }
  } else browser.current.release = beforeBrowserHide
  const browserVisit = browser.current
  const releaseBrowser = useCallback(() => {
    const visit = browser.current
    if (!visit.visible || visit.released) return
    visit.released = true; visit.release?.()
  }, [])
  useEffect(() => () => {
    if (browserVisit.visible && !browserVisit.released) {
      browserVisit.released = true; browserVisit.release?.()
    }
  }, [browserVisit])
  const runId = run?.runId
  const workflowVersionId = run?.workflowVersionId
  const executionSemanticsVersion = run?.executionSemanticsVersion
  const keepRun = useCallback((previous: ReturnType<typeof RunsSelectorSearchSchema.parse>) => ({ ...previous, workflowId,
    ...(runId && workflowVersionId && executionSemanticsVersion && !previous.runId && !previous.selectedRunId
      ? { runId, workflowVersionId, executionSemanticsVersion } : {}) }),
  [workflowId, runId, workflowVersionId, executionSemanticsVersion])
  const selectPanel = useCallback((next: BoardSidePanel, replace = false) => {
    if (!isCurrent(generation)) return
    if (panel.kind === 'browser' && search.boardMemory !== true
      && (next.kind !== 'browser' || next.nodeId !== panel.nodeId || next.executionId !== panel.executionId)) releaseBrowser()
    if (panel.kind === 'none' && next.kind !== 'none') {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    void navigate({ to: pathname, hash: true, replace,
      search: previous => {
        if (previous.workflowId && previous.workflowId !== workflowId) return previous
        const selected = keepRun(previous)
        // The rail owns inspection after a legacy deep link has been opened.
        // Clearing those aliases also makes Back to Board stay closed.
        delete selected.runNodeId; delete selected.runRelationshipId; delete selected.runExchangeKey
        if (next.kind === 'none') delete selected.boardPanel
        else selected.boardPanel = next.kind
        if (next.kind === 'agent' || next.kind === 'browser') {
          if (next.kind === 'agent' || next.nodeId !== undefined) {
            selected.boardNodeId = next.nodeId
            selected.boardExecutionId = next.executionId
            selected.boardWaitingActivationId = next.waitingActivationId
            selected.browserSessionId = next.kind === 'browser' ? next.sessionId : undefined
            selected.browserTabId = next.kind === 'browser' ? next.tabId : undefined
          }
          if (next.kind === 'agent') selected.boardAgentTab = next.tab
        }
        return selected
      } })
  }, [navigate, pathname, workflowId, keepRun, panel, search.boardMemory, releaseBrowser, generation, isCurrent])
  // A Run link that arrives naming a node (and execution) opens that saved node in this rail, which owns the selection
  // afterwards. Only the link the Board was opened with does this: the Run's Activities inspector writes the same
  // fields as its own selection. It runs here, after the selection subscription above is live; a child's effect
  // would run before it and be fenced as stale.
  const linkedNodeId = search.runNodeId, linkedExchange = search.runExchangeKey
  const openLinkedNode = !search.boardPanel && !!linkedNodeId && !!identity.runId && active && !invalid
  const arrivedWithLink = useRef(openLinkedNode)
  useEffect(() => {
    if (!arrivedWithLink.current || !openLinkedNode) return
    arrivedWithLink.current = false
    const { executionId } = readRunInspectionKey(linkedExchange)
    // Replace the link itself, so Back never returns to a link that would open the rail again.
    selectPanel({ kind: 'agent', nodeId: linkedNodeId!, tab: 'details', ...(executionId ? { executionId } : {}) }, true)
  }, [openLinkedNode, linkedNodeId, linkedExchange, selectPanel])
  const selectView = useCallback((view: 'graph' | 'overview') => {
    if (!isCurrent(generation)) return
    void navigate({ to: pathname, hash: true,
      search: previous => previous.workflowId && previous.workflowId !== workflowId ? previous : ({ ...keepRun(previous), boardView: view }) })
  }, [navigate, pathname, workflowId, keepRun, generation, isCurrent])
  const setMemoryOpen = useCallback((open: boolean) => {
    if (!isCurrent(generation)) return
    if (open && panel.kind === 'browser' && search.boardMemory !== true) releaseBrowser()
    void navigate({ to: pathname, hash: true,
      search: previous => previous.workflowId && previous.workflowId !== workflowId ? previous : ({ ...keepRun(previous), boardMemory: open ? true : undefined }) })
  }, [navigate, pathname, workflowId, keepRun, panel.kind, search.boardMemory, releaseBrowser, generation, isCurrent])
  const selectTeam = useCallback((nodeId?: string) => {
    void navigate({ to: pathname, hash: true,
      search: previous => previous.workflowId && previous.workflowId !== workflowId ? previous
        : ({ ...keepRun(previous), boardView: 'overview', boardTeamId: nodeId }) })
  }, [navigate, pathname, workflowId, keepRun])
  const selectExecution = useCallback((target: { runId: string; workflowVersionId: string; nodeId: string; executionId: string }, tab: 'chat' | 'details' = 'details') => {
    releaseBrowser()
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, hash: true,
      search: previous => previous.workflowId && previous.workflowId !== workflowId ? previous : ({ ...previous, workflowId,
        selectedRunId: undefined, runId: target.runId, workflowVersionId: target.workflowVersionId, executionSemanticsVersion: 3,
        boardView: tab === 'details' ? 'graph' : previous.boardView, boardPanel: 'agent', boardAgentTab: tab,
        boardNodeId: target.nodeId, boardExecutionId: target.executionId,
        boardWaitingActivationId: undefined,
        runNodeId: target.nodeId, runRelationshipId: undefined, runExchangeKey: runInspectionKey({ executionId: target.executionId }),
      }) })
  }, [navigate, workspaceId, workflowId, releaseBrowser])
  const selectChatTarget = useCallback((target: WorkflowExecutionChatTarget, versionId: string) => {
    if (target.agent.workspaceId !== workspaceId || target.agent.workflowId !== workflowId) return
    if (target.kind === 'workflow_execution') {
      if (target.execution.workflowVersionId !== versionId) return
      selectExecution({ ...target.execution, nodeId: target.agent.workflowNodeId }, 'chat')
      return
    }
    releaseBrowser()
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, hash: true,
      search: previous => previous.workflowId && previous.workflowId !== workflowId ? previous : ({ ...previous, workflowId,
        selectedRunId: undefined, runId: target.runId, workflowVersionId: versionId, executionSemanticsVersion: 3,
        boardPanel: 'agent', boardAgentTab: 'chat', boardNodeId: target.agent.workflowNodeId,
        boardExecutionId: undefined, boardWaitingActivationId: target.waitingActivationId,
        runNodeId: undefined, runRelationshipId: undefined, runExchangeKey: undefined,
      }) })
  }, [navigate, workspaceId, workflowId, selectExecution, releaseBrowser])
  const selectChatRun = useCallback((target: { runId: string; workflowVersionId: string }) => {
    releaseBrowser()
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, hash: true,
      search: previous => previous.workflowId && previous.workflowId !== workflowId ? previous : ({ ...previous, workflowId,
        selectedRunId: undefined, runId: target.runId, workflowVersionId: target.workflowVersionId, executionSemanticsVersion: 3,
        boardExecutionId: undefined, boardWaitingActivationId: undefined,
        runNodeId: undefined, runRelationshipId: undefined, runExchangeKey: undefined,
      }) })
  }, [navigate, workspaceId, workflowId, releaseBrowser])
  const agentSelection: Extract<BoardSidePanel, { kind: 'agent' }> | undefined = search.boardNodeId
    ? { kind: 'agent', nodeId: search.boardNodeId, tab: search.boardAgentTab ?? 'chat',
      ...(search.boardExecutionId ? { executionId: search.boardExecutionId } : {}),
      ...(search.boardWaitingActivationId ? { waitingActivationId: search.boardWaitingActivationId } : {}) } : undefined
  return { scope, opener, panel, selectPanel, agentSelection, releaseBrowser, view: search.boardView ?? 'graph', selectView,
    memoryOpen: search.boardMemory === true, setMemoryOpen, teamNodeId: search.boardTeamId, selectTeam, selectExecution, selectChatTarget, selectChatRun }
}
