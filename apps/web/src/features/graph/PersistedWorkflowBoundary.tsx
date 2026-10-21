import { useEffect, useState } from 'react'
import { useIsMutating, useQuery } from '@tanstack/react-query'
import { WorkflowDefinitionV3Schema } from '@foreman-code/contracts/wave25'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { boardDraftContextKey } from '../workflow-board/keys'
import { NextDraftEditor } from './nextDraft/NextDraftEditor'
import { nextDraftApi } from './nextDraft/transport'
import { nextDraftKey } from './nextDraft/state'
import { useGraphDraftStore } from './store'
import { editIntentCommandKey } from './nextDraft/useGraphEditIntent'
import type { BoardUpdateFailure } from '../workflow-board/BoardAlerts'
import { useWorkflowBoard } from '../workflow-board/context'
import { BoardLoading } from '../workflow-board/BoardLoading'

/** Persisted execution tags are explicit. No default, conversion, complexity
 * selector or fallback can open an executable editor for a retired record. */
export function PersistedWorkflowBoundary({ workspaceId, workflowId, workflow, updateFailures }: {
  workspaceId: string; workflowId: string; workflow: unknown; updateFailures?: readonly BoardUpdateFailure[]
}) {
  const parsed = WorkflowDefinitionV3Schema.safeParse(workflow)
  if (!parsed.success || parsed.data.workspaceId !== workspaceId || parsed.data.id !== workflowId) {
    return <section role="alert" className="workflow-graph-state workflow-graph-state-error">
      <h2>Authoring unavailable</h2><p>The saved workflow is unavailable or has a retired or unsupported execution tag. No executable editor or Start was dispatched.</p>
    </section>
  }
  return <AuthoringBoundary workspaceId={workspaceId} workflowId={workflowId} updateFailures={updateFailures} />
}
function AuthoringBoundary({ workspaceId, workflowId, updateFailures = [] }: { workspaceId: string; workflowId: string; updateFailures?: readonly BoardUpdateFailure[] }) {
  const authoringActive = useWorkflowBoard()?.authoringActive !== false
  const key = nextDraftKey(workspaceId, workflowId)
  const edit = useGraphDraftStore((state) => state.nextDrafts[key])
  const saving = useIsMutating({ mutationKey: editIntentCommandKey(key), exact: true }) > 0
  const source = useQuery({ queryKey: boardDraftContextKey(workspaceId, workflowId),
    queryFn: ({ signal }) => nextDraftApi.context(workspaceId, workflowId, { signal }),
    enabled: authoringActive, staleTime: 3000, refetchInterval: authoringActive ? 3000 : false,
    refetchOnWindowFocus: authoringActive, retry: false,
  })
  const [updatesUnavailable, setUpdatesUnavailable] = useState(false)
  useEffect(() => {
    setUpdatesUnavailable(false)
    if (!source.isError) return
    const timer = window.setTimeout(() => setUpdatesUnavailable(true), 5_000)
    return () => window.clearTimeout(timer)
  }, [key, source.isError])
  const denied = useProtectedAccessError(source)
  if (denied) return <section role="alert">Draft access is unavailable. Retained local edits have not been replaced or discarded.</section>
  // Polling only reports drift. It never installs a server graph over local work.
  if (edit || source.data && !source.isError) {
    // The save acknowledgement can advance the editor before its draft query refetch finishes.
    const changed = !saving && edit && source.data && (source.data.draft.id !== edit.context.draft.id
      || source.data.draft.revision > edit.context.draft.revision)
    return <>
      {changed ? <p role="status">The shared draft changed elsewhere. Your local edits and original revision are retained; reload explicitly before overwriting anything.</p> : null}
      <NextDraftEditor key={key} workspaceId={workspaceId} workflowId={workflowId} initialContext={source.data}
        updateFailures={[...updateFailures, ...(source.isError && updatesUnavailable ? [{ id: 'DRAFT_UPDATES_UNAVAILABLE',
          message: 'Draft updates unavailable. Running requires a fresh saved read.', pending: source.isFetching, retry: () => void source.refetch() }] : [])]} />
    </>
  }
  if (source.isPending) return <BoardLoading />
  return <section role="alert"><p>Authoring could not be opened. No saved data was reinterpreted.</p>
    <button type="button" onClick={() => void source.refetch()}>Retry authoring</button></section>
}
