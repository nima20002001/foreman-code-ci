import assert from 'node:assert/strict'
import type { WorkflowRun, WorkflowDefinition, HarnessExecution } from '@foreman-code/contracts'
import { projectRunLiveActivity, type LiveActivityEvent } from '../../src/modules/runs/liveActivity.js'
import { projectNativeEvidence, emptyNativeProjection, nativeProjectionActivity, reconcileNativeEvidence,
  NATIVE_PROJECTION_LIMITS, type ProjectionBinding, type ProjectionEvent, type NativeProjectionState } from '../../src/modules/run-graph/nativeProjection.js'
import { selectCurrentNodeActivity } from '../../src/modules/run-graph/nativeActivitySelection.js'

const execution = { workflowNodeId: 'node-a', executionId: 'exec-a', agentId: 'agent-a', agentConfigurationVersionId: 'config-a', attempt: 1 }
export const binding: ProjectionBinding = { key: { execution, workKind: 'workflow', workId: execution.executionId },
  provider: 'codex', nativeSessionId: 'session-a', nativeTurnId: 'turn-a', connectionGeneration: '1', interactionId: null, closed: false }
export const event = (type: string, position: number | string, payload: Record<string, unknown> = {}, overrides: Partial<ProjectionEvent> = {}): ProjectionEvent => ({
  type, nativeSequence: String(position), sourcePosition: String(position), sourceStreamId: 'stream-a', connectionGeneration: '1',
  sourceId: `source-${position}`, payload: { sessionID: 'session-a', turnId: 'turn-a', ...payload }, ...overrides,
})
const tool = (id: string, position: number | string, type = 'commandExecution', status = 'inProgress') => event('item.started', position,
  { item: { id, type, status, commandActions: [{ type: 'read' }] } })
const step = (events: readonly ProjectionEvent[], owner = binding) => events.reduce<NativeProjectionState | undefined>(
  (state, observation) => projectNativeEvidence(state, owner, observation).state, undefined)!
const view = (events: readonly ProjectionEvent[], owner = binding) => nativeProjectionActivity(step(events, owner), owner)

function legacy(events: readonly ProjectionEvent[], reviewState?: 'leased' | 'submitted') {
  const now = '2026-09-21T00:00:00.000Z'
  const run = { id: 'run-a', workspaceId: 'workspace-a', workflowId: 'workflow-a', workflowVersionId: 'version-a',
    agentConfigurationVersionIds: { 'agent-a': 'config-a' }, executionState: 'running' } as unknown as WorkflowRun
  const definition = { nodes: [{ id: 'node-a', agentId: 'agent-a', name: 'Worker' }], edges: [] } as unknown as WorkflowDefinition
  const host = { id: execution.executionId, runId: run.id, workflowNodeId: execution.workflowNodeId, agentId: execution.agentId,
    agentConfigurationVersionId: execution.agentConfigurationVersionId, nativeSessionId: 'session-a', attempt: 1 } as HarnessExecution
  const domain: LiveActivityEvent = { runId: run.id, sequence: '0', source: 'backend', kind: 'node_state_changed',
    harnessExecutionId: host.id, occurredAt: now, payload: { liveNodeEvent: 1, topic: reviewState ? 'review' : 'execution',
      workflowNodeId: 'node-a', agentId: 'agent-a', state: reviewState ?? 'running',
      ...(reviewState ? { reviewJobId: 'review-a', interactionId: 'interaction-a' } : {}) } }
  return projectRunLiveActivity({ run, definition, executions: [host], events: [domain, ...events.map((observation, index) => ({
    runId: run.id, sequence: String(index + 1), source: 'harness', kind: 'harness_output', harnessExecutionId: host.id,
    occurredAt: now, payload: {}, native: { type: observation.type, payload: observation.payload,
      connectionId: observation.sourceStreamId, sourceSequence: observation.sourcePosition },
  }))], reviews: reviewState ? [{ executionId: host.id, job: { id: 'review-a', interactionId: 'interaction-a',
    reviewerAgentId: 'agent-a', providerTurnOrMessageId: 'turn-a' } }] : [] }).nodes[0]!
}

