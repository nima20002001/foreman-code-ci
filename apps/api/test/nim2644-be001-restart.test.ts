import assert from 'node:assert/strict'
import { afterEach, it } from 'vitest'
import { currentRestartUnit, type RestartClosureRow } from './helpers/currentRestartUnit.js'

const connections: Array<{ close(): Promise<void> }> = []
function fixture(reviewer = false) { const f = currentRestartUnit(reviewer); connections.push(f.connection); return f }
afterEach(async () => { await Promise.all(connections.splice(0).map((connection) => connection.close())) })
function pendingClosure(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(pendingClosure)
  if (!(error instanceof Error)) return false
  if ('code' in error && ['REPEAT_CLEANUP_PENDING', 'NATIVE_WORKFLOW_CLOSURE_CONFLICT'].includes(String(error.code))) return true
  if (error.message === 'RUN_OWNERSHIP_LOST') return true
  // attemptCleanup adds execution-local context. Only known, nested fence/
  // uncertainty errors count; an unscripted SQL error must still fail the test.
  return error.cause !== undefined && pendingClosure(error.cause)
}
function assertNoRestartEffects(f: ReturnType<typeof fixture>) {
  assert.equal(f.state.stopped, false); assert.equal(f.state.cleanup, false)
  assert.equal(f.state.revocations, 0); assert.equal(f.state.budgetStops, 0)
  assert.equal(f.state.interactionCancels, 0); assert.equal(f.state.retirementCalls, 0)
  assert.equal(f.state.finalizationWrites, 0); assert.equal(f.state.cancels, 0)
  assert.equal(f.state.creates, 0); assert.equal(f.state.turns, 0)
}

it('BE-001 restart: registers before credential preflight/attachment and recovers committed close with entirely fresh coordinator/resolver', async () => {
  const f = fixture(), first = f.cold()
  f.beforePreflight(() => { assert.equal(f.rows().length, 1); assert.equal(f.rows()[0]!.closed, false); assert.equal(f.state.attaches, 0) })
  await first.attachOriginal()
  await f.stop(first)
  assert.equal(f.rows()[0]!.closed, true); assert.equal(f.state.finalized, false)
  f.terminal()
  const before = structuredClone(f.execution()), fresh = f.cold()
  const calls = { closes: f.state.closes, attaches: f.state.attaches, resolutions: f.state.resolutions }
  assert.deepEqual(fresh.coordinator.residentRunIds(), [])
  await f.finalize(fresh)
  assert.equal(f.state.finalized, true)
  assert.deepEqual({ closes: f.state.closes, attaches: f.state.attaches, resolutions: f.state.resolutions }, calls)
  assert.equal(f.state.creates, 0); assert.equal(f.state.turns, 0)
  await f.finalize(fresh)
  assert.equal(f.state.finalizationWrites, 1); assert.equal(f.state.closeWrites, 1)
  assert.deepEqual(f.execution(), before)
})

it('BE-001 restart: registration failure prevents credential/native preflight', async () => {
  const f = fixture(), first = f.cold(); f.state.failBegin = true
  await assert.rejects(first.attachOriginal(), /registration failure/)
  assert.equal(f.state.preflightCalls, 0); assert.equal(f.state.attaches, 0); assert.equal(f.rows().length, 0)
})

it('BE-001 restart: uncertain native close never creates a receipt, even after terminal settlement and cold recovery', async () => {
  const f = fixture(), first = f.cold()
  await first.attachOriginal()
  f.state.failNativeClose = true
  await assert.rejects(f.stop(first), AggregateError)
  assert.equal(f.rows()[0]!.closed, false)
  f.terminal()
  await assert.rejects(f.finalize(f.cold()), pendingClosure)
  assert.equal(f.state.finalized, false); assert.equal(f.state.attaches, 1)
})

it('BE-001 restart: raw close followed by receipt write failure stays uncertain after restart', async () => {
  const f = fixture(), first = f.cold()
  await first.attachOriginal()
  f.state.failCloseWrite = true
  await assert.rejects(f.stop(first), AggregateError)
  f.terminal()
  assert.equal(f.state.closes, 1); assert.equal(f.rows()[0]!.closed, false)
  await assert.rejects(f.finalize(f.cold()), pendingClosure)
  assert.equal(f.state.finalized, false)
})

