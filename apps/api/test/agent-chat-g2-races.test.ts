import assert from 'node:assert/strict'
import { SessionControlStateSchema, unavailableSessionControls, type CompactionState } from '@foreman-code/contracts'
import { afterEach, describe, it } from 'vitest'
import { agentChatCorrelation } from '../src/modules/conversations/agentChatRepository.js'
import { context, eventually, fixture } from './helpers/agentChatF1.js'
import { deferred } from './helpers/deferred.js'

// Production service/repository, scripted SQL and a controlled native port. This does not
// establish PostgreSQL isolation or provider behavior; separate adapter/SQL tests cover those.
const fixtures: ReturnType<typeof fixture>[] = []
const gates: ReturnType<typeof deferred<void>>[] = []
const operations: Promise<unknown>[] = []
function setup() { const f = fixture(); fixtures.push(f); return f }
function gate() { const value = deferred(); gates.push(value); return value }
function track<T>(operation: Promise<T>) { operations.push(operation); void operation.catch(() => undefined); return operation }
afterEach(async () => {
  for (const value of gates.splice(0)) value.resolve()
  await Promise.all(fixtures.splice(0).map((f) => f.service.shutdown()))
  await Promise.allSettled(operations.splice(0))
})
async function enqueue(f: ReturnType<typeof fixture>, requestId: string) {
  return f.repository.admit({ key: f.store.row.agent_key, context, request: f.request(requestId), delivery: 'queued',
    ownerPrincipalId: f.principal.id })
}
function countClaims(f: ReturnType<typeof fixture>) {
  let calls = 0
  const claim = f.repository.claim.bind(f.repository)
  f.repository.claim = async (...args) => {
    calls += 1
    // The broken pump otherwise starves timers in this synchronous SQL substitute.
    // This guard fails the count assertion; it is not permission to spin in production.
    if (calls > 8) throw new Error('Unbounded queue-claim retry detected')
    return claim(...args)
  }
  return () => calls
}
function observeSignals(f: ReturnType<typeof fixture>) {
  const signals = new Map<string, AbortSignal>()
  const start = f.manager.startTurn.bind(f.manager)
  f.manager.startTurn = async function* (session, input, signal) {
    assert(signal)
    signals.set(input.clientCorrelationId.split(':').at(-1)!, signal)
    yield* start(session, input, signal)
  }
  return signals
}
function assertConversationFirst(f: ReturnType<typeof fixture>) {
  const connections = new Set(f.store.statements.filter((entry) => entry.connection !== 0).map((entry) => entry.connection))
  let mutations = 0
  for (const connection of connections) {
    const statements = f.store.statements.filter((entry) => entry.connection === connection)
    const receipt = statements.findIndex((entry) => /^(update|delete from) operator_conversation_turns/.test(entry.sql))
    if (receipt < 0) continue
    mutations += 1
    const lock = statements.findIndex((entry) => entry.sql.startsWith('select ')
      && entry.sql.includes('from operator_conversations ') && entry.sql.endsWith('for update'))
    assert(lock >= 0 && lock < receipt, `Conversation must be locked before receipt mutation: ${statements.map((entry) => entry.sql).join('\n')}`)
    assert.equal(statements.at(-1)?.sql, 'commit')
  }
  assert(mutations > 0, 'The lock assertion must inspect at least one receipt mutation')
}