export const nativeProjectionCases: { name: string; run: () => void }[] = [
  { name: 'an unacknowledged lease/submission is unknown', run: () => {
    assert.equal(nativeProjectionActivity(emptyNativeProjection(binding), binding).status, 'unknown')
    const review = { ...binding, key: { ...binding.key, workKind: 'review' as const, workId: 'review-a' }, interactionId: 'interaction-a' }
    assert.equal(nativeProjectionActivity(emptyNativeProjection(review), review).status, 'unknown')
    assert.equal(legacy([], 'leased').state, 'working') // Deliberate tightening of the S1 oracle.
  } },
  { name: 'Codex reading action matches the full-history oracle', run: () => {
    const events = [tool('read-a', 1)]
    assert.equal(view(events).action, legacy(events).action?.kind)
    assert.equal(view(events).status, 'active')
  } },
  { name: 'overlap completion restores the older still-running tool', run: () => {
    const events = [tool('read-a', 1), tool('write-b', 2, 'fileChange'), event('item.completed', 3, { item: { id: 'write-b', type: 'fileChange', status: 'completed' } })]
    assert.equal(view(events).action, 'reading_file')
    assert.equal(view(events).action, legacy(events).action?.kind)
  } },
  { name: 'completed-before-start is a permanent item tombstone', run: () => {
    const result = view([event('item.completed', 9, { item: { id: 'read-a', type: 'commandExecution' } }), tool('read-a', 1), tool('read-a', 20)])
    assert.equal(result.status, 'unknown')
  } },
  { name: 'pending and a late pending observation are never work evidence', run: () => {
    assert.equal(view([tool('read-a', 1, 'commandExecution', 'pending')]).status, 'unknown')
    assert.equal(view([tool('read-a', 1), tool('read-a', 2, 'commandExecution', 'pending')]).action, 'reading_file')
  } },
  { name: 'duplicate native starts are unchanged, even with a higher ingest sequence', run: () => {
    const state = step([tool('read-a', 1)])
    const result = projectNativeEvidence(state, binding, { ...tool('read-a', 1), nativeSequence: '10' })
    assert.equal(result.disposition, 'ignored'); assert.deepEqual(result.state, state)
  } },
  { name: 'keepalive, ping, health, transport-open and token prose never become progress', run: () => {
    for (const type of ['ping', 'keepalive', 'transport.open', 'item.agentMessage.delta']) {
      const result = projectNativeEvidence(undefined, binding, event(type, 1, { text: 'Successfully completed everything' }))
      assert.equal(result.activity.status, 'unknown'); assert.equal(result.disposition, 'ignored')
    }
  } },
  { name: 'disconnect is stale evidence, not successful or idle completion', run: () => {
    const result = view([tool('read-a', 1), event('graph.native.disconnected', 2)])
    assert.equal(result.status, 'stale'); assert.equal(result.action, 'reading_file')
  } },
  { name: 'reordered old disconnect cannot overwrite a newer native acknowledgement', run: () => {
    assert.equal(view([tool('read-a', 10), event('graph.native.disconnected', 2)]).status, 'active')
  } },
  { name: 'old tool evidence cannot clear a newer disconnect fence', run: () => {
    assert.equal(view([tool('read-a', 1), event('graph.native.disconnected', 10), tool('write-b', 2, 'fileChange')]).status, 'stale')
  } },
  { name: 'new native evidence reconciles disconnection without resubmission', run: () => {
    assert.equal(view([tool('read-a', 1), event('graph.native.disconnected', 2), tool('write-b', 3, 'fileChange')]).status, 'active')
  } },
  { name: 'stale owner generation cannot cross the current connection fence', run: () => {
    const current = { ...binding, connectionGeneration: '2' }
    const state = step([tool('read-a', 1)])
    const result = projectNativeEvidence(state, current, tool('write-b', 2, 'fileChange'))
    assert.equal(result.disposition, 'ignored'); assert.equal(result.reason, 'generation')
  } },
  { name: 'a new generation needs its own native evidence', run: () => {
    const old = step([tool('read-a', 1)])
    const next = projectNativeEvidence(old, { ...binding, connectionGeneration: '2' },
      { ...event('item.agentMessage.delta', 3, { text: 'Working' }), connectionGeneration: '2' })
    assert.equal(next.activity.status, 'unknown')
  } },
  { name: 'session and host mismatches cannot reuse acknowledgement', run: () => {
    const state = step([tool('read-a', 1)])
    const wrong = { ...binding, nativeSessionId: 'other-session' }
    const result = projectNativeEvidence(state, wrong, tool('read-b', 2))
    assert.equal(result.disposition, 'rejected'); assert.equal(result.activity.status, 'unknown')
    const hostile = tool('read-b', 2)
    hostile.payload.threadId = 'other-session'
    assert.equal(projectNativeEvidence(undefined, binding, hostile).reason, 'identity')
  } },
  { name: 'a pinned turn cannot be privately rebound', run: () => {
    assert.equal(projectNativeEvidence(step([tool('read-a', 1)]), { ...binding, nativeTurnId: 'other-turn' }, tool('read-b', 2)).disposition, 'rejected')
  } },
  { name: 'native turn completion clears monotonically without deciding workflow outcome', run: () => {
    const events = [tool('read-a', 1), event('turn.completed', 2, { turn: { id: 'turn-a', status: 'completed' } }), tool('read-b', 3)]
    const state = step(events); assert.equal(nativeProjectionActivity(state, binding).status, 'none')
    assert.equal(state.terminalNativeSequence, '2'); assert.equal(legacy(events).state, 'idle')
    assert.equal('outcome' in state, false)
  } },
  { name: 'malformed terminal or stream-end never creates empty success', run: () => {
    const state = step([tool('read-a', 1)])
    const bad = projectNativeEvidence(state, binding, event('turn.completed', 2, { turn: { id: 'turn-a' } }))
    assert.equal(bad.disposition, 'rejected'); assert.equal(bad.state.terminalNativeSequence, null)
    assert.equal(projectNativeEvidence(state, binding, event('stream.end', 3)).state.terminalNativeSequence, null)
    assert.equal(projectNativeEvidence(bad.state, binding, tool('write-b', 4, 'fileChange')).activity.action, 'writing_file')
  } },
  { name: 'normalized acknowledgement works; success without native settlement does not', run: () => {
    assert.equal(view([event('graph.native.acknowledged', 1)]).action, 'working')
    const bad = event('graph.native.terminal', 2, { terminal: { outcome: 'succeeded', evidenceKind: 'provider_terminal', evidenceId: 'terminal-a', nativeSettled: false } })
    assert.equal(projectNativeEvidence(undefined, binding, bad).disposition, 'rejected')
  } },
  { name: 'completed workflow host and independent review work have separate fences', run: () => {
    const closed = step([event('turn.completed', 1, { turn: { id: 'turn-a', status: 'completed' } })])
    const review = { ...binding, key: { ...binding.key, workKind: 'review' as const, workId: 'review-a' }, interactionId: 'interaction-a' }
    assert.equal(projectNativeEvidence(closed, review, tool('read-a', 2)).disposition, 'rejected')
    assert.equal(view([tool('read-a', 2)], review).action, 'reviewing')
    assert.equal(nativeProjectionActivity(closed, binding).status, 'none')
  } },
  { name: 'decimal source precision survives the JavaScript safe-integer boundary', run: () => {
    const state = step([tool('read-a', '9007199254740992'), tool('write-b', '9007199254740993', 'fileChange')])
    assert.equal(state.lastNativeSequence, '9007199254740993'); assert.equal(nativeProjectionActivity(state, binding).action, 'writing_file')
    assert.equal(projectNativeEvidence(state, binding, tool('bad', '092')).disposition, 'rejected')
  } },
  { name: 'capacity exhaustion is bounded uncertainty, never a truncated JSON checkpoint', run: () => {
    const state = step(Array.from({ length: NATIVE_PROJECTION_LIMITS.operations + 2 }, (_, i) => tool(`read-${i}`, i + 1)))
    assert.equal(state.overflow, true); assert.equal(state.operations.length, NATIVE_PROJECTION_LIMITS.operations)
    assert.equal(nativeProjectionActivity(state, binding).status, 'unknown')
    assert.ok(Buffer.byteLength(JSON.stringify(state)) <= NATIVE_PROJECTION_LIMITS.checkpointBytes)
    assert.deepEqual(JSON.parse(JSON.stringify(state)), state)
  } },
  { name: 'complete bounded reconnect view compacts state and fences old omitted starts', run: () => {
    const old = step(Array.from({ length: 130 }, (_, i) => tool(`read-${i}`, i + 1)))
    const current = event('item.snapshot', 140, { item: { id: 'write-current', type: 'fileChange', status: 'inProgress' } })
    const repaired = reconcileNativeEvidence(old, binding, current, [current])
    assert.equal(repaired.activity.action, 'writing_file'); assert.equal(repaired.state.overflow, false)
    const late = projectNativeEvidence(repaired.state, binding, tool('read-omitted', 90))
    assert.equal(late.disposition, 'ignored'); assert.equal(late.activity.action, 'writing_file')
  } },
  { name: 'empty reconnect view is unknown, and reconnect cannot reopen terminal work', run: () => {
    const cut = event('item.snapshot', 10)
    assert.equal(reconcileNativeEvidence(undefined, binding, cut, []).activity.status, 'unknown')
    const terminal = step([event('turn.completed', 1, { turn: { id: 'turn-a', status: 'completed' } })])
    assert.equal(reconcileNativeEvidence(terminal, binding, cut, [tool('read-a', 10)]).activity.status, 'none')
  } },
  { name: 'clearing one review cannot clear another active review on the same host', run: () => {
    const first = { ...binding, key: { ...binding.key, workKind: 'review' as const, workId: 'review-a' }, interactionId: 'interaction-a' }
    const second = { ...first, key: { ...first.key, workId: 'review-b' }, interactionId: 'interaction-b' }
    const selected = selectCurrentNodeActivity('node-a', [
      { key: first.key, activity: { workflowNodeId: 'node-a', status: 'none' }, lastNativeSequence: '20' },
      { key: second.key, activity: view([tool('read-a', 10)], second), lastNativeSequence: '10' },
    ], { closed: false })
    assert.equal(selected.reviewJobId, 'review-b')
    assert.equal(selectCurrentNodeActivity('node-a', [], { closed: true }).status, 'none')
  } },
]