it('BE-001 restart: lost close COMMIT reply is reconciled from durable evidence without another native close', async () => {
  const f = fixture(), first = f.cold()
  await first.attachOriginal()
  f.state.loseCommitReply = true
  await assert.rejects(f.stop(first), AggregateError)
  f.terminal()
  assert.equal(f.rows()[0]!.closed, true)
  await f.finalize(f.cold())
  assert.equal(f.state.finalized, true); assert.equal(f.state.closes, 1)
})

it('BE-001 restart: a later registered preflight masks an old close before any replacement native attachment', async () => {
  const f = fixture(), first = f.cold()
  // Isolate the closure-store lifetime seam while Run authority is still live.
  // An old Stop cannot be cleared merely to manufacture permission to attach.
  const generation = await first.store.begin(f.execution())
  const proof = await first.store.record(f.execution(), f.session, generation, () => undefined)
  assert.ok(proof); assert.equal(f.rows()[0]!.closed, true)
  const next = await f.cold().store.begin(f.execution())
  assert.notEqual(next, generation)
  assert.equal(await first.store.read(f.execution()), undefined)
  f.terminal()
  await assert.rejects(f.finalize(first), pendingClosure)
  await assert.rejects(f.finalize(f.cold()), pendingClosure)
  assert.equal(f.state.finalized, false); assert.equal(f.rows()[0]!.closed, true); assert.equal(f.state.attaches, 0)
})

it('BE-001 restart: current registration refuses an overlapping generation before a stale close can be published', async () => {
  const f = fixture(), first = f.cold()
  await first.attachOriginal()
  f.beforeClose(async () => { await f.cold().store.begin(f.execution()) })
  await assert.rejects(f.stop(first), AggregateError)
  // begin now prevents the invalid second lifetime, earlier than the retired seam.
  assert.equal(f.rows().length, 1); assert.ok(f.rows().every((row) => !row.closed && !row.detached))
  assert.equal(f.state.attaches, 1); assert.equal(f.state.finalizationWrites, 0)
})

it('BE-001 restart: missing receipts and mismatched execution/session/provider evidence are not recovery proof', async () => {
  const empty = fixture(); empty.terminal()
  await assert.rejects(empty.finalize(empty.cold()), pendingClosure)
  for (const corrupt of [
    (row: RestartClosureRow) => { row.closed_reference = { harness: 'claude', providerVersion: 'other', nativeSessionId: 'other' } },
    (row: RestartClosureRow) => { row.expected_reference = { harness: 'codex', providerVersion: 'other', nativeSessionId: 'other' } },
    (row: RestartClosureRow) => { row.execution_identity = { ...(row.execution_identity as object), agentConfigurationVersionId: 'other' } },
    (row: RestartClosureRow) => { row.execution_identity = { ...(row.execution_identity as object), runtimeDirectory: '/other' } },
  ]) {
    const f = fixture(), first = f.cold()
    await first.attachOriginal()
    await f.stop(first)
    corrupt(f.rows()[0]!) // Deliberate SQL read-side corruption, never a native action.
    f.terminal()
    await assert.rejects(f.finalize(f.cold()), pendingClosure)
    assert.equal(f.state.finalized, false); assert.equal(f.state.attaches, 1)
  }
})

it('BE-001 restart: durable close cannot bypass resource obligations or a lost finalization owner', async () => {
  for (const mode of ['outstanding', 'owner'] as const) {
    const f = fixture(), first = f.cold()
    await first.attachOriginal()
    await f.stop(first); f.terminal()
    if (mode === 'outstanding') f.state.outstanding = true
    else f.state.loseAtFinalFence = true
    await assert.rejects(f.finalize(f.cold()), pendingClosure)
    assert.equal(f.state.finalized, false); assert.equal(f.state.finalizationWrites, 0)
    assert.equal(f.rows()[0]!.closed, true)
    assert.ok(f.statements.includes('rollback'))
    if (mode === 'owner') assert.ok(f.statements.some((q) => q.startsWith('update execution_native_sessions')),
      'loss after the write must roll the actual finalization mutation back')
  }
})

