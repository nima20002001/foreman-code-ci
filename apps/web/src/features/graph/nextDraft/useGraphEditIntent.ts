import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GraphEditStageInputV3Schema, preserveWorkflowGeometry, sameAuthoredWorkflow, sameWorkflowValue,
  type GraphEditIntentV3, type GraphEditReadResultV3 } from '@foreman-code/contracts/wave25'
import { assertSession, sessionGeneration } from '../../../shared/api/sessionBoundary'
import { queryKeys } from '../../../shared/api/query'
import { useGraphDraftStore } from '../store'
import { boardDraftContextKey } from '../../workflow-board/keys'
import { acknowledgeAgentEdits, hasAgentEdits, stageAgentEdits, referencedAgentEdits } from './agentEdits'
import { draftOperations, hasLocalChanges, mergeAcknowledgement } from './model'
import { readBoardStart } from '../../workflow-board/startOutbox'
import { nextDraftDirty, type NextDraftEdit } from './state'
import { assertDraftSubmission, nextDraftApi } from './transport'
import { acknowledgeEditOutbox, acknowledgeEditSubmission, editSnapshotAcknowledged, editSnapshotSubmitted, matchesEditIntent, readEditOutbox, readEditSubmission,
  rejectEditOutbox, reserveEditOutbox, storeEditSnapshot, withEditIntentLock, type EditIntentOutbox } from './editIntentStorage'

export const activeEditIntent = (intent: GraphEditIntentV3 | null | undefined) => !!intent && !['saved', 'discarded'].includes(intent.state)
/** Shared by every Start surface: a Save/Advance/Discard command is in flight from its first request. */
export const editIntentCommandKey = (draftKey: string) => ['graph-edit-intent-command', draftKey] as const
export const graphEditIntentKey = (workspaceId: string, workflowId: string, draftId: string, generation = sessionGeneration()) =>
  ['graph-edit-intent', generation, workspaceId, workflowId, draftId] as const
const readInput = (edit: NextDraftEdit) => ({ action: 'read_edits' as const, workspaceId: edit.context.draft.workspaceId,
  workflowId: edit.context.draft.workflowId, draftId: edit.context.draft.id })
const commandInput = (intent: GraphEditIntentV3) => ({ workspaceId: intent.workspaceId, workflowId: intent.workflowId,
  draftId: intent.draftId, intentId: intent.id })

const remoteLineage = (intent: GraphEditIntentV3) => ({ id: intent.id, ownerPrincipalId: intent.ownerPrincipalId,
  stageCommandId: intent.stageCommandId, stageInputHash: intent.stageInputHash })
const remoteAgents = (intent: GraphEditIntentV3) =>
  Object.fromEntries((intent.stagedDraft.stagedAgents ?? []).map((item) => [item.agent.id, item.agent]))
function remoteBaseMatches(current: NextDraftEdit, intent: GraphEditIntentV3) {
  const draft = current.context.draft
  return draft.workspaceId === intent.workspaceId && draft.workflowId === intent.workflowId && draft.id === intent.draftId
    && draft.publishedRevision === intent.expectedRevision && draft.baseWorkflowVersionId === intent.expectedWorkflowVersionId
    && intent.agentPins.every((pin) => {
      const source = current.context.agents.find((item) => item.agent.id === pin.agentId)
      return pin.metadataRevision === null ? !source : source?.agent.configurationVersionId === pin.configurationVersionId
    })
}

/** Reconcile only authenticated terminal readback for this exact form base.
 * Persist consumption with the resulting form before exposing it to new typing;
 * the shared outbox is not a per-tab acknowledgement marker. */
