import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import type { HarnessExecution, WorkflowDefinition, WorkflowRun } from '@foreman-code/contracts'
import { projectRunLiveActivity, type LiveActivityEvent, type LiveReviewIdentity } from '../src/modules/runs/liveActivity.js'
import { nativeAction, nodeAction, safeNodeName } from '../src/modules/runs/nativeAction.js'

const at = '2026-09-20T00:00:00.000Z'
// Synthetic persisted/native records, not a live-provider test.
const definition = {
  id: 'workflow', workspaceId: 'workspace', name: 'Test',
  nodes: [{ id: 'review', agentId: 'orchestrator', name: 'Luna' }, { id: 'worker', agentId: 'coder', name: 'Worker' }],
  edges: [{ id: 'handoff', source: 'review', target: 'worker' }],
} as WorkflowDefinition
const run = {
  id: 'run', executionSemanticsVersion: 3, workspaceId: 'workspace', workflowId: 'workflow', workflowVersionId: 'version',
  agentConfigurationVersionIds: { orchestrator: 'orchestrator-v1', coder: 'coder-v1' },
  executionCondition: { kind: 'manual' },
  approval: { handler: 'orchestrator', designatedOrchestratorAgentId: 'orchestrator' },
  executionState: 'running', outcome: 'pending', input: {}, createdAt: at,
} as WorkflowRun
const execution = (nodeId: string, agentId: string): HarnessExecution => ({
  id: `exec-${nodeId}`, runId: run.id, workflowNodeId: nodeId, agentId,
  agentConfigurationVersionId: `${agentId}-v1`, attempt: 1, input: {}, state: 'running',
  nativeSessionId: `session-${nodeId}`, createdAt: at,
})
const executions = [execution('review', 'orchestrator'), execution('worker', 'coder')]
const reviews: LiveReviewIdentity[] = [{ executionId: 'exec-review', job: {
  id: 'job', reviewerAgentId: 'orchestrator', interactionId: 'ask', providerTurnOrMessageId: 'review-turn',
} }]
const baseEvent = (sequence: number | string, nodeId: string | null, payload: Record<string, unknown>): LiveActivityEvent => ({
  runId: 'run', sequence: String(sequence), source: 'backend', kind: 'node_state_changed',
  harnessExecutionId: nodeId ? `exec-${nodeId}` : null, occurredAt: at, payload,
})
const state = (sequence: number | string, node: 'review' | 'worker', value: string) => baseEvent(sequence, node, {
  liveNodeEvent: 1, topic: 'execution', workflowNodeId: node, agentId: node === 'review' ? 'orchestrator' : 'coder', state: value,
})
const interaction = (sequence: number, status = 'pending', deliveryState = 'not_started') => baseEvent(sequence, 'worker', {
  liveNodeEvent: 1, topic: 'interaction', workflowNodeId: 'worker', agentId: 'coder',
  interactionId: 'ask', handler: 'orchestrator', reviewerAgentId: 'orchestrator', status, deliveryState,
})
const review = (sequence: number, value: string, jobId = 'job', extra: Record<string, unknown> = {}) => baseEvent(sequence, 'review', {
  liveNodeEvent: 1, topic: 'review', workflowNodeId: 'review', agentId: 'orchestrator', reviewJobId: jobId,
  interactionId: jobId === 'job' ? 'ask' : 'ask2', requestingNodeId: 'worker', state: value, ...extra,
})
const native = (sequence: number | string, node: 'review' | 'worker', type: string, payload: Record<string, unknown>, sourceSequence = Number(sequence), connectionId = 'connection'): LiveActivityEvent => ({
  ...baseEvent(sequence, node, {}), source: 'harness', kind: 'harness_output',
  native: { type, payload, sourceSequence: String(sourceSequence), connectionId },
})
const item = (sequence: number, id: string, kind = 'commandExecution', extra: Record<string, unknown> = {}, source = sequence) =>
  native(sequence, 'worker', 'item.started', { turnId: 'worker-turn', item: { id, type: kind, status: 'inProgress', ...extra } }, source)
const end = (sequence: number, id: string, source = sequence) => native(sequence, 'worker', 'item.completed', {
  turnId: 'worker-turn', item: { id, type: 'commandExecution', status: 'completed' },
}, source)
const project = (events: LiveActivityEvent[], overrides: Partial<Parameters<typeof projectRunLiveActivity>[0]> = {}) =>
  projectRunLiveActivity({ run, definition, executions, reviews, events, ...overrides })
