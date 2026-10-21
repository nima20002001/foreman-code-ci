import { it } from 'vitest'
import assert from 'node:assert/strict'
import { createWorkflowNativeCaptureChannel, capturedWorkflowNativeTime } from '../src/modules/interactions/workflowNativeCapture.js'
import { createReviewNativeCaptureChannel } from '../src/modules/interactions/reviewNativeCapture.js'
import { assertOriginalWorkflowTerminal } from '../src/modules/interactions/workflowTerminalSource.js'
import { runStartSemantics } from '../src/modules/runs/repeatStartDispatch.js'
import type { WorkflowNativeCaptureInput } from '../src/modules/interactions/workflowNativeCapture.js'
import type { ReviewNativeCaptureInput } from '../src/modules/interactions/reviewNativeCapture.js'
import type { NativeHistory } from '../src/modules/harnesses/port.js'

// Deterministic UNIT sources, not actual provider, database or runtime proof.
// Fake physical ports belong to these private test channels only. A different
// channel (including production's) rejects every capture issued here.
function fixture() {
  let owned = true, resident = true, leaseHeld = true
  const execution = { id: 'exec-a2', runId: 'run-a2', workflowNodeId: 'node-a2', agentId: 'agent-a2',
    agentConfigurationVersionId: 'cfg-a2', attempt: 1, state: 'running', input: { executionSemanticsVersion: 3,
      runInput: { question: 'original' }, predecessors: [] }, nativeSessionId: 'thread-a2', createdAt: '2026-09-25T00:00:00.000Z' }
  const session = { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'thread-a2' }
  const lease = { fence: { id: 'lane-a2', token: 'lease-a2' }, previous: { connectionGeneration: 7 }, providerId: 'turn-a2' }
  const event = { executionId: execution.id, sequence: 3, connectionId: 'conn-a2', type: 'turn.completed',
    occurredAt: '2026-09-25T00:00:00.000Z', payload: { threadId: session.nativeSessionId, turnId: lease.providerId, status: 'completed' } }
  const history = { events: [event], pendingInteractions: [], responseDeliveries: [], correlationId: `execution:${execution.id}`,
    nativeTurnId: lease.providerId, terminalTurn: { correlationId: `execution:${execution.id}`, providerId: lease.providerId,
      result: { outcome: 'succeeded', output: { answer: 'original' } } } }
  const input = { execution, session, lease, lifetimeGeneration: 2, closureGeneration: '9', kind: 'live',
    owner: { runId: execution.runId, assertOwned() { assert.ok(owned, 'owner lost') } },
    manager: { harness: 'codex', assertCapturedLease(actual: unknown, writer: unknown) {
      assert.ok(leaseHeld, 'lease lost'); assert.deepEqual(actual, session); assert.equal(writer, lease)
    } }, source: { type: 'history', history }, assertCurrent() { assert.ok(resident, 'lifetime lost') } }
  const job = { id: 'review-a2', interactionId: 'interaction-a2', reviewerAgentId: execution.agentId,
    provider: 'codex', nativeSessionId: session.nativeSessionId, correlationId: 'review-command-a2', state: 'leased',
    attempt: 1, leaseToken: 'review-lease-a2', createdAt: event.occurredAt, updatedAt: event.occurredAt }
  return { input, execution, session, event, history, lease, job,
    workflow: () => input as unknown as WorkflowNativeCaptureInput,
    review: () => ({ ...input, job }) as unknown as ReviewNativeCaptureInput,
    loseOwner: () => { owned = false }, loseLifetime: () => { resident = false }, loseLease: () => { leaseHeld = false } }
}