it('BE-001 restart: an older unconfirmed lifetime prevents a newer preflight instead of hiding behind its close', async () => {
  const f = fixture(), first = f.cold()
  await first.store.begin(f.execution())
  await assert.rejects(first.attachOriginal(), { code: 'NATIVE_WORKFLOW_CLOSURE_CONFLICT' })
  assert.equal(f.rows().length, 1); assert.equal(f.rows()[0]!.closed, false)
  assert.equal(f.state.preflightCalls, 0); assert.equal(f.state.attaches, 0)
  f.terminal()
  await assert.rejects(f.finalize(f.cold()), pendingClosure)
  assert.equal(f.state.finalized, false)
})

for (const reviewer of [false, true]) it(`BE-001 graceful restart: ${reviewer ? 'completed Orchestrator reviewer' : 'waiting Worker'} detaches, then a cold requester reconciles without replay`, async () => {
  const f = fixture(reviewer), first = f.cold()
  await first.attachOriginal()
  const before = structuredClone(f.execution())
  const original = f.rows().at(-1)!, count = reviewer ? 2 : 1
  assert.equal(f.rows().length, count)
  if (reviewer) assert.equal(f.rows()[0]!.closed, true, 'reviewer admission retains the original workflow close')
  await first.coordinator.closeForRestart()
  assert.equal(f.rows().at(-1)!.closed, false); assert.equal(f.rows().at(-1)!.detached, true)
  assert.equal(original.generation, String(count)); assert.deepEqual(f.execution(), before)
  assert.equal(await first.store.read(f.execution()), undefined, 'restart is not a terminal close proof')
  assertNoRestartEffects(f); assert.equal(f.state.restartCloses, 1)
  await assert.rejects(first.coordinator.attachOwnedSession(f.context(), f.session), /shutting down/)
  const fresh = f.cold(), calls = { attaches: f.state.attaches, resolutions: f.state.resolutions, preflight: f.state.preflightCalls }
  await assert.rejects(fresh.coordinator.attachOwnedSession(f.context(), f.session), { code: 'NATIVE_SESSION_RECOVERY_REQUIRED' })
  assert.equal(f.rows().length, count)
  assert.deepEqual({ attaches: f.state.attaches, resolutions: f.state.resolutions, preflight: f.state.preflightCalls }, calls)
  assert.equal(await fresh.store.read(f.execution()), undefined)
  assert.equal(f.state.closes, 1); assert.equal(f.state.attaches, 1); assert.equal(f.state.restartCloses, 1)
  assertNoRestartEffects(f)
  assert.equal(await fresh.coordinator.requestColdRunCleanup(f.owner), reviewer)
  assert.equal(f.state.cleanup, reviewer); assert.equal(f.state.stopped, false)
  assert.deepEqual(f.execution(), before)
  assert.equal(f.state.creates, 0); assert.equal(f.state.turns, 0); assert.equal(f.state.attaches, 1)
})

it('BE-001 graceful restart: coalesces disposal and does not record detachment before the actual close resolves', async () => {
  const f = fixture(), first = f.cold()
  await first.attachOriginal()
  let release!: () => void, entered!: () => void
  const permit = new Promise<void>((resolve) => { release = resolve }), called = new Promise<void>((resolve) => { entered = resolve })
  f.beforeClose(async () => { entered(); await permit })
  const closing = first.coordinator.closeForRestart(), same = first.coordinator.closeForRestart()
  assert.equal(closing, same)
  await called
  assert.equal(f.rows()[0]!.closed, false); assert.equal(f.rows()[0]!.detached, false)
  release(); await closing; await first.coordinator.closeForRestart()
  assert.equal(f.rows()[0]!.detached, true)
  assert.equal(f.state.closes, 1); assert.equal(f.state.closeWrites, 1)
})

it('BE-001 graceful restart: native close rejection preserves uncertainty; only the same manager successful retry can record detachment', async () => {
  const f = fixture(), first = f.cold()
  await first.attachOriginal()
  f.state.failNativeClose = true
  await assert.rejects(first.coordinator.closeForRestart(), AggregateError)
  assert.equal(f.rows()[0]!.closed, false); assert.equal(f.rows()[0]!.detached, false)
  assert.equal(await f.cold().store.read(f.execution()), undefined)
  f.state.failNativeClose = false; await first.coordinator.closeForRestart()
  assert.equal(f.rows()[0]!.detached, true); assert.equal(f.rows()[0]!.closed, false)
  assert.equal(f.state.closes, 2); assert.equal(f.state.attaches, 1); assertNoRestartEffects(f)
})