export function acknowledgeEditIntentSnapshot(draftKey: string, current: NextDraftEdit, intent: GraphEditIntentV3): NextDraftEdit {
  const draft = current.context.draft
  if (current.busy || current.pending || !['saved', 'discarded'].includes(intent.state)
    || draft.workspaceId !== intent.workspaceId || draft.workflowId !== intent.workflowId || draft.id !== intent.draftId
    || draft.publishedRevision !== intent.expectedRevision || draft.baseWorkflowVersionId !== intent.expectedWorkflowVersionId
    || editSnapshotAcknowledged(draftKey, current, intent.stageCommandId)) return current
  const submission = readEditSubmission(draftKey, intent)
  // Without exact local evidence, a remote Discard says nothing about this form.
  if (intent.state === 'discarded' && !submission) return current
  const submittedHere = editSnapshotSubmitted(draftKey, current, intent.stageCommandId)
  const exactSubmittedForm = !!submission && sameAuthoredWorkflow(current.graph, submission.target)
    && sameWorkflowValue(current.agentEdits ?? {}, submission.agentTarget ?? {})
  const exactRemoteForm = intent.state === 'saved' && !!current.remoteEditIntent
    && sameWorkflowValue(current.remoteEditIntent, remoteLineage(intent)) && remoteBaseMatches(current, intent)
    && sameAuthoredWorkflow(current.graph, intent.stagedDraft.graph)
    && sameWorkflowValue(current.agentEdits ?? {}, remoteAgents(intent))
  const cleanRemoteForm = !hasLocalChanges(current.context, current.graph) && !hasAgentEdits(current)
    && !Object.keys(current.agentForms ?? {}).length
  // A terminal command may be shared across tabs, but its saved revision is not.
  // Keep an independently-diverged unsent form pinned to its original base so
  // its next Stage receives the authoritative stale-revision conflict.
  if (!submittedHere && !exactSubmittedForm && !cleanRemoteForm && !exactRemoteForm) return current
  let context = current.context
  if (intent.state === 'saved') {
    if (!intent.result) return current
    // The saved acknowledgement is the new published base of the local draft.
    const saved = intent.result
    context = { ...context, draft: { ...context.draft, revision: saved.revision, publishedRevision: saved.revision,
      baseWorkflowVersionId: saved.currentVersionId, graph: saved.presentation ?? saved.version.definition } }
    const agents = saved.agents
    if (intent.stagedDraft.stagedAgents?.some(({ agent }) => !agents?.some((savedAgent) =>
      savedAgent.agent.id === agent.id && savedAgent.agent.configurationVersionId === saved.version.agentConfigurationVersionIds[agent.id]))) return current
    const sourcePins = new Map((context.draft.sourceAgentPins ?? []).map(pin => [pin.agentId, pin]))
    for (const record of agents ?? []) {
      if (record.agent.configurationVersionId) sourcePins.set(record.agent.id, {
        agentId: record.agent.id, metadataRevision: record.metadataRevision,
        configurationVersionId: record.agent.configurationVersionId,
      })
    }
    const draft = { ...context.draft, ...(agents?.length ? { sourceAgentPins: [...sourcePins.values()] } : {}) }
    context = { ...context, draft, savedDraft: draft,
      agents: [...new Map([...context.agents, ...(agents ?? [])].map((item) => [item.agent.id, item])).values()] }
  }
  const graph = intent.state === 'saved' && cleanRemoteForm && !submittedHere && !exactSubmittedForm
    ? preserveWorkflowGeometry(context.draft.graph, current.graph)
    : mergeAcknowledgement(current.graph, submission?.target ?? intent.stagedDraft.graph, context.draft.graph)
  const next = { ...current, context, graph,
    // Clear only an exact local submission or an unchanged authenticated remote hydration.
    agentEdits: acknowledgeAgentEdits(current.agentEdits, submission?.agentTarget ?? (exactRemoteForm ? remoteAgents(intent) : undefined), context,
      intent.state === 'discarded' ? graph : undefined),
    remoteEditIntent: undefined, error: undefined, validation: undefined }
  storeEditSnapshot(draftKey, next, intent.stageCommandId)
  acknowledgeEditSubmission(draftKey, intent)
  return next
}

/** Server plans/facts and request lifecycle are Query-owned. Only the local
 * form and its pinned authoring base live in Zustand; storage is an outbox,
 * never an authentication, Run-state or publication authority. */
