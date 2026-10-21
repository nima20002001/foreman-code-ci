import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { journalRequest, journalIntent, savedJournal } from './nim2644Journal.fixture'
import assert from 'node:assert/strict'
import { createStore } from 'zustand/vanilla'
import type { Agent } from '@foreman-code/contracts'
import { sameExecutableWorkflow, type GraphEditIntentV3 } from '@foreman-code/contracts/wave25'
import { ApiError } from '../../../shared/api/client'
import { protectedKey, rotateProtectedSession } from '../../../shared/api/protectedChatStorage'
import { acknowledgeEditIntentSnapshot } from './useGraphEditIntent'
import { acknowledgeEditOutbox, clearEditIntentStorage, editSnapshotAcknowledged, isDefinitiveStageRejection,
  matchesEditIntent, readEditOutbox, readEditSnapshot, readEditSubmission, rejectEditOutbox, reserveEditOutbox,
  storeEditSnapshot, type EditIntentOutbox } from './editIntentStorage'
import { newNextDraft, nextDraftDirty, nextDraftKey, type NextDraftEdit } from './state'
import { removeNode } from './model'
import { editorAgents } from './agentEdits'
import { repairFixture } from './nim2644State.cases'

// Two independent Zustand form stores and tab snapshot IDs, sharing only the
// storage outbox/submission journal. Ordered synchronous cuts model suspended
// tabs; this is not a live browser, authenticated API, or native Stop test.
const key = nextDraftKey('workspace', 'workflow'), now = '2026-09-24T00:00:00Z'
export function inFollowupTab<T>(id: string, work: () => T): T {
  const name = protectedKey('ui', 'graph-edit-intent:tab'), previous = sessionStorage.getItem(name)
  sessionStorage.setItem(name, id)
  try { return work() }
  finally { if (previous === null) sessionStorage.removeItem(name); else sessionStorage.setItem(name, previous) }
}
function tab(id: string, initial: NextDraftEdit) {
  const store = createStore<{ edit: NextDraftEdit }>(() => ({ edit: structuredClone(initial) }))
  const run = <T>(work: () => T) => inFollowupTab(id, work)
  const persist = () => run(() => storeEditSnapshot(key, store.getState().edit))
  const change = (update: (edit: NextDraftEdit) => NextDraftEdit) => {
    store.setState(({ edit }) => ({ edit: update(edit) })); persist()
  }
  const readback = (intent: GraphEditIntentV3) => run(() => {
    store.setState(({ edit }) => ({ edit: acknowledgeEditIntentSnapshot(key, edit, intent) }))
    const outbox = readEditOutbox(key)
    if (outbox && matchesEditIntent(outbox, intent)) acknowledgeEditOutbox(key, intent.stageCommandId)
  })
  const reopen = () => run(() => {
    const snapshot = readEditSnapshot(key)!
    store.setState({ edit: { ...newNextDraft(snapshot.context, `${id}-reopen`), graph: snapshot.graph, agentEdits: snapshot.agentEdits } })
  })
  persist()
  return { id, store, run, persist, change, readback, reopen, get: () => store.getState().edit }
}
function submission(edit: NextDraftEdit, commandId = 'stage-original'): EditIntentOutbox {
  return { request: journalRequest(edit, commandId), target: edit.graph,
    ...(edit.agentEdits ? { agentTarget: edit.agentEdits } : {}) }
}
function terminal(edit: NextDraftEdit, outbox: EditIntentOutbox, state: 'saved' | 'discarded'): GraphEditIntentV3 {
  const intent = journalIntent(outbox.request, edit.context)
  return state === 'saved' ? savedJournal(intent) : { ...intent, state }
}

