import { useCallback, useRef } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { boardSidePanelFromSearch, type BoardSidePanel, type RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import type { RunsSelectorSearchSchema } from '../runs-selector/search'
import { useSelectedRun } from '../runs-selector/useSelectedRun'
import { useSidePanelPresentation } from './sidePanelPresentation'

/** Navigation belongs to the URL. Drafts and scroll stay in their existing local owners. */
export function useWorkflowSidePanel(workspaceId: string, workflowId: string, run?: RepeatGraphScopeV3) {
  const location = useLocation(), navigate = useNavigate()
  const { generation, isCurrent } = useSelectedRun({ workspaceId, workflowId })
  const search = location.search
  const scope = JSON.stringify([workspaceId, workflowId])
  const opener = useRef<HTMLElement | null>(null)
  const panel = boardSidePanelFromSearch(search)
  const runId = run?.runId
  const workflowVersionId = run?.workflowVersionId
  const executionSemanticsVersion = run?.executionSemanticsVersion
  const keepRun = useCallback((previous: ReturnType<typeof RunsSelectorSearchSchema.parse>) => ({ ...previous, workflowId,
    ...(runId && !previous.runId && !previous.selectedRunId ? { runId,
      workflowVersionId, executionSemanticsVersion } : {}) }),
  [workflowId, runId, workflowVersionId, executionSemanticsVersion])
  const selectPanel = useCallback((next: BoardSidePanel) => {
    if (!isCurrent(generation)) return
    if (panel.kind === 'none' && next.kind !== 'none') {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, hash: true,
      search: previous => {
        if (previous.workflowId && previous.workflowId !== workflowId) return previous
        if (next.kind === 'operator' && previous.boardPanel !== 'operator') {
          useSidePanelPresentation.getState().rememberOperator(scope, boardSidePanelFromSearch(previous))
        }
        const selected = keepRun(previous)
        if (next.kind === 'none') delete selected.boardPanel
        else selected.boardPanel = next.kind
        if (next.kind === 'agent' || next.kind === 'browser') {
          if (next.kind === 'agent' || next.nodeId !== undefined) {
            selected.boardNodeId = next.nodeId
            selected.boardExecutionId = next.executionId
          }
          if (next.kind === 'agent') selected.boardAgentTab = next.tab
        }
        return selected
      } })
  }, [navigate, workspaceId, workflowId, keepRun, scope, panel.kind, generation, isCurrent])
  const closeOperator = useCallback(() => {
    selectPanel(useSidePanelPresentation.getState().beforeOperator[scope] ?? { kind: 'none' })
  }, [scope, selectPanel])
  const selectView = useCallback((view: 'graph' | 'overview') => {
    if (!isCurrent(generation)) return
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, hash: true,
      search: previous => previous.workflowId && previous.workflowId !== workflowId ? previous : ({ ...keepRun(previous), boardView: view }) })
  }, [navigate, workspaceId, workflowId, keepRun, generation, isCurrent])
  const setMemoryOpen = useCallback((open: boolean) => {
    if (!isCurrent(generation)) return
    void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, hash: true,
      search: previous => previous.workflowId && previous.workflowId !== workflowId ? previous : ({ ...keepRun(previous), boardMemory: open ? true : undefined }) })
  }, [navigate, workspaceId, workflowId, keepRun, generation, isCurrent])
  const agentSelection: Extract<BoardSidePanel, { kind: 'agent' }> | undefined = search.boardNodeId
    ? { kind: 'agent', nodeId: search.boardNodeId, tab: search.boardAgentTab ?? 'chat',
      ...(search.boardExecutionId ? { executionId: search.boardExecutionId } : {}) } : undefined
  return { scope, opener, panel, selectPanel, closeOperator, agentSelection, view: search.boardView ?? 'graph', selectView,
    memoryOpen: search.boardMemory === true, setMemoryOpen }
}
