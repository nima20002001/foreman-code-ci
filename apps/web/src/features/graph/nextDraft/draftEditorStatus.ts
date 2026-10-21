import type { useManagedWorkspaceQuery } from '../../../shared/api/query'
import { boardStartPins } from '../../workflow-board/startPreflight'
import { canUndoNextDraft, nextDraftDirty, type NextDraftEdit } from './state'
import type { editorAgents } from './agentEdits'
import type { Panel } from './useDraftEditorCore'
import type { DraftStartState } from './useDraftStart'
import type { useGraphEditIntent } from './useGraphEditIntent'

/** Save/Start/undo availability and the user-facing reasons derived from the draft and its Start state. */
export function deriveDraftEditorStatus({ edit, editIntent, agents, startState, starting, reloading, undoAction, redoCount, localError, workspace, panel }: {
  edit: NextDraftEdit
  editIntent: ReturnType<typeof useGraphEditIntent>
  agents: ReturnType<typeof editorAgents>
  startState: DraftStartState
  starting: boolean
  reloading: boolean
  undoAction: unknown
  redoCount: number
  localError: string | undefined
  workspace: ReturnType<typeof useManagedWorkspaceQuery>
  panel: Panel
}) {
  const graph = edit.graph, context = edit.context
  const { preflight, canStart, startOutbox, storageFailed, pendingStart } = startState
  const dirty = nextDraftDirty(edit)
  const needsSave = dirty || !context.draft.baseWorkflowVersionId
  const canUndo = canUndoNextDraft(edit) || !!undoAction
  const canRedo = (edit.future?.length ?? 0) > 0 || redoCount > 0
  const startReloadRequired = !!edit.startCanceled
    || (!!edit.startRejectedVersionId && edit.startRejectedVersionId === context.draft.baseWorkflowVersionId)
  let preflightReason: string | undefined
  try {
    if (preflight.isError) throw preflight.error
    if (!preflight.data) throw new Error('Checking saved workflow and runtime availability…')
    boardStartPins(context.draft, preflight.data)
  } catch (error) { preflightReason = error instanceof Error ? error.message : 'Saved Start pins are unavailable.' }
  const retiredHarness = agents.some(agent => graph.nodes.some(node => node.kind !== 'job' && node.agentId === agent.id)
    && (agent.harness === 'opencode' || agent.harnessConfiguration?.harness === 'opencode'))
  const startDisabled = retiredHarness || !canStart || storageFailed || starting || reloading || (!pendingStart && (!graph.nodes.length || (!needsSave && !!preflightReason) || startReloadRequired || editIntent.locked
    || edit.busy || !!edit.pending))
  const startReason = retiredHarness ? 'Retired harness (OpenCode): read-only' : !canStart ? 'Start permission is unavailable for this workflow' : pendingStart ? 'Reconcile the exact earlier Start command' : startReloadRequired ? 'Reload after the saved version was rejected'
    : !graph.nodes.length ? 'Add an agent before saving and running' : needsSave ? 'Save and run' : preflightReason ?? 'Run the saved workflow'
  const saveBusy = edit.busy || reloading || !!edit.pending || !!pendingStart || editIntent.mutation.isPending
  // Workflow-local Run summaries cannot describe blockers of a shared-Agent edit.
  // Stage/reconcile first; ask for Stop only for that exact authoritative set.
  const affectedRuns = editIntent.query.data?.current.filter((item) => !item.settled) ?? []
  const affectedWorkflows = new Set(affectedRuns.map((item) => item.pin.workflowId)).size
  const stopBlocked = !!editIntent.query.data?.affectedSetChanged || (affectedRuns.length > 0 && !editIntent.query.data?.canStop)
  const rawErrorText = edit.error ? edit.error.message : startOutbox.error ?? localError
  // The save alert already shows the edit-intent failure; do not repeat it.
  const errorText = rawErrorText && rawErrorText === editIntent.mutation.error?.message ? undefined : rawErrorText
  const locationValidation = workspace.data?.locationValidation
  let locationMessage = 'Choose an execution folder to run this workflow.'
  if (locationValidation?.status === 'restricted') locationMessage = 'Execution folder access is restricted.'
  else if (locationValidation?.status === 'unavailable') locationMessage = locationValidation.error.message
  const panelTitle = panel === 'workflow' ? 'Workflow settings' : ''
  return { dirty, needsSave, canUndo, canRedo, startReloadRequired, startDisabled, startReason, saveBusy, affectedRuns, affectedWorkflows,
    stopBlocked, errorText, locationMessage, panelTitle }
}
export type DraftEditorStatus = ReturnType<typeof deriveDraftEditorStatus>