function newWorker(): NextDraftEdit {
  const edit = newNextDraft(repairFixture(1), 'new-worker')
  const agent: Agent = { id: 'local-worker', name: 'New Worker', role: 'Coder', productRole: 'coder', harness: 'codex',
    model: 'synthetic', effort: 'low', fastMode: false,
    harnessConfiguration: { harness: 'codex', model: 'synthetic', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' } }
  return { ...edit, agentEdits: { [agent.id]: agent }, graph: { ...edit.graph,
    nodes: [...edit.graph.nodes, { id: 'local-node', agentId: agent.id, name: agent.name, position: { x: 400, y: 0 } }] } }
}
function removedLeaf(): NextDraftEdit {
  const edit = newNextDraft(repairFixture(3), 'removed-leaf')
  return { ...edit, graph: removeNode(edit.graph, 'node-2') }
}
function move(edit: NextDraftEdit): NextDraftEdit {
  return { ...edit, graph: { ...edit.graph, nodes: edit.graph.nodes.map((node) => node.id === 'node-0'
    ? { ...node, position: { x: 913, y: -34 }, width: 288, height: 181 } : node) } }
}
const rejection = (status = 409) => new ApiError({ code: 'AGENT_SOURCE_CONFLICT', message: 'Source configuration changed' }, status)
const reserve = (owner: ReturnType<typeof tab>, outbox: EditIntentOutbox) => owner.run(() => reserveEditOutbox(key, outbox))

export const nim2644FollowupCases: { name: string; run: () => void }[] = [
  { name: 'FE-001 recognizes only the exact AGENT_SOURCE_CONFLICT domain status and branded error', run() {
    assert.equal(isDefinitiveStageRejection(rejection()), true)
    for (const status of [0, 200, 400, 401, 403, 404, 408, 429, 500, 503]) assert.equal(isDefinitiveStageRejection(rejection(status)), false)
    assert.equal(isDefinitiveStageRejection({ code: 'AGENT_SOURCE_CONFLICT', status: 409 }), false)
  } },
  { name: 'FE-001 releases the exact rejected attach reservation, not its form, and permits a new explicit reservation', run() {
    const edit = removedLeaf(), a = tab('A', edit), outbox = submission(edit)
    reserve(a, outbox)
    a.run(() => {
      const before = readEditSnapshot(key)
      assert.equal(rejectEditOutbox(key, outbox.request, rejection()), true)
      assert.equal(readEditOutbox(key), undefined); assert.deepEqual(readEditSnapshot(key), before)
      assert.equal(reserveEditOutbox(key, submission(edit, 'explicit-retry')).request.commandId, 'explicit-retry')
    })
    assert.deepEqual(a.get(), edit)
  } },
  { name: 'FE-001 cannot release another Stage identity or changed same-ID request', run() {
    const edit = removedLeaf(), a = tab('A', edit), outbox = submission(edit); reserve(a, outbox)
    for (const request of [{ ...outbox.request, commandId: 'other' }, { ...outbox.request, expectedRevision: 8 }]) {
      a.run(() => assert.throws(() => rejectEditOutbox(key, request, rejection()), /not cleared/))
    }
    assert.deepEqual(readEditOutbox(key), outbox)
  } },
  { name: 'FE-001 preserves exact identity on network, invalid-response, auth, receipt, and 5xx failures', run() {
    const edit = removedLeaf(), a = tab('A', edit), outbox = submission(edit); reserve(a, outbox)
    for (const error of [new Error('lost reply'), new ApiError({ code: 'INVALID_RESPONSE', message: 'invalid' }), rejection(503),
      new ApiError({ code: 'FORBIDDEN', message: 'post-commit read denied' }, 403), new ApiError({ code: 'COMMAND_ID_CONFLICT', message: 'receipt' }, 409)]) {
      a.run(() => {
        assert.equal(rejectEditOutbox(key, outbox.request, error), false)
        assert.deepEqual(readEditOutbox(key), outbox)
        assert.deepEqual(reserveEditOutbox(key, submission(edit, 'replacement')), outbox)
      })
    }
  } },
  { name: 'FE-002 A saves first; independent B clears raw new Worker after A consumes shared outbox', run() {
    const edit = newWorker(), a = tab('A', edit), b = tab('B', edit), outbox = submission(edit), saved = terminal(edit, outbox, 'saved')
    assert.notEqual(a.store, b.store); assert.notEqual(a.get().agentEdits, b.get().agentEdits)
    assert.notDeepEqual(saved.stagedDraft.stagedAgents![0]!.agent, edit.agentEdits!['local-worker'])
    reserve(a, outbox); a.readback(saved)
    assert.equal(readEditOutbox(key), undefined); assert.equal(nextDraftDirty(b.get()), true)
    assert.deepEqual(readEditSubmission(key, saved), outbox)
    b.readback(saved)
    for (const owner of [a, b]) {
      assert.equal(nextDraftDirty(owner.get()), false); assert.deepEqual(owner.get().agentEdits, {})
      assert.equal(editorAgents(owner.get()).find((agent) => agent.id === 'local-worker')?.configurationVersionId, 'saved-local-worker')
      assert.equal(owner.get().context.agents.find((item) => item.agent.id === 'local-worker')?.metadataRevision, 1)
      owner.reopen(); assert.equal(nextDraftDirty(owner.get()), false)
    }
  } },
  { name: 'FE-002 B refreshes after A consumes the outbox and still acknowledges its own raw form', run() {
    const edit = newWorker(), a = tab('A', edit), b = tab('B', edit), outbox = submission(edit), saved = terminal(edit, outbox, 'saved')
    reserve(a, outbox); a.readback(saved); b.reopen()
    assert.equal(b.get().agentEdits?.['local-worker']?.prompt, undefined)
    b.readback(saved); assert.equal(nextDraftDirty(b.get()), false)
  } },
  { name: 'FE-002 B keeps newer prompt/skills and unrelated Agent edits while installing saved metadata', run() {
    const edit = newWorker(), a = tab('A', edit), b = tab('B', edit), outbox = submission(edit), saved = terminal(edit, outbox, 'saved')
    reserve(a, outbox)
    const unrelated = { ...edit.context.agents[0]!.agent, name: 'Independent rename' }
    b.change((current) => ({ ...current, agentEdits: { ...current.agentEdits, 'agent-0': unrelated,
      'local-worker': { ...current.agentEdits!['local-worker']!, prompt: { system: 'Typed after Stage' }, assignedSkills: [{ skillId: 'new-skill', version: '2' }] } } }))
    a.readback(saved); b.readback(saved)
    assert.equal(b.get().agentEdits?.['local-worker']?.prompt?.system, 'Typed after Stage')
    assert.deepEqual(b.get().agentEdits?.['local-worker']?.assignedSkills, [{ skillId: 'new-skill', version: '2' }])
    assert.equal(b.get().agentEdits?.['local-worker']?.configurationVersionId, 'saved-local-worker')
    assert.equal(b.get().agentEdits?.['local-worker']?.createdAt, now)
    assert.deepEqual(b.get().agentEdits?.['agent-0'], unrelated); assert.equal(nextDraftDirty(b.get()), true)
  } },
  ...(['A', 'B'] as const).map((first) => ({ name: `FE-003 ${first} consumes first; late other tab restores leaf/edge, geometry and newer meaning`, run() {
    const edit = removedLeaf(), a = tab('A', move(edit)), b = tab('B', edit), outbox = submission(edit), discarded = terminal(edit, outbox, 'discarded')
    reserve(a, outbox)
    b.change(move)
    const early = first === 'A' ? a : b, late = first === 'A' ? b : a
    late.change((current) => ({ ...current, graph: { ...current.graph, nodes: current.graph.nodes.map((node) => node.id === 'node-0'
      ? { ...node, initialPrompt: 'newer unsent meaning' } : node) } }))
    // A's request may have committed but its reply is dropped; B is free to
    // read discarded state first and remove the shared active reservation.
    early.readback(discarded); assert.equal(readEditOutbox(key), undefined)
    late.reopen(); late.readback(discarded)
    assert.deepEqual(late.get().graph.nodes.map((node) => node.id), ['node-0', 'node-1', 'node-2'])
    assert.deepEqual(late.get().graph.edges, edit.context.draft.graph.edges)
    assert.deepEqual(nativeNode(late.get().graph.nodes[0])?.position, { x: 913, y: -34 })
    assert.equal(nativeNode(late.get().graph.nodes[0])?.width, 288); assert.equal(nativeNode(late.get().graph.nodes[0])?.height, 181)
    assert.equal(nativeNode(late.get().graph.nodes[0])?.initialPrompt, 'newer unsent meaning')
    assert.equal(nextDraftDirty(late.get()), true)
  } })),
  { name: 'FE-003 lost-reply A becomes meaning-clean with its geometry after B consumes and A refreshes', run() {
    const edit = removedLeaf(), a = tab('A', move(edit)), b = tab('B', edit), outbox = submission(edit), discarded = terminal(edit, outbox, 'discarded')
    reserve(a, outbox); b.readback(discarded); a.reopen(); a.readback(discarded)
    assert(sameExecutableWorkflow(a.get().graph, edit.context.draft.graph)); assert.equal(nextDraftDirty(a.get()), false)
    assert.deepEqual(nativeNode(a.get().graph.nodes[0])?.position, { x: 913, y: -34 })
  } },
  { name: 'FE-003 late tab keeps a newer node deletion and does not restore its incident edges', run() {
    const edit = removedLeaf(), a = tab('A', edit), b = tab('B', edit), outbox = submission(edit), discarded = terminal(edit, outbox, 'discarded')
    reserve(a, outbox); a.change((current) => ({ ...move(current), graph: removeNode(move(current).graph, 'node-1') }))
    b.readback(discarded); a.readback(discarded)
    assert.deepEqual(a.get().graph.nodes.map((node) => node.id), ['node-0', 'node-2'])
    assert.deepEqual(a.get().graph.edges.map((edge) => edge.id), ['edge-2'])
  } },
  { name: 'FE-003 already-consumed Discard cannot resurrect a later same-leaf deletion, including refresh', run() {
    const edit = removedLeaf(), a = tab('A', edit), b = tab('B', edit), outbox = submission(edit), discarded = terminal(edit, outbox, 'discarded')
    reserve(a, outbox); b.readback(discarded); a.readback(discarded)
    a.change((current) => ({ ...current, graph: removeNode(current.graph, 'node-2') }))
    const newer = structuredClone(a.get().graph)
    a.readback(discarded); assert.deepEqual(a.get().graph, newer)
    a.reopen(); a.readback(discarded); assert.deepEqual(a.get().graph, newer)
    a.run(() => assert.equal(editSnapshotAcknowledged(key, a.get(), discarded.stageCommandId), true))
  } },
  { name: 'FE-003 multiple consumed Discards at the same revision cannot replay over newer work', run() {
    const edit = removedLeaf(), a = tab('A', edit), firstBox = submission(edit), first = terminal(edit, firstBox, 'discarded')
    reserve(a, firstBox); a.readback(first)
    a.change((current) => ({ ...current, graph: removeNode(current.graph, 'node-1') }))
    const secondBox = submission(a.get(), 'stage-second'), second = terminal(a.get(), secondBox, 'discarded')
    reserve(a, secondBox); a.readback(second)
    a.change((current) => ({ ...current, graph: removeNode(removeNode(current.graph, 'node-1'), 'node-2') }))
    const newer = structuredClone(a.get().graph)
    a.reopen(); a.readback(first); a.readback(second)
    assert.deepEqual(a.get().graph, newer)
  } },
  { name: 'copied last-form recovery copies its consumption markers, not another replay opportunity', run() {
    const edit = removedLeaf(), a = tab('A', edit), outbox = submission(edit), discarded = terminal(edit, outbox, 'discarded')
    reserve(a, outbox); a.readback(discarded)
    a.change((current) => ({ ...current, graph: removeNode(current.graph, 'node-2') }))
    const newer = structuredClone(a.get().graph)
    inFollowupTab('fresh-C', () => {
      const snapshot = readEditSnapshot(key)!
      const current = { ...newNextDraft(snapshot.context, 'new-tab'), graph: snapshot.graph, agentEdits: snapshot.agentEdits }
      assert.equal(acknowledgeEditIntentSnapshot(key, current, discarded), current)
      assert.deepEqual(readEditSnapshot(key)?.graph, newer)
    })
  } },
  { name: 'older outbox-only records are retained before a consuming tab removes the last copy', run() {
    const edit = newWorker(), a = tab('A', edit), b = tab('B', edit), outbox = submission(edit), saved = terminal(edit, outbox, 'saved')
    // This is the previous release's persisted format: no submission journal.
    localStorage.setItem(protectedKey('outbox', `graph-edit-intent:${key}`), JSON.stringify(outbox))
    a.readback(saved); assert.equal(readEditOutbox(key), undefined)
    assert.deepEqual(readEditSubmission(key, saved), outbox)
    b.readback(saved); assert.equal(nextDraftDirty(b.get()), false)
  } },
  { name: 'submission evidence remains command-keyed when a newer outbox is already reserved', run() {
    const edit = removedLeaf(), a = tab('A', edit), b = tab('B', edit), old = submission(edit), discarded = terminal(edit, old, 'discarded')
    reserve(a, old); b.readback(discarded)
    const newer = submission(b.get(), 'stage-newer'); reserve(b, newer)
    a.readback(discarded)
    assert.deepEqual(readEditOutbox(key), newer); assert.equal(nextDraftDirty(a.get()), false)
  } },
  ...(['saved', 'discarded'] as const).flatMap((state) => ['draft', 'saved revision', 'version', 'workspace', 'workflow'].map((fence) => ({
    name: `${state} readback cannot acknowledge a different ${fence}`, run() {
      const edit = newWorker(), a = tab('A', edit), outbox = submission(edit), intent = terminal(edit, outbox, state)
      reserve(a, outbox)
      const current = structuredClone(a.get()), draft = current.context.draft
      if (fence === 'draft') draft.id = 'other-draft'
      // Keep the local apply counter unchanged: only the saved base pin differs.
      if (fence === 'saved revision') draft.publishedRevision = intent.expectedRevision - 1
      if (fence === 'version') draft.baseWorkflowVersionId = 'other-version'
      if (fence === 'workspace') draft.workspaceId = 'other-workspace'
      if (fence === 'workflow') draft.workflowId = 'other-workflow'
      a.run(() => assert.equal(acknowledgeEditIntentSnapshot(key, current, intent), current))
    },
  }))),
  ...(['saved', 'discarded'] as const).map((state) => ({
    name: `${state} readback acknowledges its exact saved base despite a different local apply counter`, run() {
      const edit = newWorker(), a = tab('A', edit), outbox = submission(edit), intent = terminal(edit, outbox, state)
      reserve(a, outbox)
      const current = structuredClone(a.get())
      current.context.draft.revision += 2
      assert.equal(current.context.draft.publishedRevision, intent.expectedRevision)
      assert.notEqual(current.context.draft.revision, intent.expectedRevision)
      // A new Stage must also use the saved revision, not the apply counter.
      assert.equal(journalRequest(current, 'stage-after-local-apply').expectedRevision, intent.expectedRevision)
      a.run(() => {
        const acknowledged = acknowledgeEditIntentSnapshot(key, current, intent)
        assert.notEqual(acknowledged, current)
        assert.deepEqual(acknowledged.agentEdits, {})
        const expectedGraph = state === 'saved' ? intent.result!.version.definition : edit.context.draft.graph
        assert(sameExecutableWorkflow(acknowledged.graph, expectedGraph))
        assert.equal(acknowledged.context.draft.publishedRevision,
          state === 'saved' ? intent.result!.revision : intent.expectedRevision)
        assert.equal(acknowledged.context.draft.baseWorkflowVersionId,
          state === 'saved' ? intent.result!.currentVersionId : intent.expectedWorkflowVersionId)
        assert.equal(editSnapshotAcknowledged(key, acknowledged, intent.stageCommandId), true)
        // The acknowledgement cannot alter the original durable command.
        assert.deepEqual(readEditSubmission(key, intent), outbox)
        assert.deepEqual(readEditOutbox(key), outbox)
      })
    },
  })),
  { name: 'missing local evidence cannot Discard unrelated work or clear normalized-equal Agent edits', run() {
    const edit = newWorker(), a = tab('A', edit), outbox = submission(edit), discarded = terminal(edit, outbox, 'discarded')
    a.readback(discarded); assert.deepEqual(a.get(), edit)
    const saved = terminal(edit, outbox, 'saved')
    a.change((current) => ({ ...current, agentEdits: { 'local-worker': saved.stagedDraft.stagedAgents![0]!.agent } }))
    const before = structuredClone(a.get().agentEdits)
    a.readback(saved); assert.deepEqual(a.get().agentEdits, before)
  } },
  { name: 'same-ID conflicting evidence is rejected, not overwritten; scope and command pins remain strict', run() {
    const edit = newWorker(), a = tab('A', edit), outbox = submission(edit), saved = terminal(edit, outbox, 'saved')
    reserve(a, outbox); a.readback(saved)
    const altered = { ...outbox, target: { ...outbox.target, name: 'other payload' } }
    a.run(() => assert.throws(() => reserveEditOutbox(key, altered), /No evidence was replaced/))
    assert.throws(() => readEditSubmission(key, { ...saved, expectedRevision: 99 }), /does not match/)
    assert.throws(() => readEditSubmission(nextDraftKey('elsewhere', 'workflow'), saved), /different workspace/)
    assert.equal(readEditSubmission(key, { ...saved, stageCommandId: 'unrelated-command' }), undefined)
    assert.deepEqual(readEditSubmission(key, saved), outbox)
  } },
  { name: 'identity rotation and explicit cleanup isolate/clear submission evidence and tab markers', run() {
    const edit = removedLeaf(), a = tab('A', edit), outbox = submission(edit), discarded = terminal(edit, outbox, 'discarded')
    reserve(a, outbox); a.readback(discarded)
    rotateProtectedSession(); assert.equal(readEditSubmission(key, discarded), undefined)
    a.run(() => assert.equal(editSnapshotAcknowledged(key, a.get(), discarded.stageCommandId), false))
    const newer = submission(edit, 'new-epoch'); reserve(a, newer)
    assert(readEditSubmission(key, terminal(edit, newer, 'discarded')))
    localStorage.setItem('unrelated-preference', 'keep'); clearEditIntentStorage()
    assert.equal(readEditSubmission(key, terminal(edit, newer, 'discarded')), undefined)
    assert.equal(localStorage.getItem('unrelated-preference'), 'keep')
  } },
]
