import { useLayoutEffect, useMemo } from 'react'
import { authoringHints } from './model'
import { editorAgents } from './agentEdits'
import { type NextDraftEdit } from './state'
import { useGraphEditIntent } from './useGraphEditIntent'
import { useInteractionsQuery, useManagedWorkspaceQuery, useManagedWorkflowQuery } from '../../../shared/api/query'
import { useWorkflowBoard } from '../../workflow-board/context'
import { boardScope, publishDraftDepth, useBoardUndo } from '../../workflow-board/boardUndo'
import { useDraftEditorCore } from './useDraftEditorCore'
import { useDraftEditorSave } from './useDraftEditorSave'
import { useDraftStartMutation, useDraftStartState } from './useDraftStart'
import { useDraftUnsavedGuard } from './useDraftUnsavedGuard'
import { deriveDraftEditorStatus } from './draftEditorStatus'
import { useDraftEditorHistory } from './useDraftEditorHistory'
import { useDraftAgentPanels } from './useDraftAgentPanels'
import { useScheduleCommand } from '../../schedules/queries'

export function useDraftEditorController(draftKey: string, edit: NextDraftEdit) {
  const graph = edit.graph
  const context = edit.context
  const board = useWorkflowBoard()
  const editIntent = useGraphEditIntent(draftKey, edit)
  const undoScope = boardScope(graph.workspaceId, graph.id)
  const scheduleWrite = useScheduleCommand({ workspaceId: graph.workspaceId, workflowId: graph.id })
  const historyPending = useBoardUndo(state => !!state.pending[undoScope])
  useLayoutEffect(() => { publishDraftDepth(undoScope, edit.history.length + (edit.historyOffset ?? 0)) }, [undoScope, edit.history.length, edit.historyOffset])
  const undoAction = useBoardUndo((state) => state.actions[undoScope]?.at(-1))
  const redoCount = useBoardUndo((state) => state.redo[undoScope]?.length ?? 0)
  const core = useDraftEditorCore({ draftKey, edit, editIntent, board })
  const startState = useDraftStartState({ draftKey, edit, board })
  const { preflight, pendingStart } = startState
  const saveActions = useDraftEditorSave({ draftKey, edit, editIntent, core, pendingStart })
  const { reloading, stopAndSave, discardChanges, reload } = saveActions
  const { startMutation, starting, start, recoverStart } = useDraftStartMutation({
    draftKey, edit, editIntent, core, startState, stopAndSave,
  })
  useDraftUnsavedGuard({
    draftKey, edit, editIntent, saveActions, pendingStart, starting, localError: core.localError, start, scheduleWrite,
  })
  const workspace = useManagedWorkspaceQuery(graph.workspaceId)
  const managedWorkflow = useManagedWorkflowQuery(graph.workspaceId, graph.id)
  const approvals = useInteractionsQuery({ workspaceId: graph.workspaceId, workflowId: graph.id, status: 'pending', limit: 100 })
  const pendingApprovals = approvals.data?.items.filter((item) => item.approval.handler === 'user').length
  const agents = useMemo(() => editorAgents(edit), [edit])
  const hints = useMemo(() => authoringHints(graph, context, edit.agentEdits), [graph, context, edit.agentEdits])
  const status = deriveDraftEditorStatus({
    edit, editIntent, agents, startState, starting, reloading, undoAction, redoCount,
    localError: core.localError, workspace, panel: core.panel,
  })
  const requestSave = () => {
    core.runAfterSave.current = false
    void core.prepare(() => stopAndSave()).catch(core.report)
  }
  const historyAction = useDraftEditorHistory({
    draftKey, undoScope, board, editIntent, core, saveBusy: status.saveBusy, starting, schedule: scheduleWrite,
  })
  const { openAgent, panels } = useDraftAgentPanels({ draftKey, edit, editIntent, core, board, reloading, agents })
  return {
    graph, context, board, editIntent, undoScope, core, preflight, pendingStart,
    reloading, stopAndSave, discardChanges, reload, startMutation, starting, start, recoverStart,
    workspace, managedWorkflow, pendingApprovals, agents, hints, status, requestSave, historyAction, openAgent, panels,
    scheduleWrite, historyPending,
  }
}