const node = (events: LiveActivityEvent[], id = 'worker') => project(events).nodes.find((value) => value.workflowNodeId === id)!
const handoff = () => [state(1, 'review', 'completed'), state(2, 'worker', 'running'), interaction(3), review(4, 'submitted')]

describe('safe structured native actions', () => {
  it('recognizes provider-classified reads, never command prose', () => {
    assert.equal(nativeAction('item.started', { item: { id: 'i', type: 'commandExecution', commandActions: [{ type: 'read', path: 'secret' }] } })?.kind, 'reading_file')
    assert.equal(nativeAction('item.started', { item: { id: 'i', type: 'commandExecution', command: 'mkdir confidential; cat .env' } })?.kind, 'running_command')
  })
  it('does not mislabel a mixed native command as a read', () => assert.equal(nativeAction('item.started', {
    item: { id: 'i', type: 'commandExecution', commandActions: [{ type: 'read' }, { type: 'unknown' }] },
  })?.kind, 'running_command'))
  it('recognizes App MCP, folder creation and subagent spawn from tool identity', () => {
    assert.equal(nativeAction('item.started', { item: { id: 'i', type: 'mcpToolCall', server: 'graphql-app', tool: 'interaction_get' } })?.kind, 'using_app_mcp')
    assert.equal(nativeAction('item.started', { item: { id: 'i', type: 'mcpToolCall', server: 'graphql-operator', tool: 'workspace_folder_create' } })?.kind, 'creating_folder')
    assert.equal(nativeAction('item.started', { item: { id: 'i', type: 'collabAgentToolCall', tool: 'spawnAgent' } })?.kind, 'spawning_subagent')
  })
  it.each(['graphql', 'foreman-code'])('classifies unified %s MCP calls by tool', (server) => {
    const codex = (tool: string) => nativeAction('item.started', { item: { id: 'i', type: 'mcpToolCall', server, tool } })?.kind
    assert.equal(codex('interaction_get'), 'using_app_mcp')
    assert.equal(codex('interaction_respond'), 'responding_approval')
    assert.equal(codex('workspace_folder_create'), 'creating_folder')
    assert.equal(codex('workflow_list'), 'using_operator_mcp')
  })
  it('does not call an undecided response an approval', () => assert.equal(nativeAction('item.started', {
    item: { id: 'i', type: 'mcpToolCall', server: 'graphql-app', tool: 'interaction_respond', arguments: { optionId: 'opaque' } },
  })?.kind, 'responding_approval'))

  it('ignores missing identities, unqualified snapshots and model text', () => {
    assert.equal(nativeAction('item.started', { item: { type: 'fileChange' } }), undefined)
    assert.equal(nativeAction('item.snapshot', { item: { id: 'p', type: 'fileChange' } }), undefined)
    assert.equal(nativeAction('item.started', { item: { id: 'p', type: 'agentMessage', text: 'Reading file…' } }), undefined)
    assert.equal(nativeAction('item.snapshot', { item: { id: 'p', type: 'commandExecution', commandActions: [{ type: 'read' }], title: 'Working' } }), undefined)
  })
  it('never includes tool arguments, paths, output or hostile titles in a label', () => {
    const value = nativeAction('item.started', { item: { id: 'p', type: 'commandExecution',
      commandActions: [{ type: 'read' }], status: 'inProgress', title: 'sk-super-secret',
      input: { path: '/secret/.env' }, aggregatedOutput: 'password=private' } })!
    assert.equal(nodeAction(value.kind).label, 'Reading file…')
    for (const name of ['token abc', 'sk-super-secret', '/private/path', 'Luna\u202eexe', 'a'.repeat(65)]) assert.equal(safeNodeName(name), undefined)
    assert.equal(nodeAction('waiting_approval', 'token abc').label, 'Waiting for approval…')
  })
})

