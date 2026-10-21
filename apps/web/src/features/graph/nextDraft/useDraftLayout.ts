import { useEffect } from 'react'
import { create } from 'zustand'
import { useMutation } from '@tanstack/react-query'
import { z } from 'zod'
import { CurrentWorkflowSaveInputSchema, CurrentWorkflowSaveResultSchema, CURRENT_WORKFLOW_ROUTES,
  sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { apiClient, ApiError } from '../../../shared/api/client'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { useGraphDraftStore } from '../store'
import { nextDraftApi } from './transport'

const JournalSchema = z.object({ request: CurrentWorkflowSaveInputSchema, nodeId: z.string(), rejectedRevision: z.boolean() }).strict()
const journalViews = create<{ values: Record<string, { retained: boolean; error?: string }> }>(() => ({ values: {} }))
function refreshView(key: string) {
  let view: { retained: boolean; error?: string }
  try { view = { retained: !!read(key) } } catch { view = { retained: true, error: 'The retained layout command cannot be read safely. It has not been replaced.' } }
  journalViews.setState((state) => ({ values: { ...state.values, [key]: view } }))
}
const keyFor = (key: string) => protectedKey('outbox', `current-board-layout:${key}`)
const message = 'Layout storage is unavailable. Positions remain local; no replacement request was sent.'
function read(key: string) {
  const raw = localStorage.getItem(keyFor(key))
  return raw === null ? undefined : JournalSchema.parse(JSON.parse(raw))
}
function retain(key: string, journal: z.infer<typeof JournalSchema>) {
  const raw = JSON.stringify(JournalSchema.parse(journal))
  localStorage.setItem(keyFor(key), raw)
  if (localStorage.getItem(keyFor(key)) !== raw) throw new Error(message)
  refreshView(key)
}
function clear(key: string, journal: z.infer<typeof JournalSchema>) {
  if (!sameWorkflowValue(read(key), journal)) throw new Error('The layout journal changed; it was not cleared.')
  localStorage.removeItem(keyFor(key))
  if (localStorage.getItem(keyFor(key)) !== null) throw new Error(message)
  refreshView(key)
}

/** Presentation-only writes use the current complete-definition service.
 * No semantic revision, WorkflowVersion, Stop or Run is created by a drag.
 * A lost response retains the exact command; only a definitive revision rejection
 * permits an explicit retry to read a fresh saved definition and reserve a new command. */
export function useDraftLayout(draftKey: string) {
  const view = journalViews((state) => state.values[draftKey])
  useEffect(() => {
    const update = () => refreshView(draftKey)
    update(); window.addEventListener('storage', update)
    return () => window.removeEventListener('storage', update)
  }, [draftKey])
  const mutation = useMutation({ retry: false, scope: { id: `board-layout:${draftKey}` }, mutationFn: async () => {
    const generation = sessionGeneration()
    const instance = useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId
    if (!navigator.locks) throw new Error('Safe layout storage is unavailable in this browser. Positions are kept locally.')
    await navigator.locks.request(keyFor(draftKey), async () => {
      assertSession(generation)
      let journal = read(draftKey)
      for (let count = 0; count < 1000; count++) {
        assertSession(generation)
        const edit = useGraphDraftStore.getState().nextDrafts[draftKey]
        if (!edit || edit.instanceId !== instance) return
        const draft = edit.context.draft
        if (draft.graph.executionSemanticsVersion !== 3) throw new Error('Retired workflow layouts cannot be written.')
        if (journal && (journal.request.workspaceId !== draft.workspaceId
          || journal.request.workflowId !== draft.workflowId)) throw new Error('A retained layout belongs to a different draft. No layout was sent.')
        if (journal?.rejectedRevision) {
          // This branch runs only after a previous explicit attempt received a definitive 409.
          // A transport error never reaches this branch.
          const fresh = await nextDraftApi.layoutBase(draft.workspaceId, draft.workflowId)
          assertSession(generation)
          if (useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId !== instance) return
          if (fresh.draft.revision !== draft.revision || fresh.draft.baseWorkflowVersionId !== draft.baseWorkflowVersionId) {
            throw new Error('The saved workflow changed. Reload before saving positions.')
          }
          clear(draftKey, journal); journal = undefined
          continue
        }
        if (!journal) {
          const moved = edit.graph.nodes.find((node) => draft.graph.nodes.some((base) =>
            base.id === node.id && !sameWorkflowValue(
              { position: base.position, width: base.width, height: base.height },
              { position: node.position, width: node.width, height: node.height })))
          if (!moved) return // Newly authored nodes publish their initial geometry with Save.
          // Read the persisted meaning, never send locally staged executable edits.
          const saved = await nextDraftApi.layoutBase(draft.workspaceId, draft.workflowId)
          assertSession(generation)
          if (saved.draft.revision !== draft.revision || saved.draft.baseWorkflowVersionId !== draft.baseWorkflowVersionId) {
            throw new Error('The saved workflow changed. Reload before saving positions.')
          }
          const graph = { ...saved.draft.graph, nodes: saved.draft.graph.nodes.map((node) =>
            node.id === moved.id ? { ...node, position: moved.position, width: moved.width, height: moved.height } : node) }
          journal = { request: CurrentWorkflowSaveInputSchema.parse({ workspaceId: draft.workspaceId,
            workflowId: draft.workflowId, commandId: crypto.randomUUID(), executionSemanticsVersion: 3,
            expectedRevision: draft.revision, expectedWorkflowVersionId: draft.baseWorkflowVersionId,
            expectedAgentConfigurationVersionIds: saved.expectedAgentConfigurationVersionIds,
            graph }), nodeId: moved.id, rejectedRevision: false }
          retain(draftKey, journal) // durable before HTTP
        }
        const request = journal.request
        const nodeId = journal.nodeId
        try {
          const result = await apiClient.request(CURRENT_WORKFLOW_ROUTES.saved
            .replace(':workspaceId', encodeURIComponent(request.workspaceId)).replace(':workflowId', encodeURIComponent(request.workflowId)),
          CurrentWorkflowSaveResultSchema, { method: 'PUT', body: request })
          assertSession(generation)
          if (result.value.workspaceId !== request.workspaceId || result.value.workflowId !== request.workflowId
            || result.value.revision !== request.expectedRevision || result.value.currentVersionId !== request.expectedWorkflowVersionId) {
            throw new Error('The layout acknowledgement does not match the exact saved workflow.')
          }
          const acknowledged = request.graph.nodes.find((node) => node.id === nodeId)
          if (useGraphDraftStore.getState().nextDrafts[draftKey]?.instanceId !== instance) return
          // Acknowledge only presentation fields. Never replace meaning or a newer local drag.
          useGraphDraftStore.getState().updateNextDraft(draftKey, (current) => ({ ...current,
            context: { ...current.context, draft: { ...current.context.draft,
              graph: { ...current.context.draft.graph, nodes: current.context.draft.graph.nodes.map((node) =>
                node.id === nodeId && acknowledged ? { ...node, position: acknowledged.position,
                  width: acknowledged.width, height: acknowledged.height } : node) } } } }))
          clear(draftKey, journal); journal = undefined
        } catch (error) {
          assertSession(generation)
          if (ApiError.is(error) && error.status === 409
            && error.code === 'REVISION_CONFLICT') {
            journal = { request, nodeId, rejectedRevision: true }; retain(draftKey, journal)
          }
          throw error
        }
      }
      throw new Error('The layout changed continuously. Retry to reconcile the retained positions.')
    })
  } })
  return { ...mutation, retained: view?.retained ?? false, journalError: view?.error }
}

/** Existing principal teardown only; Discard meaningful edits never calls this. */
export function clearCurrentLayoutJournals() {
  journalViews.setState({ values: {} })
  if (typeof localStorage === 'undefined') return
  try {
    const prefix = keyFor('')
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index)
      if (key?.startsWith(prefix)) localStorage.removeItem(key)
    }
  } catch {
    // ignore: session rotation also makes old protected layout keys inaccessible.
  }
}