describe('G2 A2-PF-04: a stable claim fence is not a canceled queue head', () => {
  it('stops querying when a permanently unavailable conversation still has queued input', async () => {
    const f = setup(), claims = countClaims(f)
    await enqueue(f, 'B')
    f.store.row.record.sessionUnavailable = 'The exact native session is missing.'
    f.internals.pump(f.store.row.id)
    await eventually(() => !f.internals.tasks.has(f.store.row.id))
    assert.equal(claims(), 1)
    const queries = f.store.statements.length
    await new Promise<void>((done) => setImmediate(done))
    assert.equal(f.store.statements.length, queries)
    assert.equal(f.store.turns.get('B')?.delivery, 'queued')
    assert.deepEqual(f.manager.starts, [])
    // A later reconciliation pass also respects the permanent fence, not a retry storm.
    await f.service['repair'](f.store.row.id)
    assert.equal(claims(), 1)
  })

  it('stops on an unresolved orphan with no active pointer and leaves both receipts intact', async () => {
    const f = setup(), claims = countClaims(f)
    await enqueue(f, 'orphan'); assert.equal(await f.repository.claim(f.store.row.id, 'orphan'), true)
    f.store.row.active_request_id = null // Persisted legacy orphan, not evidence of settlement.
    await enqueue(f, 'B')
    f.internals.pump(f.store.row.id)
    await eventually(() => !f.internals.tasks.has(f.store.row.id))
    assert.equal(claims(), 2) // One setup claim, exactly one failed pump claim.
    const queries = f.store.statements.length
    await new Promise<void>((done) => setImmediate(done))
    assert.equal(f.store.statements.length, queries)
    assert.equal(f.store.turns.get('orphan')?.delivery, 'submitting')
    assert.equal(f.store.turns.get('B')?.delivery, 'queued')
    assert.deepEqual(f.manager.starts, [])
  })

  it('exits after a definite native failure settles A while B remains queued', async () => {
    const f = setup(), entered = gate(), release = gate(), claims = countClaims(f)
    // The existing F1 SQL substitute has no record-update handler; model only this storage boundary.
    f.repository.markSessionUnavailable = async (_id, reason, blockedReason = 'native_session_missing') => {
      f.store.row.record.sessionUnavailable = reason
      f.store.row.record.sessionUnavailableReason = blockedReason
    }
    f.manager.startTurn = async function* () {
      entered.resolve(); await release.promise
      yield* []
      throw Object.assign(new Error('Fixture: exact session is missing'), { code: 'CODEX_SESSION_NOT_FOUND', certainty: 'definite' })
    }
    await f.send('A'); await entered.promise; await f.send('B')
    release.resolve()
    await eventually(() => !f.internals.tasks.has(f.store.row.id))
    assert.equal(claims(), 2)
    assert.equal(f.store.row.active_request_id, null)
    assert(f.store.row.record.sessionUnavailable)
    assert.equal(f.store.turns.get('A')?.delivery, 'failed')
    assert.equal(f.store.turns.get('B')?.delivery, 'queued')
    const queries = f.store.statements.length
    await new Promise<void>((done) => setImmediate(done))
    assert.equal(f.store.statements.length, queries)
  })
})

describe('G2 A-R14: retain immediate reselection for a canceled selected head', () => {
  it('cancels B between selection and claim, then starts C and D once in FIFO order', async () => {
    const f = setup(), selected = gate(), resume = gate()
    await enqueue(f, 'B'); await enqueue(f, 'C'); await enqueue(f, 'D')
    const claim = f.repository.claim.bind(f.repository)
    f.repository.claim = async (id, requestId) => {
      if (requestId === 'B') { selected.resolve(); await resume.promise }
      return claim(id, requestId)
    }
    f.internals.pump(f.store.row.id)
    await selected.promise
    await f.service.cancelQueued(f.principal, context.workspaceId, f.store.row.id, 'B', { requestId: 'cancel-B' })
    resume.resolve(); await f.idle()
    assert.equal(f.store.turns.get('B')?.delivery, 'canceled')
    assert.equal(f.store.turns.get('C')?.delivery, 'completed')
    assert.equal(f.store.turns.get('D')?.delivery, 'completed')
    assert.deepEqual(f.manager.starts, ['C', 'D'])
    assert.equal(f.store.messages.size, 3)
  })
})

