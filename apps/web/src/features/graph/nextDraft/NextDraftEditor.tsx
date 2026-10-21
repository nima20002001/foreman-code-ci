import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { GraphDraftV3Schema, sameAuthoredWorkflow } from '@foreman-code/contracts/wave25'
import { errorMessage } from '../../../shared/errorMessage'
import { Button } from '../../../shared/ui/nocturne'
import { GraphPresentationProvider } from '../GraphPresentation'
import { useGraphDraftStore } from '../store'
import { hasLocalChanges } from './model'
import { nextDraftKey, type NextDraftEdit } from './state'
import { nextDraftApi, type AuthoringContext } from './transport'
import { claimEditTabOwnership, readEditSnapshot } from './editIntentStorage'
import { type BoardUpdateFailure } from '../../workflow-board/BoardAlerts'
import { boardDraftContextKey } from '../../workflow-board/keys'
import { BoardLoading } from '../../workflow-board/BoardLoading'
import { useDraftEditorController } from './useDraftEditorController'
import { DraftEditorView } from './DraftEditorView'
import '../graph.css'
import './nextDraft.css'

/** Authoring adapter within the workspace board. Selected Run is NOT an editor key. */
export function NextDraftEditor({ workspaceId, workflowId, initialContext, updateFailures }: {
  workspaceId: string; workflowId: string; initialContext?: AuthoringContext; updateFailures?: readonly BoardUpdateFailure[]
}) {
  const key = nextDraftKey(workspaceId, workflowId)
  return <GraphPresentationProvider key={key}><DraftLoader draftKey={key} workspaceId={workspaceId} workflowId={workflowId} initialContext={initialContext} updateFailures={updateFailures} /></GraphPresentationProvider>
}

function DraftLoader({ draftKey, workspaceId, workflowId, initialContext, updateFailures }: {
  draftKey: string; workspaceId: string; workflowId: string; initialContext?: AuthoringContext; updateFailures?: readonly BoardUpdateFailure[]
}) {
  const edit = useGraphDraftStore((state) => state.nextDrafts[draftKey])
  const [storageError, setStorageError] = useState<string>()
  const [ownershipReady, setOwnershipReady] = useState(false)
  useEffect(() => {
    let mounted = true
    void claimEditTabOwnership().then(() => {
      if (mounted) setOwnershipReady(true)
    }).catch(error => {
      if (mounted) setStorageError(errorMessage(error, 'Independent tab recovery is unavailable.'))
    })
    return () => { mounted = false }
  }, [])
  const source = useQuery({ queryKey: boardDraftContextKey(workspaceId, workflowId),
    queryFn: ({ signal }) => nextDraftApi.context(workspaceId, workflowId, { signal }),
    initialData: initialContext, enabled: !edit && !storageError, retry: false,
  })
  useEffect(() => {
    if (!ownershipReady || useGraphDraftStore.getState().nextDrafts[draftKey]) return
    try {
      const snapshot = readEditSnapshot(draftKey)
      if (snapshot && !initialContext && !source.isFetchedAfterMount && !source.isError) return
      const fresh = source.data && !source.isError ? source.data.draft : undefined
      // A snapshot of an older saved base is superseded when it was clean or its
      // meaning is exactly what has since been saved. Remote hydration waits for
      // its exact journal result rather than substituting current mutable Agent heads.
      // Retained Agent edits are never superseded by a newer saved workflow: they
      // belong to shared Agents, not the graph, and need explicit save or discard.
      const agentEdited = Object.keys(snapshot?.agentEdits ?? {}).length > 0 || Object.keys(snapshot?.agentForms ?? {}).length > 0
      const stale = snapshot && !snapshot.remoteEditIntent && !agentEdited && fresh && (snapshot.context.draft.baseWorkflowVersionId !== fresh.baseWorkflowVersionId
        || snapshot.context.draft.publishedRevision !== fresh.publishedRevision
        || !sameAuthoredWorkflow(snapshot.context.draft.graph, fresh.graph))
        && (!hasLocalChanges(snapshot.context, snapshot.graph) || sameAuthoredWorkflow(snapshot.graph, fresh.graph))
      const retained = stale ? undefined : snapshot
      if (retained) {
        // Retained forms keep only their own Agents; the rest of the catalog comes from the server.
        const catalog = new Map([...(source.data?.agents ?? []), ...retained.context.agents].map((record) => [record.agent.id, record]))
        useGraphDraftStore.getState().installNextDraft(draftKey, { ...retained.context, agents: [...catalog.values()] })
        useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => ({ ...state,
          graph: retained.graph, agentEdits: retained.agentEdits, agentForms: retained.agentForms, remoteEditIntent: retained.remoteEditIntent }))
      } else if (source.data && !source.isError) {
        useGraphDraftStore.getState().installNextDraft(draftKey, { draft: GraphDraftV3Schema.parse(source.data.draft), agents: source.data.agents, savedDraft: source.data.savedDraft })
      }
    } catch (error) { setStorageError(errorMessage(error, 'Retained edits are unavailable.')) }
  }, [draftKey, initialContext, ownershipReady, source.data, source.isError, source.isFetchedAfterMount])
  if (edit) return <EditorForm draftKey={draftKey} edit={edit} updateFailures={updateFailures} />
  if (storageError || source.isError) return <section className="workflow-graph-state" role="alert">
    <h2>Authoring unavailable</h2><p>{storageError ?? source.error?.message}</p>
    {!storageError ? <Button onClick={() => void source.refetch()}>Try again</Button> : null}
  </section>
  return <BoardLoading />
}

function EditorForm({ draftKey, edit, updateFailures }: { draftKey: string; edit: NextDraftEdit; updateFailures?: readonly BoardUpdateFailure[] }) {
  const controller = useDraftEditorController(draftKey, edit)
  return <DraftEditorView draftKey={draftKey} edit={edit} updateFailures={updateFailures} controller={controller} />
}