describe('one event-backed per-node live projection', () => {
  it('shows an active handoff: completed entry working again while Worker waits', () => {
    const value = project(handoff())
    assert.deepEqual(value.nodes.map(({ state: status, action }) => [status, action?.label]), [
      ['working', 'Reviewing Worker’s request…'], ['waiting', 'Waiting for Luna’s approval…'],
    ])
    assert.equal(value.nodes[0]!.event?.sequence, '4')
    assert.equal(value.nodes[1]!.event?.sequence, '3')
  })
  it('uses the reviewer’s own native turn without changing the waiting Worker', () => {
    const events = [...handoff(), native(5, 'review', 'item.started', {
      turnId: 'review-turn', item: { id: 'mcp', type: 'mcpToolCall', server: 'graphql-app', tool: 'interaction_get' },
    })]
    assert.equal(node(events, 'review').action?.label, 'Using App MCP…')
    assert.equal(node(events).state, 'waiting')
    events.push(native(6, 'review', 'item.completed', { turnId: 'review-turn', item: { id: 'mcp', type: 'mcpToolCall' } }))
    assert.equal(node(events, 'review').action?.label, 'Reviewing Worker’s request…')
  })
  it('clears tool actions at completion without declaring the whole node idle', () => {
    const events = [state(1, 'worker', 'running'), item(2, 'read', 'commandExecution', { commandActions: [{ type: 'read' }] })]
    assert.equal(node(events).action?.label, 'Reading file…')
    assert.deepEqual(node([...events, end(3, 'read')]).action, null)
    assert.equal(node([...events, end(3, 'read')]).state, 'working')
  })
  it('clears a completed native turn and ignores its later start records', () => {
    const events = [state(1, 'worker', 'running'), item(2, 'read'),
      native(3, 'worker', 'turn.completed', { turn: { id: 'worker-turn' } }), item(4, 'late')]
    assert.equal(node(events).state, 'idle')
    assert.equal(node(events).action, null)
  })
  it('keeps all terminal Runs out of the live graph', () => {
    const value = project(handoff(), { run: { ...run, executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded' }, finishedAt: at } })
    assert.equal(value.active, false)
    assert.ok(value.nodes.every((entry) => entry.state === 'idle' && entry.action === null))
  })
  it('transitions retry wait and working state/action together', () => {
    const events = [...handoff(), review(5, 'blocked_disconnected')]
    assert.equal(node(events, 'review').state, 'waiting')
    assert.equal(node(events, 'review').action?.kind, 'waiting_review')
    events.push(review(6, 'leased', 'job', { attempt: 2 }), review(7, 'acknowledged', 'job', { attempt: 2 }))
    assert.equal(node(events, 'review').state, 'working')
    assert.equal(node(events, 'review').action?.kind, 'reviewing_request')
    events.push(review(8, 'completed'))
    assert.equal(node(events, 'review').state, 'idle')
  })
  it('treats an assigned pending review as active Orchestrator ownership', () => {
    const reviewNode = node([...handoff(), review(5, 'pending')], 'review')
    assert.equal(reviewNode.state, 'working')
    assert.equal(reviewNode.action?.kind, 'reviewing_request')
  })
  it('shows uncertain review and incomplete cleanup as waiting, never idle success', () => {
    assert.equal(node([...handoff(), review(5, 'uncertain')], 'review').state, 'waiting')
    const events = [...handoff(), review(5, 'failed', 'job', { cleanupPending: true })]
    assert.equal(node(events, 'review').action?.kind, 'checking_review')
    assert.equal(node([...events, review(6, 'failed', 'job', { cleanupPending: false })], 'review').state, 'idle')
  })
  it('does not treat a chosen decision as a native delivery', () => {
    const events = [...handoff(), interaction(5, 'decided', 'not_started')]
    assert.equal(node(events).state, 'waiting')
    assert.equal(node(events).action?.kind, 'waiting_delivery')
    events.push(interaction(6, 'delivered', 'delivered'))
    assert.equal(node(events).state, 'waiting')
    assert.equal(node(events).action, null)
    events.push(state(7, 'worker', 'running'))
    assert.equal(node(events).state, 'working')
    assert.equal(node(events).action, null)
  })
  it('ignores historical Runs even when their node/execution IDs collide', () => {
    const events = [state(1, 'worker', 'running'), { ...item(9, 'foreign', 'fileChange'), runId: 'old-run' }]
    assert.equal(node(events).action, null)
    assert.equal(project(events).sequence, '1')
  })
  it('replays shuffled and duplicate durable event identities deterministically', () => {
    const events = [...handoff(), review(8, 'completed'), interaction(9, 'delivered', 'delivered')]
    assert.deepEqual(project([...events].reverse()), project(events))
    assert.deepEqual(project([...events, ...events]), project(events))
  })
  it('uses bigint sequence ordering rather than timestamps or JS rounding', () => {
    const events = [state('9007199254740993', 'worker', 'completed'), state('9007199254740992', 'worker', 'running')]
    events[0]!.occurredAt = '2000-01-01T00:00:00.000Z'
    assert.equal(node(events).state, 'idle')
    assert.equal(project(events).sequence, '9007199254740993')
  })
  it('cannot resurrect an ended operation from a late or reconnect replay', () => {
    const events = [state(1, 'worker', 'running'), end(2, 'tool', 20), item(3, 'tool', 'fileChange', {}, 10),
      { ...item(4, 'tool', 'fileChange', {}, 1), native: { ...item(4, 'tool').native!, sourceSequence: '1', connectionId: 'reconnected' } }]
    assert.equal(node(events).action, null)
  })
  it('ignores a lower native source sequence for the same in-flight operation', () => {
    const events = [state(1, 'worker', 'running'), item(2, 'tool', 'fileChange', {}, 30), item(3, 'tool', 'commandExecution', {}, 10)]
    assert.equal(node(events).action?.kind, 'writing_file')
    assert.equal(node(events).event?.sequence, '2')
  })
  it('clears only the matching tool when native tools overlap', () => {
    const events = [state(1, 'worker', 'running'), item(2, 'a'), item(3, 'b', 'fileChange'), end(4, 'a')]
    assert.equal(node(events).action?.kind, 'writing_file')
    assert.equal(node([...events, end(5, 'b')]).action, null)
  })
  it('does not display a pending native tool as running', () => {
    const events = [state(1, 'worker', 'running'), item(2, 'a', 'fileChange', { status: 'pending' })]
    assert.equal(node(events).action, null)
    assert.equal(node([...events, item(3, 'a', 'fileChange')]).action?.kind, 'writing_file')
  })
  it('excludes unrelated old native turns rather than guessing which one is live', () => {
    const events = [state(1, 'worker', 'running'), item(2, 'a'), native(3, 'worker', 'item.started', {
      turnId: 'unrelated', item: { id: 'b', type: 'fileChange' },
    })]
    assert.equal(node(events).action, null)
  })

  it('does not let a queued review override a simultaneous active review', () => {
    const two = [...reviews, { executionId: 'exec-review', job: { id: 'job2', reviewerAgentId: 'orchestrator', interactionId: 'ask2' } }]
    const value = project([...handoff(), review(5, 'pending', 'job2')], { reviews: two })
    assert.equal(value.nodes[0]!.state, 'working')
    assert.equal(value.nodes[0]!.action?.kind, 'reviewing_request')
  })
  it('does not borrow state between two nodes using the same Agent', () => {
    const duplicate = { ...definition, nodes: [...definition.nodes, { id: 'worker2', agentId: 'coder', name: 'Second' }] }
    const value = project([state(1, 'worker', 'running'), item(2, 'tool', 'fileChange')], {
      definition: duplicate, executions: [...executions, execution('worker2', 'coder')],
    })
    assert.equal(value.nodes.find((entry) => entry.workflowNodeId === 'worker')!.state, 'working')
    assert.equal(value.nodes.find((entry) => entry.workflowNodeId === 'worker2')!.state, 'idle')
  })
})

// F5: reduce per job before aggregating one native reviewer node.
describe('parallel review jobs cannot overwrite a live turn', () => {
  const identities: LiveReviewIdentity[] = [...reviews, { executionId: 'exec-review', job: {
    id: 'job-B', reviewerAgentId: 'orchestrator', interactionId: 'ask2', providerTurnOrMessageId: 'review-turn-B',
  } }]
  const projected = (events: LiveActivityEvent[]) => project(events, { reviews: identities })
  const current = (events: LiveActivityEvent[], id: string) => projected(events).nodes.find((entry) => entry.workflowNodeId === id)!

  it('keeps A Working while B is pending or blocked_busy, then advances B independently', () => {
    const events = [...handoff(), review(5, 'acknowledged'), review(6, 'pending', 'job-B'), review(7, 'blocked_busy', 'job-B')]
    assert.equal(current(events, 'review').state, 'working')
    assert.equal(current(events, 'worker').state, 'waiting')
    assert.equal(current([...events, review(8, 'completed')], 'review').state, 'waiting')
    assert.equal(current([...events, review(8, 'completed'), review(9, 'leased', 'job-B')], 'review').state, 'working')
    assert.equal(current([...events, review(8, 'completed'), review(9, 'leased', 'job-B'), review(10, 'completed', 'job-B')], 'review').state, 'idle')
  })
  it('gives the same result with interleaved jobs returned out of order', () => {
    const events = [...handoff(), review(5, 'acknowledged'), review(6, 'pending', 'job-B'), review(7, 'blocked_busy', 'job-B')]
    assert.deepEqual(projected(events), projected([...events].reverse()))
  })
})

it('a persisted false-completion repair reopens only settlement, never an old tool action', () => {
  const events = [...handoff(), review(5, 'completed')]
  assert.equal(node([...events, review(6, 'uncertain')], 'review').state, 'idle')
  const repaired = node([...events, review(6, 'uncertain', 'job', { settlementReopened: true })], 'review')
  assert.equal(repaired.state, 'waiting')
  assert.equal(repaired.action?.kind, 'checking_review')
})
