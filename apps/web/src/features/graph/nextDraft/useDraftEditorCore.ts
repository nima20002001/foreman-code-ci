import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useQueryClient } from '@tanstack/react-query'
import { sameAuthoredWorkflow, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { ToastContext } from '../../../shared/ui/nocturne/toastContext'
import { UnsavedChangesContext } from '../../../shared/ui/unsavedChanges'
import { useGraphPresentationStore } from '../useGraphPresentation'
import { applyGraphGeometry, type GraphGeometryChange } from '../geometry'
import { useGraphDraftStore } from '../store'
import { boardScope, clearBoardRedo } from '../../workflow-board/boardUndo'
import type { useWorkflowBoard } from '../../workflow-board/context'
import type { WorkflowNameHandle } from '../../workflow-board/WorkflowName'
import type { DraftCanvasHandle, OpenAgentPanel } from './DraftCanvas'
import { useDraftLayout } from './useDraftLayout'
import type { useGraphEditIntent } from './useGraphEditIntent'
import type { NextDraftEdit } from './state'
import { draftFailure } from './writer'
import { scheduleCommandOwner } from '../../schedules/queries'

export type Panel = 'workflow' | 'agents' | 'repeat' | null

/** Panel, message and selection state plus the callbacks every editor concern shares. */
export function useDraftEditorCore({ draftKey, edit, editIntent, board }: {
  draftKey: string
  edit: NextDraftEdit
  editIntent: ReturnType<typeof useGraphEditIntent>
  board: ReturnType<typeof useWorkflowBoard>
}) {
  const graph = edit.graph
  const queryClient = useQueryClient()
  const guard = useContext(UnsavedChangesContext)
  const [panel, setPanel] = useState<Panel>(null)
  const settingsPanel = useRef<HTMLElement>(null)
  const workflowName = useRef<WorkflowNameHandle>(null)
  const openSaveField = (path: (string | number)[]) => {
    flushSync(() => setPanel('workflow'))
    let field = 'limits'
    if (path[0] === 'approval') {
      field = path[1] === 'designatedOrchestratorAgentId' ? 'orchestrator' : 'approval'
    } else if (path[0] === 'entryNodeId') {
      field = 'entry'
    } else if (path[0] === 'executionPolicy' && path[1] === 'maxNodeExecutions') {
      field = 'executions'
    } else if (path[0] === 'executionPolicy' && path[1] === 'agentActiveTimeoutMs') {
      field = 'active-time'
    }
    settingsPanel.current?.querySelector<HTMLElement>(`[data-save-field="${field}"]`)?.focus()
  }
  const [openNode, setOpenNode] = useState<OpenAgentPanel>()
  const [confirm, setConfirm] = useState<'save' | 'discard' | 'reload'>()
  const runAfterSave = useRef(false)
  const [message, setMessage] = useState<string>()
  const [localError, setLocalError] = useState<string>()
  const [, setGeometryPending] = useState(false)
  const layout = useDraftLayout(draftKey)
  const toast = useContext(ToastContext)
  const layoutFailure = layout.journalError ?? (layout.isError ? layout.error?.message ?? 'Layout could not be saved.' : undefined)
  const retryLayout = layout.mutate
  // Layout is presentation only: it saves silently, also during a Run; only a real failure is reported, unobtrusively.
  useEffect(() => {
    if (layoutFailure) toast?.notify({ title: 'Node layout was not saved.', description: layoutFailure, tone: 'warning',
      action: { label: 'Retry', onClick: () => retryLayout() } })
  }, [layoutFailure, toast, retryLayout])
  const alive = useRef(true)
  const latestBoard = useRef(board)
  latestBoard.current = board
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => setMessage(undefined), 6000)
    return () => window.clearTimeout(timer)
  }, [message])
  const canvas = useRef<DraftCanvasHandle>(null)
  const presentation = useGraphPresentationStore()
  const linkedAgent = board?.selectedAgentId
  const linkedSelection = !!board?.selectDraftAgent
  useLayoutEffect(() => {
    if (!linkedSelection) return
    const node = linkedAgent ? useGraphDraftStore.getState().nextDrafts[draftKey]?.graph.nodes.find((item) => item.kind!=='job' && item.agentId === linkedAgent) : undefined
    presentation.getState().setFocusedNodeId(node?.id)
    presentation.getState().setSelectedNodeIds(new Set(node ? [node.id] : []))
    if (node) presentation.getState().setFocusedEdgeId(undefined)
    // URL changes project selection only; neither polling nor Run selection replaces the draft.
  }, [linkedAgent, draftKey, presentation, linkedSelection])
  const change = useCallback((update: (graph: WorkflowDefinitionV3) => WorkflowDefinitionV3) => {
    const schedule = scheduleCommandOwner(queryClient, { workspaceId: graph.workspaceId, workflowId: graph.id })
    if ((schedule.pending || schedule.unconfirmed) && schedule.state?.variables?.history) {
      setLocalError('Confirm the pending schedule change before editing the Board.')
      return
    }
    useGraphDraftStore.getState().changeNextDraft(draftKey, (value) => {
      const next = update(value)
      if (editIntent.locked && !sameAuthoredWorkflow(value, next)) {
        setLocalError('Saving is still in progress. You can move agents, but other edits wait until it finishes or you discard it.')
        return value
      }
      return next
    }); setMessage(undefined)
    clearBoardRedo(boardScope(graph.workspaceId, graph.id))
  }, [draftKey, editIntent.locked, graph.workspaceId, graph.id, queryClient])
  const persistLayout = layout.mutate
  const geometry = useCallback((changes: GraphGeometryChange[]) => {
    change((value) => applyGraphGeometry(value, changes))
    // Only independent layout revisions are written. Semantic staging is untouched.
    persistLayout()
  }, [change, persistLayout])
  const report = useCallback((error: unknown) => setLocalError(draftFailure(error, false).message), [])
  const inspect = useCallback((action: () => void) => {
    void (async () => {
      if (guard && !await guard.surfaces()) return
      if (!alive.current) return
      // The add-Agent panel is a container the person keeps open while working on the Board: selecting a node or
      // clicking the canvas leaves it be, and only its own X, Escape or an explicit panel choice closes it.
      canvas.current?.flush(); setPanel((current) => current === 'agents' ? current : null); action()
      const id = presentation.getState().focusedNodeId
      const selectedNode = useGraphDraftStore.getState().nextDrafts[draftKey]?.graph.nodes.find((node) => node.id === id)
      const agentId = selectedNode?.kind!=='job'?selectedNode?.agentId:undefined
      if (latestBoard.current?.selectedAgentId !== agentId) latestBoard.current?.selectDraftAgent?.(agentId)
    })()
  }, [guard, presentation, draftKey])
  const openPanel = (next: Panel) => inspect(() => {
    presentation.getState().setFocusedNodeId(undefined); presentation.getState().setFocusedEdgeId(undefined); setPanel(next)
  })
  const prepare = async (action: () => void | Promise<unknown>) => {
    if (!guard || await guard.surfaces()) await action()
  }
  return { guard, panel, setPanel, settingsPanel, workflowName, openSaveField, openNode, setOpenNode, confirm, setConfirm, runAfterSave,
    message, setMessage, localError, setLocalError, setGeometryPending, layout, alive, latestBoard, canvas, presentation,
    change, geometry, report, inspect, openPanel, prepare }
}
export type DraftEditorCore = ReturnType<typeof useDraftEditorCore>