describe('G2 A2-PF-03: only durable terminal settlement detaches a turn observer', () => {
  it('keeps a live observer until commit, then unblocks B without canceling or replacing the session', async () => {
    const f = setup(), signals = observeSignals(f), entered = gate(), commit = gate()
    await f.active('A'); f.manager.holds.set('B', gate()); await f.send('B')
    // Nonterminal native evidence must not free either ownership or the observer.
    await f.service['repair'](f.store.row.id)
    assert.equal(signals.get('A')?.aborted, false)
    assert.equal(f.store.turns.get('B')?.delivery, 'queued')
    const finish = f.repository.finish.bind(f.repository)
    f.repository.finish = async (...args) => {
      if (args[1] === 'A') { entered.resolve(); await commit.promise }
      return finish(...args)
    }
    const history = f.manager.histories.get(agentChatCorrelation(f.store.row.id, 'A'))!
    history.terminalResult = { outcome: 'succeeded' } // Do not wake the fake stream with manager.finish().
    const recovery = track(f.service['repair'](f.store.row.id))
    await entered.promise
    assert.equal(signals.get('A')?.aborted, false)
    assert.equal(f.store.turns.get('A')?.delivery, 'accepted')
    assert.equal(f.store.turns.get('B')?.delivery, 'queued')
    commit.resolve(); await recovery
    await eventually(() => f.manager.starts.includes('B'))
    assert.equal(signals.get('A')?.aborted, true)
    assert.equal(signals.get('B')?.aborted, false)
    assert.equal(f.store.turns.get('A')?.delivery, 'completed')
    // A duplicate old settlement must not detach the next request's observer.
    await f.service['settle'](f.store.row.id, 'A', { outcome: 'succeeded' })
    assert.equal(signals.get('B')?.aborted, false)
    assert.deepEqual(f.manager.cancels, [])
    assert.equal(f.internals.runtimes.get(f.store.row.id)?.session, f.manager.session)
    f.manager.finish('B'); await f.idle()
    assert.deepEqual(f.manager.starts, ['A', 'B'])
  })

  it('does not detach after failed settlement or mismatching terminal history', async () => {
    const f = setup(), signals = observeSignals(f)
    await f.active('A'); await f.send('B')
    const finish = f.repository.finish.bind(f.repository)
    f.repository.finish = async () => { throw new Error('Fixture settlement transaction rolled back') }
    await assert.rejects(f.service['settle'](f.store.row.id, 'A', { outcome: 'succeeded' }), /rolled back/)
    assert.equal(signals.get('A')?.aborted, false)
    assert.equal(f.store.turns.get('B')?.delivery, 'queued')
    f.repository.finish = finish
    const history = f.manager.histories.get(agentChatCorrelation(f.store.row.id, 'A'))!
    history.nativeTurnId = 'wrong-turn'; history.terminalResult = { outcome: 'succeeded' }
    await f.service['repair'](f.store.row.id)
    assert.equal(signals.get('A')?.aborted, false)
    assert.equal(f.store.row.active_native_turn_id, 'turn-A')
    assert.deepEqual(f.manager.starts, ['A'])
    history.nativeTurnId = 'turn-A'
    await f.service['repair'](f.store.row.id); await f.idle()
    assert.deepEqual(f.manager.starts, ['A', 'B'])
  })
})

