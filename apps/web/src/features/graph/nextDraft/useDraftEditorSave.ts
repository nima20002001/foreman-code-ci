import { useMutation } from '@tanstack/react-query'
import { GraphDraftV3Schema } from '@foreman-code/contracts/wave25'
import { useGraphDraftStore } from '../store'
import { discardMeaningfulChanges } from './model'
import { readEditOutbox } from './editIntentStorage'
import { nextDraftDirty, type NextDraftEdit } from './state'
import { nextDraftApi } from './transport'
import { readBoardStart } from '../../workflow-board/startOutbox'
import type { DraftEditorCore } from './useDraftEditorCore'
import type { useGraphEditIntent } from './useGraphEditIntent'

/** Save (including Stop-and-save), discard and reload of the shared draft. */
export function useDraftEditorSave({ draftKey, edit, editIntent, core, pendingStart }: {
  draftKey: string
  edit: NextDraftEdit
  editIntent: ReturnType<typeof useGraphEditIntent>
  core: DraftEditorCore
  pendingStart: unknown
}) {
  const graph = edit.graph
  const { canvas, setLocalError, setMessage, setConfirm, report } = core
  const reloadMutation = useMutation({ mutationFn: () => nextDraftApi.context(graph.workspaceId, graph.id, undefined, true), retry: false })
  const reloading = reloadMutation.isPending
  const discardLocal = () => {
    const current = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!current || current.busy || current.pending || readBoardStart(draftKey)) throw new Error('Reconcile the in-flight or uncertain command first.')
    // Flush any buffered drag before restoring meaning, so independent layout survives.
    canvas.current?.flush()
    useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => ({ ...state, graph: discardMeaningfulChanges(state.context, state.graph),
      context: { ...state.context, draft: { ...(state.context.savedDraft ?? state.context.draft), layoutRevision: state.context.draft.layoutRevision } },
      history: [], historyOffset: 0, future: [], agentEdits: undefined, agentForms: undefined, agentHistory: undefined, error: undefined, validation: undefined }))
    nextDraftApi.discardLocal(graph.workspaceId, graph.id)
    setLocalError(undefined); setMessage('Changes discarded.')
  }
  const stopAndSave = async (allowStop = false) => {
    if (readBoardStart(draftKey)) throw new Error('Reconcile the exact pending Start before Stop-and-save.')
    canvas.current?.flush(); setLocalError(undefined); setMessage(undefined)
    // Even without a local active Run, graph and shared-Agent changes must be
    // staged together. Only the authoritative saved receipt acknowledges edits.
    const result = allowStop ? await editIntent.advance(true) : await editIntent.save()
    if (!allowStop && result.canStop && !result.affectedSetChanged && result.current.some((item) => !item.settled)) setConfirm('save')
    if (result.intent?.state === 'saved') setMessage(result.intent.stops.length ? 'Saved. Stopped runs were not restarted.' : 'Saved.')
    else if (result.intent?.state === 'blocked' || result.intent?.state === 'uncertain') {
      setLocalError(result.intent.error?.message ?? 'Saving isn’t confirmed yet. Your changes are still here.')
    } else setMessage('Edits retained. Save waits for every affected Run to stop and finish cleanup.')
    return result
  }
  const discardChanges = async () => {
    canvas.current?.flush()
    if (editIntent.locked) {
      const retained = readEditOutbox(draftKey)
      const instanceId = useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId
      const result = await editIntent.discard()
      if (result.intent && result.intent.state !== 'discarded') throw new Error('This intent was not discarded. Read its persisted result before changing the form.')
      if (useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId !== instanceId) throw new Error('The draft instance changed while Discard was acknowledged. The new form is retained.')
      if (retained && result.intent?.stageCommandId === retained.request.commandId
        && result.intent.draftId === retained.request.draftId && result.intent.expectedRevision === retained.request.expectedRevision
        && result.intent.expectedWorkflowVersionId === retained.request.expectedWorkflowVersionId) {
        // The hook already three-way-acknowledged this exact submission. A
        // blanket local discard here would erase independently newer edits.
        setLocalError(undefined); setMessage('Changes discarded. Later edits and agent positions are kept.')
        return
      }
    }
    discardLocal()
  }
  const reload = async (confirmed = false) => {
    if (editIntent.locked) { report(new Error('The private staged payload is retained. Reconcile or discard it before reloading the shared draft.')); return }

    canvas.current?.flush()
    const before = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!before || before.busy || before.pending) return
    if (!confirmed && nextDraftDirty(before)) { setConfirm('reload'); return }
    try {
      const fresh = await reloadMutation.mutateAsync()
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current || current.instanceId !== before.instanceId) return
      if (current.graph !== before.graph || current.agentEdits !== before.agentEdits || current.busy || current.pending) throw new Error('The form changed during reload. Your edits are retained.')
      if (before.startRejectedVersionId && fresh.draft.baseWorkflowVersionId === before.startRejectedVersionId) {
        throw new Error('The saved draft still points to the rejected version. Reload after a newer version is available.')
      }
      useGraphDraftStore.getState().installNextDraft(draftKey, { draft: GraphDraftV3Schema.parse(fresh.draft), agents: fresh.agents, savedDraft: fresh.savedDraft }, true)
      setLocalError(undefined); setMessage(pendingStart ? 'Loaded the saved draft. Confirm the earlier start before starting again.' : 'Loaded the saved draft.')
    } catch (error) { report(error) }
  }
  return { reloading, stopAndSave, discardChanges, reload }
}