it('BE-001 graceful restart: receipt write failure cannot become shutdown success or a reusable close proof', async () => {
  const f = fixture(), first = f.cold()
  await first.attachOriginal()
  f.state.failCloseWrite = true
  await assert.rejects(first.coordinator.closeForRestart(), AggregateError)
  assert.equal(f.rows()[0]!.closed, false); assert.equal(f.rows()[0]!.detached, false)
  assert.equal(await f.cold().store.read(f.execution()), undefined)
  f.state.failCloseWrite = false; await first.coordinator.closeForRestart()
  assert.equal(f.rows()[0]!.detached, true); assert.equal(f.rows()[0]!.closed, false)
  assert.equal(f.state.closes, 1); assert.equal(f.state.restartCloses, 2); assert.equal(f.state.beginCalls, 1)
})

it('BE-001 graceful restart: lost receipt COMMIT reply retries persistence without another native close', async () => {
  const f = fixture(), first = f.cold()
  await first.attachOriginal()
  f.state.loseCommitReply = true
  await assert.rejects(first.coordinator.closeForRestart(), AggregateError)
  assert.equal(f.rows()[0]!.detached, true); assert.equal(f.rows()[0]!.closed, false)
  await first.coordinator.closeForRestart()
  assert.equal(await first.store.read(f.execution()), undefined)
  assert.equal(f.rows()[0]!.generation, '1')
  assert.equal(f.state.closes, 1); assert.equal(f.state.restartCloses, 2); assert.equal(f.state.closeWrites, 1)
})

it('BE-001 graceful restart: a genuinely unclosed predecessor blocks a later matching-session attachment', async () => {
  const f = fixture(), first = f.cold()
  await first.attachOriginal()
  const fresh = f.cold()
  await assert.rejects(fresh.coordinator.attachOwnedSession(f.context(), f.session), { code: 'NATIVE_SESSION_RECOVERY_REQUIRED' })
  assert.equal(f.rows().length, 1); assert.ok(f.rows().every((row) => !row.closed && !row.detached))
  assert.equal(await fresh.store.read(f.execution()), undefined)
  assert.equal(f.state.attaches, 1); assert.equal(f.state.preflightCalls, 1)
  f.terminal()
  await assert.rejects(f.finalize(f.cold()), pendingClosure)
  assert.equal(f.state.finalized, false)
})

it('BE-001 graceful restart: a second generation attempted during close cannot lend proof to the obsolete disposer', async () => {
  const f = fixture(), first = f.cold()
  await first.attachOriginal()
  f.beforeClose(async () => { await f.cold().store.begin(f.execution()) })
  await assert.rejects(first.coordinator.closeForRestart(), AggregateError)
  assert.equal(f.rows().length, 1); assert.ok(f.rows().every((row) => !row.closed && !row.detached))
  assert.equal(f.state.finalizationWrites, 0); assertNoRestartEffects(f)
})

it('BE-001 graceful restart: detached evidence cannot be promoted into Stop settlement', async () => {
  const f = fixture(), first = f.cold()
  await first.attachOriginal()
  await first.coordinator.closeForRestart(); f.terminal()
  await assert.rejects(f.finalize(f.cold()), pendingClosure)
  assert.equal(f.rows()[0]!.closed, false); assert.equal(f.rows()[0]!.detached, true)
  assert.equal(f.state.finalized, false); assert.equal(f.state.attaches, 1)
})

it('BE-001 cleanup predicates reject unrelated SQL failures even inside execution-local wrappers', () => {
  const pending = Object.assign(new Error('positive native closure missing'), { code: 'REPEAT_CLEANUP_PENDING' })
  assert.equal(pendingClosure(new AggregateError([new Error('execution: recover original native lifetime', { cause: pending })])), true)
  assert.equal(pendingClosure(new AggregateError([new Error('execution: recover original native lifetime', {
    cause: new Error('Unexpected current restart SQL: select missing_fixture'),
  })])), false)
  assert.equal(pendingClosure(new AggregateError([])), false)
})