describe('G2 A2-PF-06: conversation-before-receipt transaction ordering', () => {
  for (const first of ['unknown', 'accepted'] as const) {
    it(`orders locks when ${first} arrives first and preserves the native/cancel fence`, async () => {
      const f = setup()
      await enqueue(f, 'A'); assert.equal(await f.repository.claim(f.store.row.id, 'A'), true)
      await f.repository.requestCancel(f.store.row.id, 'A')
      f.store.statements.length = 0
      if (first === 'unknown') {
        await f.repository.unknown(f.store.row.id, 'A', 'Fixture missing acknowledgement')
        await f.repository.accepted(f.store.row.id, 'A', 'native-A')
      } else {
        await f.repository.accepted(f.store.row.id, 'A', 'native-A')
        await f.repository.unknown(f.store.row.id, 'A', 'Fixture missing terminal evidence')
        await f.repository.accepted(f.store.row.id, 'A', 'native-A')
      }
      assertConversationFirst(f)
      assert.equal(f.store.turns.get('A')?.delivery, 'accepted')
      assert.equal(f.store.turns.get('A')?.native_turn_id, 'native-A')
      assert.equal(f.store.turns.get('A')?.delivery_error, null)
      assert.equal(f.store.row.active_request_id, 'A')
      assert.equal(f.store.row.active_native_turn_id, 'native-A')
      assert.equal(f.store.row.cancel_requested, true)
      await f.repository.finish(f.store.row.id, 'A', { outcome: 'canceled' })
      await f.repository.unknown(f.store.row.id, 'A', 'Late transport failure')
      assert.equal(await f.repository.accepted(f.store.row.id, 'A', 'native-A'), false)
      assert.equal(f.store.turns.get('A')?.delivery, 'canceled')
      assert.equal(f.store.row.active_request_id, null)
    })
  }

  it('also gives rejected-steer discard the conversation lock before deleting its receipt', async () => {
    const f = setup()
    await enqueue(f, 'A'); assert.equal(await f.repository.claim(f.store.row.id, 'A'), true)
    await f.repository.accepted(f.store.row.id, 'A', 'native-A')
    await f.repository.admit({ key: f.store.row.agent_key, context,
      request: f.request('steer', { intent: 'steer', expectedNativeTurnId: 'native-A' }), delivery: 'submitting', targetNativeTurnId: 'native-A' })
    f.store.statements.length = 0
    await f.repository.discard(f.store.row.id, 'steer')
    assertConversationFirst(f)
    assert.equal(f.store.turns.has('steer'), false)
    assert.equal(f.store.messages.size, 1)
    assert.equal(f.store.row.active_request_id, 'A')
    assert.equal(f.store.row.active_native_turn_id, 'native-A')
  })
})

describe('session controls during message admission', () => {
  function storedControls(f: ReturnType<typeof fixture>, status: CompactionState['status'] | null) {
    const record = SessionControlStateSchema.parse({
      conversationId: f.store.row.id,
      revision: 0,
      profileKey: 'profile',
      desiredMode: 'regular',
      appliedMode: null,
      defaults: {},
      desired: {},
      applied: null,
      applicability: 'next-turn',
      capabilities: unavailableSessionControls('profile'),
      context: null,
      nativeSessionId: f.manager.session.nativeSessionId,
      nativeProviderVersion: f.manager.session.providerVersion,
      compaction: status ? {
        requestId: 'compact-command',
        nativeSessionId: f.manager.session.nativeSessionId,
        nativeOperationId: null,
        status,
        message: 'Waiting for native compaction.',
        beforeTokens: null,
        observedAt: new Date().toISOString(),
      } : null,
      compactions: [],
      busyReason: null,
    })
    f.store.sessionControls.set(f.store.row.id, record)
  }

  for (const status of ['accepted', 'running', 'uncertain'] as const) {
    it(`rejects messages while compaction is ${status} without recording or starting a turn`, async () => {
      const f = setup()
      storedControls(f, status)
      await assert.rejects(enqueue(f, 'queued'), { code: 'SESSION_COMPACT_UNCONFIRMED' })
      await assert.rejects(f.send('sent'), { code: 'SESSION_COMPACT_UNCONFIRMED' })
      assert.equal(f.store.messages.size, 0)
      assert.equal(f.store.turns.size, 0)
      assert.deepEqual(f.manager.starts, [])
      assert.equal(f.store.sessionControls.get(f.store.row.id)?.revision, 0)
    })
  }

  it('persists the Plan choice with the admitted message before starting a native turn', async () => {
    const f = setup()
    storedControls(f, null)
    const admitted = await f.repository.admit({
      key: f.store.row.agent_key,
      context,
      request: f.request('planned', { sessionMode: 'plan' }),
      delivery: 'queued',
    })
    assert.equal(admitted.turn.delivery, 'queued')
    const state = f.store.sessionControls.get(f.store.row.id)!
    assert.equal(state.desiredMode, 'plan')
    assert.equal(state.applicability, 'next-turn')
    assert.equal(state.revision, 1)
    assert.equal(f.store.messages.size, 1)
    assert.deepEqual(f.manager.starts, [])
  })
})
