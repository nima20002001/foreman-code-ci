import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { afterEach, describe, it } from 'vitest'
import type { ExecutionResult } from '@foreman-code/contracts'
import { agentChatInputHash, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { context, eventually, fixture } from './helpers/agentChatF1.js'
import { deferred } from './helpers/deferred.js'

const fixtures: ReturnType<typeof fixture>[] = []
const gates: ReturnType<typeof deferred<void>>[] = []
const operations: Promise<unknown>[] = []
function setup() { const f = fixture(); fixtures.push(f); return f }
function gate() { const value = deferred(); gates.push(value); return value }
function track<T>(promise: Promise<T>) { operations.push(promise); void promise.catch(() => undefined); return promise }
afterEach(async () => {
  for (const value of gates.splice(0)) value.resolve()
  await Promise.all(fixtures.splice(0).map((f) => f.service.shutdown()))
  await Promise.allSettled(operations.splice(0))
})

// These tests call the real service and repository, with scripted SQL and a controlled native port.
// No database, HTTP server or real provider is launched. PostgreSQL isolation still needs integration testing.
describe('F1 A-R04: interrupts stay bound to the pre-admission turn', () => {
  it('does not self-cancel urgent input claimed after admission but before interrupt dispatch', async () => {
    const f = setup(); await f.active()
    const admitted = gate(), resume = gate()
    f.manager.holds.set('urgent', gate())
    const admit = f.repository.admit.bind(f.repository)
    f.repository.admit = async (input) => {
      const result = await admit(input)
      if (input.request.requestId === 'urgent' && !result.replayed) { admitted.resolve(); await resume.promise }
      return result
    }
    const sending = track(f.send('urgent', { intent: 'interrupt_and_send', expectedNativeTurnId: 'turn-A' }))
    await admitted.promise
    const boundReceipt = structuredClone(f.store.turns.get('urgent'))
    const canceledAtAdmission = f.store.row.cancel_requested
    f.manager.finish('A')
    await eventually(() => f.store.row.active_native_turn_id === 'turn-urgent')
    resume.resolve(); await sending
    assert.deepEqual(f.manager.cancels, [])
    assert.equal(boundReceipt?.target_native_turn_id, 'turn-A')
    assert.equal(boundReceipt?.payload.interruptRequestId, 'A')
    assert.equal(canceledAtAdmission, true)
    assert.equal(f.store.row.cancel_requested, false)
    assert.deepEqual(f.manager.starts, ['A', 'urgent'])
    f.manager.finish('urgent'); await f.idle()
    assert.equal(f.store.turns.get('urgent')?.delivery, 'completed')
    assert.equal((await f.send('urgent', { intent: 'interrupt_and_send', expectedNativeTurnId: 'turn-A' })).replayed, true)
    assert.deepEqual(f.manager.starts, ['A', 'urgent'])
  })

  it('interrupts the old owner once and runs urgent input ahead of the FIFO queue', async () => {
    const f = setup(); await f.active()
    await f.send('B'); await f.send('C')
    await f.send('urgent', { intent: 'interrupt_and_send', expectedNativeTurnId: 'turn-A' })
    await f.idle()
    assert.deepEqual(f.manager.cancels, ['turn-A'])
    assert.deepEqual(f.manager.starts, ['A', 'urgent', 'B', 'C'])
    assert.equal(f.store.turns.get('A')?.delivery, 'canceled')
    assert.equal(f.store.turns.get('urgent')?.delivery, 'completed')
    const cancel = f.store.statements.find((entry) => entry.sql.includes('set cancel_requested=true'))!
    const transaction = f.store.statements.filter((entry) => entry.connection === cancel.connection)
    assert(transaction.findIndex((entry) => entry.sql.includes('for update')) < transaction.indexOf(cancel))
    assert(transaction.some((entry) => entry.sql.startsWith('insert into operator_conversation_turns') && entry.values[1] === 'urgent'))
    assert.equal(transaction.at(-1)?.sql, 'commit')
  })

  it('treats a stale interrupt-and-send target as normal queued input, not a cancel of the newer turn', async () => {
    const f = setup(); await f.active('B')
    const sent = await f.send('urgent', { intent: 'interrupt_and_send', expectedNativeTurnId: 'turn-A' })
    assert.equal(sent.turn.targetNativeTurnId, 'turn-A')
    assert.equal(f.store.row.cancel_requested, false)
    assert.deepEqual(f.manager.cancels, [])
    f.manager.finish('B'); await f.idle()
    assert.deepEqual(f.manager.starts, ['B', 'urgent'])
    assert.equal(f.store.turns.get('urgent')?.delivery, 'completed')
  })

  it('rejects a plain interrupt whose target changes after authorization, without canceling the queue', async () => {
    const f = setup(); await f.active()
    f.manager.holds.set('B', gate()); await f.send('B'); await f.send('C')
    const get = f.repository.get.bind(f.repository)
    let armed = true
    f.repository.get = async (...args) => {
      const row = await get(...args)
      if (armed) {
        armed = false; f.manager.finish('A')
        await eventually(() => f.store.row.active_native_turn_id === 'turn-B')
      }
      return row
    }
    await assert.rejects(f.service.interrupt(f.principal, context.workspaceId, f.store.row.id,
      { requestId: 'stale-interrupt', expectedNativeTurnId: 'turn-A' }), { code: 'AGENT_CHAT_TURN_NOT_ACTIVE' })
    assert.deepEqual(f.manager.cancels, [])
    assert.equal(f.store.turns.get('C')?.delivery, 'queued')
    assert.equal(f.store.row.cancel_requested, false)
    assert.deepEqual(f.dispatchAttempts, [])
    f.manager.finish('B'); await f.idle()
  })

  it('never retargets a committed plain interrupt to a newly admitted turn', async () => {
    const f = setup(); await f.active(); await f.send('queued')
    const committed = gate(), resume = gate()
    const interrupt = f.repository.interrupt.bind(f.repository)
    f.repository.interrupt = async (...args) => {
      const target = await interrupt(...args); committed.resolve(); await resume.promise; return target
    }
    const stopping = track(f.service.interrupt(f.principal, context.workspaceId, f.store.row.id,
      { requestId: 'captured-interrupt', expectedNativeTurnId: 'turn-A' }))
    await committed.promise
    assert.equal(f.store.turns.get('queued')?.delivery, 'canceled')
    f.manager.holds.set('later', gate()); await f.send('later'); f.manager.finish('A')
    await eventually(() => f.store.row.active_native_turn_id === 'turn-later')
    resume.resolve(); await stopping
    assert.deepEqual(f.dispatchAttempts, ['captured-interrupt'])
    assert.deepEqual(f.manager.cancels, [])
    assert.equal(f.store.row.cancel_requested, false)
    f.manager.finish('later'); await f.idle()
    assert.deepEqual(f.manager.starts, ['A', 'later'])
  })

  it('keeps a pre-native interrupt bound to its starting request until onSubmitted observes it', async () => {
    const f = setup(), starting = gate(), resume = gate()
    f.manager.holds.set('A', gate())
    const accepted = f.repository.accepted.bind(f.repository)
    let held = false
    f.repository.accepted = async (...args) => {
      if (args[1] === 'A' && !held) { held = true; starting.resolve(); await resume.promise }
      return accepted(...args)
    }
    await f.send('A'); await starting.promise
    assert.equal(f.store.row.active_native_turn_id, null)
    await f.send('urgent', { intent: 'interrupt_and_send' })
    assert.equal(f.store.turns.get('urgent')?.payload.interruptRequestId, 'A')
    assert.equal(f.store.row.cancel_requested, true)
    assert.deepEqual(f.manager.cancels, [])
    resume.resolve(); await f.idle()
    assert.deepEqual(f.manager.cancels, ['turn-A'])
    assert.deepEqual(f.manager.starts, ['A', 'urgent'])
    assert.equal(f.store.turns.get('urgent')?.delivery, 'completed')
  })

  it('rejects an expected plain-interrupt target on an idle conversation before any mutation', async () => {
    const f = setup()
    await assert.rejects(f.service.interrupt(f.principal, context.workspaceId, f.store.row.id,
      { requestId: 'idle-interrupt', expectedNativeTurnId: 'turn-ended' }), { code: 'AGENT_CHAT_TURN_NOT_ACTIVE' })
    assert(!f.store.statements.some((entry) => entry.sql.startsWith('update ')))
    assert.deepEqual(f.manager.cancels, [])
  })
})

describe('F1 A-R05: caller-observed steering preconditions and replay identity', () => {
  it('rejects missing and stale expected turns before receipt, message or native submission', async () => {
    const f = setup(); await f.active()
    for (const extra of [{}, { expectedNativeTurnId: 'turn-stale' }]) {
      await assert.rejects(f.send('steer', { intent: 'steer', ...extra }), { code: 'AGENT_CHAT_TURN_NOT_ACTIVE' })
      assert.equal(f.store.turns.has('steer'), false)
      assert.equal(f.store.messages.size, 1)
      assert.deepEqual(f.manager.steers, [])
    }
  })

  it('returns an exact replay after completion and conflicts on a changed native target', async () => {
    const f = setup(); await f.active()
    await f.send('steer', { intent: 'steer', expectedNativeTurnId: 'turn-A' })
    f.manager.finish('A'); await f.idle(); await f.active('B')
    const replay = await f.send('steer', { intent: 'steer', expectedNativeTurnId: 'turn-A' })
    assert.equal(replay.replayed, true); assert.equal(replay.turn.delivery, 'completed')
    await assert.rejects(f.send('steer', { intent: 'steer', expectedNativeTurnId: 'turn-B' }), { code: 'AGENT_CHAT_REQUEST_CONFLICT' })
    assert.equal(f.manager.steers.length, 1)
    assert.equal(f.store.messages.size, 3)
  })

  it('rechecks the steer target under the admission lock after the preliminary service check', async () => {
    const f = setup(); await f.active()
    const entering = gate(), resume = gate()
    const admit = f.repository.admit.bind(f.repository)
    f.repository.admit = async (input) => {
      if (input.request.requestId === 'steer') { entering.resolve(); await resume.promise }
      return admit(input)
    }
    const sending = track(f.send('steer', { intent: 'steer', expectedNativeTurnId: 'turn-A' }))
    await entering.promise; f.manager.finish('A')
    await eventually(() => f.store.turns.get('A')?.delivery === 'completed')
    resume.resolve()
    await assert.rejects(sending, { code: 'AGENT_CHAT_TURN_NOT_ACTIVE' })
    assert.equal(f.store.turns.has('steer'), false)
    assert.equal(f.store.messages.size, 1)
    assert(!f.store.statements.some((entry) => entry.sql.startsWith('insert into operator_conversation_turns') && entry.values[1] === 'steer'))
    assert.deepEqual(f.manager.steers, [])
  })

  it('hashes target changes while preserving untargeted receipt identities', () => {
    const f = setup(), request = f.request('request')
    const legacy = createHash('sha256').update(JSON.stringify([request.content, request.intent, request.context])).digest('hex')
    assert.equal(agentChatInputHash(request), legacy)
    assert.notEqual(agentChatInputHash(request), agentChatInputHash({ ...request, expectedNativeTurnId: 'turn-A' }))
    assert.notEqual(agentChatInputHash({ ...request, expectedNativeTurnId: 'turn-A' }), agentChatInputHash({ ...request, expectedNativeTurnId: 'turn-B' }))
  })
})

describe('F1 A-R06: terminal settlement and late steer acknowledgement', () => {
  for (const [result, delivery] of [
    [{ outcome: 'succeeded' }, 'completed'],
    [{ outcome: 'failed', error: { code: 'FIXTURE_FAILED', message: 'Fixture failure', retryable: false } }, 'failed'],
    [{ outcome: 'canceled' }, 'canceled'],
  ] satisfies Array<[ExecutionResult, string]>) {
    it(`settles a late acknowledged steer as ${delivery} after its target transaction commits`, async () => {
      const f = setup(); await f.active()
      const received = gate(), reply = gate()
      f.manager.steerReply = async (input) => { received.resolve(); await reply.promise; return { nativeTurnId: input.expectedTurnId } }
      const sending = track(f.send('steer', { intent: 'steer', expectedNativeTurnId: 'turn-A' }))
      await received.promise; f.manager.finish('A', result)
      await eventually(() => f.store.turns.get('A')?.delivery === delivery)
      assert.equal(f.store.turns.get('steer')?.delivery, 'submitting')
      reply.resolve()
      const sent = await sending
      assert.equal(sent.turn.delivery, delivery)
      assert.equal((await f.read()).turns.find((turn) => turn.requestId === 'steer')?.delivery, delivery)
      assert.equal(f.manager.steers.length, 1)
      const ack = f.store.statements.find((entry) => entry.sql.startsWith('update operator_conversation_turns set delivery=$4'))!
      const transaction = f.store.statements.filter((entry) => entry.connection === ack.connection)
      assert(transaction.findIndex((entry) => entry.sql.includes('for update')) < transaction.indexOf(ack))
      assert.equal(transaction.at(-1)?.sql, 'commit')
    })
  }

  it('also settles acknowledgement-before-completion without replaying the steer', async () => {
    const f = setup(); await f.active()
    assert.equal((await f.send('steer', { intent: 'steer', expectedNativeTurnId: 'turn-A' })).turn.delivery, 'accepted')
    f.manager.finish('A'); await f.idle()
    assert.equal(f.store.turns.get('steer')?.delivery, 'completed')
    assert.equal(f.manager.steers.length, 1)
  })

  it('uses durable target evidence for a late unknown-steer ACK after repository reconstruction and a later turn', async () => {
    const f = setup(); await f.active()
    f.manager.steerReply = async () => { throw new Error('Fixture transport lost the ACK.') }
    assert.equal((await f.send('steer', { intent: 'steer', expectedNativeTurnId: 'turn-A' })).turn.delivery, 'unknown')
    f.manager.finish('A', { outcome: 'canceled' }); await f.idle()
    // Target completion alone never proves that this unknown steer was accepted.
    assert.equal(f.store.turns.get('steer')?.delivery, 'unknown')
    await f.send('later'); await f.idle()
    assert.equal(f.store.row.last_result?.outcome, 'succeeded')
    const restartedRepository = new PostgresAgentChatRepository(f.store.pool)
    // Model a positive late ACK/history result; no resend and no process-local terminal cache.
    await restartedRepository.steerAccepted(f.store.row.id, 'steer', 'turn-A')
    const receipt = await restartedRepository.turn(f.store.row.id, 'steer')
    assert.equal(receipt?.delivery, 'canceled'); assert.equal(receipt?.error, undefined)
    assert.equal(f.manager.steers.length, 1)
    assert.deepEqual(f.manager.starts, ['A', 'later'])
  })

  it('keeps a mismatched native steer acknowledgement unknown rather than settling another turn', async () => {
    const f = setup(); await f.active()
    f.manager.steerReply = async () => ({ nativeTurnId: 'wrong-target' })
    const result = await f.send('steer', { intent: 'steer', expectedNativeTurnId: 'turn-A' })
    assert.equal(result.turn.delivery, 'unknown')
    assert.equal(result.turn.nativeTurnId, undefined)
    f.manager.finish('A'); await f.idle()
    assert.equal(f.store.turns.get('steer')?.delivery, 'unknown')
  })
})

describe('F1 A-R14: queue-head cancellation and worker wakeups', () => {
  it('reselects C when the selected queue head B is canceled before claim', async () => {
    const f = setup(); await f.active(); await f.send('B'); await f.send('C')
    const selected = gate(), resume = gate()
    const claim = f.repository.claim.bind(f.repository)
    f.repository.claim = async (id, requestId) => {
      if (requestId === 'B') { selected.resolve(); await resume.promise }
      return claim(id, requestId)
    }
    f.manager.finish('A'); await selected.promise
    await f.service.cancelQueued(f.principal, context.workspaceId, f.store.row.id, 'B', { requestId: 'cancel-B' })
    resume.resolve(); await f.idle()
    assert.deepEqual(f.manager.starts, ['A', 'C'])
    assert.equal(f.store.turns.get('B')?.delivery, 'canceled')
    assert.equal(f.store.turns.get('C')?.delivery, 'completed')
  })

  it('reselects after queue-head cancellation without any local wakeup', async () => {
    const f = setup(); await f.active(); await f.send('B'); await f.send('C')
    const selected = gate(), resume = gate()
    const claim = f.repository.claim.bind(f.repository)
    f.repository.claim = async (id, requestId) => {
      if (requestId === 'B') { selected.resolve(); await resume.promise }
      return claim(id, requestId)
    }
    f.manager.finish('A'); await selected.promise
    // Model a competing cancellation writer, which cannot call this process's pump.
    await f.repository.cancelQueued(f.store.row.id, 'B')
    resume.resolve(); await f.idle()
    assert.deepEqual(f.manager.starts, ['A', 'C'])
    assert.equal(f.store.turns.get('C')?.delivery, 'completed')
  })

  it('retains an admission wakeup between the empty-queue read and task teardown', async () => {
    const f = setup(), empty = gate(), resume = gate()
    const next = f.repository.nextQueued.bind(f.repository)
    let held = false
    f.repository.nextQueued = async (id) => {
      const selected = await next(id)
      if (!held && !selected) { held = true; empty.resolve(); await resume.promise }
      return selected
    }
    f.internals.pump(f.store.row.id); await empty.promise
    await f.send('C')
    assert.equal(f.store.turns.get('C')?.delivery, 'queued')
    resume.resolve(); await f.idle()
    assert.deepEqual(f.manager.starts, ['C'])
    assert.equal(f.store.turns.get('C')?.delivery, 'completed')
  })

  it('does not spin or start queued work when another active owner prevents the claim', async () => {
    const f = setup(); await f.active(); await f.send('B')
    const observer = fixture(f.store); fixtures.push(observer)
    observer.internals.pump(f.store.row.id)
    await eventually(() => !observer.internals.tasks.has(f.store.row.id))
    assert.deepEqual(observer.manager.starts, [])
    assert.equal(f.store.turns.get('B')?.delivery, 'queued')
    f.manager.finish('A'); await f.idle()
    assert.deepEqual(f.manager.starts, ['A', 'B'])
  })
})

it('queues an explicitly selected Plan task once after the active turn', async () => {
  const f = setup()
  await f.active()
  const sent = await f.send('plan-task', { intent: 'next_turn',
    content: '/plan Inspect the repository', sessionMode: 'plan' })
  assert.equal(sent.turn.intent, 'next_turn')
  assert.deepEqual(f.manager.steers, [])
  assert.equal((await f.send('plan-task', { intent: 'next_turn',
    content: '/plan Inspect the repository', sessionMode: 'plan' })).replayed, true)
  f.manager.finish('A')
  await f.idle()
  assert.deepEqual(f.manager.starts, ['A', 'plan-task'])
  assert.equal(f.manager.modes.at(-1), 'plan')
  assert.equal(f.manager.prompts.at(-1), 'Inspect the repository')
})