it('A2 current discovery accepts only numeric 3; absence and retired tags do no work', () => {
  assert.equal(runStartSemantics({ executionSemanticsVersion: 3 }), 3)
  for (const value of [undefined, null, 1, 2, 4, '3', false, {}]) assert.throws(
    () => runStartSemantics({ executionSemanticsVersion: value }), { code: 'EXECUTION_SEMANTICS_UNSUPPORTED' })
})
it('A2 workflow capture freezes exact ordinary input without allocating occurrence metadata', () => {
  const f = fixture(), channel = createWorkflowNativeCaptureChannel(), capture = channel.capture.capture(f.workflow())
  f.history.terminalTurn.result.output.answer = 'mutated'
  f.execution.input.runInput.question = 'changed'
  const read = channel.verify.read(capture)
  assert.equal(read.source.type, 'history')
  if (read.source.type !== 'history') throw new Error('history expected')
  assert.deepEqual(read.source.history.terminalTurn!.result.output, { answer: 'original' })
  assert.deepEqual(read.execution.input, { executionSemanticsVersion: 3, runInput: { question: 'original' }, predecessors: [] })
  assert.equal(Object.hasOwn(read.execution.input as object, 'occurrence'), false)
  assert.equal(Object.isFrozen(read.source.history.events[0]!.payload), true)
  assert.equal(capturedWorkflowNativeTime(capture), read.observedAt)
})
it('A2 workflow capture rejects serialized JSON and structuredClone tokens', () => {
  const f = fixture(), channel = createWorkflowNativeCaptureChannel(), value = channel.capture.capture(f.workflow())
  for (const fake of [JSON.parse(JSON.stringify(value)), structuredClone(value), { ...value }]) {
    assert.throws(() => channel.verify.read(fake), { code: 'NATIVE_SOURCE_NOT_CAPTURED' })
    assert.throws(() => capturedWorkflowNativeTime(fake), { code: 'NATIVE_SOURCE_NOT_CAPTURED' })
  }
})
it('A2 workflow capture cannot cross production/channel identity', () => {
  const f = fixture(), a = createWorkflowNativeCaptureChannel(), b = createWorkflowNativeCaptureChannel()
  assert.throws(() => b.verify.read(a.capture.capture(f.workflow())), { code: 'NATIVE_SOURCE_NOT_CAPTURED' })
})
for (const loss of ['loseOwner', 'loseLifetime', 'loseLease'] as const) it(`A2 workflow proof rechecks ${loss} at consumption`, () => {
  const f = fixture(), c = createWorkflowNativeCaptureChannel(), token = c.capture.capture(f.workflow())
  f[loss](); assert.throws(() => c.verify.read(token))
})
for (const field of ['token', 'generation', 'turn'] as const) it(`A2 workflow proof rejects changed ${field} after capture`, () => {
  const f = fixture(), c = createWorkflowNativeCaptureChannel(), token = c.capture.capture(f.workflow())
  if (field === 'token') f.lease.fence.token = 'successor'
  if (field === 'generation') f.lease.previous.connectionGeneration++
  if (field === 'turn') f.lease.providerId = 'other-turn'
  assert.throws(() => c.verify.read(token), { code: 'NATIVE_SOURCE_NOT_CAPTURED' })
})
it('A2 native history cannot be captured without its actual writer lease', () => {
  const f = fixture(), input = f.workflow(); delete input.lease
  assert.throws(() => createWorkflowNativeCaptureChannel().capture.capture(input), { code: 'NATIVE_SOURCE_NOT_CAPTURED' })
})
it('A2 workflow source execution/session cannot be relabelled', () => {
  const f = fixture(); f.execution.nativeSessionId = 'other-thread'
  assert.throws(() => createWorkflowNativeCaptureChannel().capture.capture(f.workflow()), { code: 'NATIVE_SOURCE_NOT_CAPTURED' })
})
it('A2 reviewer history capture retains private original source and cannot cross channels', () => {
  const f = fixture(), a = createReviewNativeCaptureChannel(), b = createReviewNativeCaptureChannel()
  const token = a.capture.capture(f.review())
  f.history.events[0]!.payload.turnId = 'mutated'
  assert.equal(a.verify.read(token).source.type, 'history')
  const original = a.verify.read(token).source
  if (original.type !== 'history') throw new Error('history expected')
  assert.equal(original.history.events[0]!.payload.turnId, 'turn-a2')
  assert.throws(() => b.verify.read(token), { code: 'REVIEW_ORIGINAL_SOURCE_REQUIRED' })
  assert.throws(() => a.verify.read({ ...token }), { code: 'REVIEW_ORIGINAL_SOURCE_REQUIRED' })
})
it('A2 reviewer entry without an original review lease cannot grant submission', () => {
  const f = fixture(); f.job.leaseToken = ''
  assert.throws(() => createReviewNativeCaptureChannel().capture.capture(f.review()), { code: 'REVIEW_ORIGINAL_SOURCE_REQUIRED' })
})
it('A2 reviewer capture rejects a different agent/session or closure generation', () => {
  for (const mutate of [(f: ReturnType<typeof fixture>) => { f.job.reviewerAgentId = 'other' },
    (f: ReturnType<typeof fixture>) => { f.job.nativeSessionId = 'other' },
    (f: ReturnType<typeof fixture>) => { f.input.closureGeneration = '0' }]) {
    const f = fixture(); mutate(f)
    assert.throws(() => createReviewNativeCaptureChannel().capture.capture(f.review()), { code: 'REVIEW_ORIGINAL_SOURCE_REQUIRED' })
  }
})
for (const loss of ['loseLifetime', 'loseLease'] as const) it(`A2 reviewer source retains ${loss} fence`, () => {
  const f = fixture(), c = createReviewNativeCaptureChannel(), token = c.capture.capture(f.review())
  f[loss](); assert.throws(() => c.verify.read(token))
})
it('A2 Codex accepted terminal requires the exact original provider frame', () => {
  const f = fixture(); assertOriginalWorkflowTerminal(f.execution as never, f.session as never, f.history as NativeHistory)
})
for (const invalid of ['empty', 'wrong-turn', 'wrong-session', 'wrong-command', 'wrong-outcome', 'pending'] as const) {
  it(`A2 Codex terminal rejects ${invalid}; metadata alone is not proof`, () => {
    const f = fixture(), h = f.history as unknown as NativeHistory
    if (invalid === 'empty') h.events = []
    if (invalid === 'wrong-turn') h.events[0]!.payload.turnId = 'different'
    if (invalid === 'wrong-session') h.events[0]!.payload.threadId = 'different'
    if (invalid === 'wrong-command') h.terminalTurn!.correlationId = 'different'
    if (invalid === 'wrong-outcome') h.events[0]!.payload.status = 'failed'
    if (invalid === 'pending') h.pendingInteractions = [{} as never]
    assert.throws(() => assertOriginalWorkflowTerminal(f.execution as never, f.session as never, h), { code: 'NATIVE_TERMINAL_SOURCE_REQUIRED' })
  })
}
it('A2 Codex cold history can prove only its actual pinned completed turn', () => {
  const f = fixture(); f.history.events = [{ ...f.event, type: 'thread.reconciled', payload: { thread: {
    id: f.session.nativeSessionId, turns: [{ id: f.lease.providerId, status: 'completed', clientUserMessageId: f.history.correlationId }],
  } } } as never]
  assertOriginalWorkflowTerminal(f.execution as never, f.session as never, f.history as NativeHistory)
})

it('verifies a corrective terminal against its supplied execution correlation and original provider frame', () => {
  const f = fixture()
  const command = `execution:${f.execution.id}:result-repair:1`
  const history = { ...f.history, correlationId: command,
    terminalTurn: { ...f.history.terminalTurn, correlationId: command },
    events: [{ ...f.event, payload: { ...f.event.payload, clientCorrelationId: command } }],
  } as NativeHistory
  assertOriginalWorkflowTerminal(f.execution as never, f.session as never, history, command)
  assert.throws(() => assertOriginalWorkflowTerminal(f.execution as never, f.session as never, history),
    { code: 'NATIVE_TERMINAL_SOURCE_REQUIRED' })
  assert.throws(() => assertOriginalWorkflowTerminal(f.execution as never, f.session as never,
    { ...history, events: [] }, command), { code: 'NATIVE_TERMINAL_SOURCE_REQUIRED' })
})