export function useGraphEditIntent(draftKey: string, edit: NextDraftEdit) {
  const queryClient = useQueryClient()
  const [storageError, setStorageError] = useState<string>()
  const [outboxPending, setOutboxPending] = useState(false)
  const { workspaceId, workflowId, id: draftId } = edit.context.draft
  const generation = sessionGeneration()
  const queryKey = useMemo(() => graphEditIntentKey(workspaceId, workflowId, draftId, generation), [workspaceId, workflowId, draftId, generation])
  const hydrated = useRef<string | undefined>(undefined)
  const automaticAttempt = useRef<string | undefined>(undefined)
  const query = useQuery({ queryKey,
    queryFn: ({ signal }) => nextDraftApi.editRead({ action: 'read_edits', workspaceId, workflowId, draftId }, { signal }),
    retry: false,
    refetchInterval: (state) => activeEditIntent(state.state.data?.intent) ? 1000 : false,
  })
  useEffect(() => {
    const persist = () => {
      const current = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!current) return
      try {
        storeEditSnapshot(draftKey, current)
        setOutboxPending(!!readEditOutbox(draftKey)); setStorageError(undefined)
      } catch (error) {
        setStorageError(error instanceof Error ? `Edits remain in this tab. ${error.message}` : 'The current form is not durably stored.')
      }
    }
    persist()
    const unsubscribe = useGraphDraftStore.subscribe((state, previous) => {
      if (state.nextDrafts[draftKey] !== previous.nextDrafts[draftKey]) persist()
    })
    const changed = () => {
      try { setOutboxPending(!!readEditOutbox(draftKey)) } catch (error) { setStorageError(String(error)) }
      void queryClient.invalidateQueries({ queryKey })
    }
    window.addEventListener('storage', changed)
    return () => { unsubscribe(); window.removeEventListener('storage', changed) }
  }, [draftKey, queryClient, queryKey])

  const accept = useCallback((data: GraphEditReadResultV3) => {
    queryClient.setQueryData(queryKey, data)
    const intent = data.intent
    if (!intent) return
    const current = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!current || current.busy || current.pending) return
    const retained = readEditOutbox(draftKey)
    const ownOutbox = !!retained && matchesEditIntent(retained, intent)
    if (intent.state === 'saved' || intent.state === 'discarded') {
      useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => acknowledgeEditIntentSnapshot(draftKey, state, intent))
      // Removing a shared reservation must not remove the submission evidence
      // needed by another tab that has not consumed this terminal readback yet.
      const acknowledged = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (acknowledged) storeEditSnapshot(draftKey, acknowledged)
      if (ownOutbox) acknowledgeEditOutbox(draftKey, intent.stageCommandId)
      setOutboxPending(!!readEditOutbox(draftKey))
      if (intent.state === 'saved') void Promise.all([
        queryClient.invalidateQueries({ queryKey: boardDraftContextKey(workspaceId, workflowId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkflow(workspaceId, workflowId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) }),
      ])
    } else if (activeEditIntent(intent) && hydrated.current !== intent.id) {
      const submission = readEditSubmission(draftKey, intent)
      const submittedGraph = submission?.target ?? intent.stagedDraft.graph
      const submittedAgents = submission ? submission.agentTarget
        : remoteAgents(intent)
      hydrated.current = intent.id
      // Fresh/reopened clean boards show the exact private payload. Never
      // overwrite another tab's/newer unsent form or replace its revision base.
      if (!hasLocalChanges(current.context, current.graph) && !hasAgentEdits(current)
        && !Object.keys(current.agentForms ?? {}).length && remoteBaseMatches(current, intent)) {
        useGraphDraftStore.getState().updateNextDraft(draftKey, (state) => ({ ...state,
          graph: preserveWorkflowGeometry(submittedGraph, state.graph),
          agentEdits: submittedAgents,
          remoteEditIntent: submission ? undefined : remoteLineage(intent),
        }))
      }
    }
  }, [draftKey, queryClient, queryKey, workspaceId, workflowId])
  // Reconcile persisted results after refresh, independently of the HTTP reply
  // that first caused them. The query itself performs no Stop or publication.
  const seen = useRef<GraphEditReadResultV3 | undefined>(undefined)
  useEffect(() => {
    if (!query.data || seen.current === query.data) return
    seen.current = query.data
    try { accept(query.data) } catch (error) { setStorageError(String(error)) }
  }, [accept, query.data])

  const mutation = useMutation({ mutationKey: editIntentCommandKey(draftKey), mutationFn: async (command: { action: 'save' | 'advance' | 'discard'; allowStop?: boolean }) => withEditIntentLock(draftKey, async () => {
    const { action, allowStop = false } = command
    const generation = sessionGeneration()
    const current = useGraphDraftStore.getState().nextDrafts[draftKey]
    if (!current || current.busy || current.pending || readBoardStart(draftKey)) {
      throw new Error('Reconcile the earlier draft or Start command first. No replacement command was sent.')
    }
    storeEditSnapshot(draftKey, current)
    const retained = readEditOutbox(draftKey)
    const stage = async (outbox: EditIntentOutbox) => {
      try { return await nextDraftApi.editStage(outbox.request) }
      catch (error) {
        assertSession(generation)
        if (rejectEditOutbox(draftKey, outbox.request, error)) {
          setOutboxPending(!!readEditOutbox(draftKey))
          void queryClient.invalidateQueries({ queryKey })
        }
        // No replacement command, automatic retry, or form discard on failure.
        throw error
      }
    }
    // Stage replay is read/receipt reconciliation, not Stop. Even Discard must
    // first settle an uncertain Stage reply; it never calls editAdvance.
    let data = retained ? await stage(retained)
      : await nextDraftApi.editRead(readInput(current))
    assertSession(generation)
    const beforeAcknowledgement = useGraphDraftStore.getState().nextDrafts[draftKey]
    accept(data)
    // A sibling tab may have finished this form while consuming the shared
    // outbox. Acknowledge that result, not a new Stage from the captured old base.
    if (data.intent && !activeEditIntent(data.intent)
      && useGraphDraftStore.getState().nextDrafts[draftKey] !== beforeAcknowledgement) return data
    if (action !== 'discard' && !activeEditIntent(data.intent) && !retained) {
      if (!nextDraftDirty(current) && current.context.draft.baseWorkflowVersionId) { accept(data); return data }
      const operations = draftOperations(current.context, current.graph, current.agentEdits)
      assertDraftSubmission(current.graph, operations)
      const stagedAgents = stageAgentEdits(current)
      const pins = await nextDraftApi.pins(current.context.draft.workspaceId, current.graph, stagedAgents, current.context.agents)
      const request = GraphEditStageInputV3Schema.parse({ workspaceId: current.context.draft.workspaceId,
        workflowId: current.context.draft.workflowId, draftId: current.context.draft.id, action: 'stage_edits',
        commandId: crypto.randomUUID(), expectedRevision: current.context.draft.publishedRevision,
        expectedWorkflowVersionId: current.context.draft.baseWorkflowVersionId, executionSemanticsVersion: 3,
        expectedAgentConfigurationVersionIds: pins.expectedAgentConfigurationVersionIds,
        graph: current.graph,
        ...(stagedAgents.length ? { stagedAgents } : {}) })
      const reserved = reserveEditOutbox(draftKey, { request, target: current.graph,
        ...(current.agentEdits ? { agentTarget: current.agentEdits } : {}) })
      setOutboxPending(true)
      data = await stage(reserved)
      assertSession(generation)
    }
    accept(data)
    const intent = data.intent
    if (intent && activeEditIntent(intent)) {
      if (action !== 'discard') {
        // Ordinary Save is not Stop authorization. Return the staged blockers
        // for review (including other workflows) without mutating shared Agents
        // or dispatching Stop. Confirmed advance still rechecks every fence below.
        if (action === 'save' && (data.affectedSetChanged || data.current.some((item) => !item.settled))) return data
        if (data.affectedSetChanged) throw new Error('The affected Run set changed. Retained commands will not Stop any newly discovered Run.')
        if (data.current.some((item) => !item.settled) && !allowStop) throw new Error('Affected Runs require explicit Stop-and-save confirmation. The staged edits are retained; no Stop was sent.')
        if (data.current.some((item) => !item.settled) && !data.canStop) throw new Error('Stop permission is missing for one or more affected Runs. The exact staged edits remain retained.')
        data = await nextDraftApi.editAdvance({ ...commandInput(intent), action: 'stop_and_save', commandId: intent.advanceCommandId })
      } else data = await nextDraftApi.editDiscard({ ...commandInput(intent), action: 'discard_edits', commandId: intent.discardCommandId })
      assertSession(generation); accept(data)
    }
    return data
  }), retry: false })

  const { mutate, isPending, isError, reset } = mutation
  const dirty = nextDraftDirty(edit)
  useEffect(() => {
    // Receipt readback can confirm a lost reply without rerunning the mutation.
    // Once no edits or unresolved command remain, its old error is obsolete.
    if (isError && !dirty && !outboxPending && !activeEditIntent(query.data?.intent)) reset()
  }, [dirty, isError, outboxPending, query.data?.intent, reset])
  useEffect(() => {
    const data = query.data, intent = data?.intent
    if (!intent || isPending || data.affectedSetChanged || storageError) return
    // Only finish an already explicitly initiated intent when authoritative
    // readback says every obligation settled. Staged/blocked/uncertain intents
    // need an explicit click; no Start is ever issued here.
    if (!['waiting', 'stopping', 'saving'].includes(intent.state) || !data.current.every((item) => item.settled)) return
    const attempt = `${intent.id}:${intent.state}:${intent.updatedAt}`
    if (automaticAttempt.current === attempt) return
    automaticAttempt.current = attempt
    mutate({ action: 'advance' })
  }, [query.data, isPending, storageError, mutate])
  const intent = query.data?.intent
  const locked = activeEditIntent(intent) || outboxPending || mutation.isPending
  return { query, mutation, intent, locked, storageError, outboxPending,
    // Only an active intent has a pending payload to compare with local edits.
    sameDisplayedPayload: !intent || !activeEditIntent(intent) || sameAuthoredWorkflow(edit.graph, intent.stagedDraft.graph)
      && sameWorkflowValue(referencedAgentEdits(edit.graph, edit.agentEdits),
        Object.fromEntries((intent.stagedDraft.stagedAgents ?? []).map((item) => [item.agent.id, item.agent]))),
    save: () => mutation.mutateAsync({ action: 'save' }),
    advance: (allowStop = false) => mutation.mutateAsync({ action: 'advance', allowStop }),
    discard: () => mutation.mutateAsync({ action: 'discard' }),
  }
}
