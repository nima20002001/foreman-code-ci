import assert from 'node:assert/strict'

import { describe, it } from 'vitest'

import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { reviewCoordination, reviewSession } from './pr17-agent2-fixtures.js'
import { nativeLanes } from './helpers/nativeLanes.js'

describe('PR17 #6: targeted writer cancellation', () => {
  it('forwards current/stale targets exactly and preserves omitted-target behavior', async () => {
    const targets: (string | undefined)[] = []
    const manager = { harness: 'codex', cancel: async (session, signal, target) => {
      assert.deepEqual(session, reviewSession)
      assert.ok(signal instanceof AbortSignal)
      targets.push(target)
      return target === undefined || target === 'current-turn'
    } } as NativeHarnessSessionManager
    const writer = new SingleWriterSessionManager(manager, reviewCoordination().repository, 'reviewer')
    assert.equal(await writer.cancel(reviewSession, undefined, 'stale-turn'), false)
    assert.equal(await writer.cancel(reviewSession, undefined, 'current-turn'), true)
    assert.equal(await writer.cancel(reviewSession), true)
    assert.deepEqual(targets, ['stale-turn', 'current-turn', undefined])
  })

  it('retains each queued target through control serialization on an active lane', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const firstEntered = new Promise<void>((resolve) => { entered = resolve })
    const targets: (string | undefined)[] = []
    const manager = { harness: 'codex', cancel: async (_session, _signal, target) => {
      targets.push(target)
      if (targets.length === 1) { entered(); await blocked }
      return target === 'current-turn'
    } } as NativeHarnessSessionManager
    const writer = new SingleWriterSessionManager(manager, reviewCoordination().repository, 'reviewer')
    await writer.withLane(reviewSession, 'review-correlation', undefined, async () => {
      const first = writer.cancel(reviewSession, undefined, 'current-turn')
      await firstEntered
      const stale = writer.cancel(reviewSession, undefined, 'stale-turn')
      assert.deepEqual(targets, ['current-turn'])
      release()
      assert.deepEqual(await Promise.all([first, stale]), [true, false])
    })
    assert.deepEqual(targets, ['current-turn', 'stale-turn'])
  })
})

it.each(['turn', 'initial'] as const)('keeps the %s writer lease until the last partial batch is consumed', async (mode) => {
  const frames = Array.from({ length: 3 }, (_, sequence) => ({
    sequence, type: 'native.notification', occurredAt: new Date().toISOString(), payload: { text: `frame-${sequence}` },
  }))
  const coordination = nativeLanes()
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected provider operation')
  }
  const manager: NativeHarnessSessionManager = {
    harness: 'codex',
    capabilities: unexpectedOperation,
    inspectMcp: unexpectedOperation,
    createSession: async () => reviewSession,
    attachSession: unexpectedOperation,
    async *startTurn() { yield* frames },
    async *startInitialTurn(_start, input) {
      await input.onSessionObserved(reviewSession)
      yield* frames
    },
    pending: unexpectedOperation,
    respond: unexpectedOperation,
    cancel: unexpectedOperation,
    history: unexpectedOperation,
    reconcile: async () => ({ events: [], pendingInteractions: [] }),
    close: unexpectedOperation,
  }
  const writer = new SingleWriterSessionManager(manager, coordination, 'reviewer')
  if (mode === 'turn') await writer.createSession({ kind: 'operator' } as Parameters<typeof writer.createSession>[0])
  const batches = mode === 'turn'
    ? writer.startTurnBatches(reviewSession, { prompt: 'stream', clientCorrelationId: 'stream-turn' })
    : writer.startInitialTurnBatches!({ kind: 'operator' } as Parameters<typeof writer.createSession>[0], {
      prompt: 'stream', clientCorrelationId: 'stream-turn', onSessionObserved: async () => undefined,
    })
  const iterator = batches[Symbol.asyncIterator]()
  assert.deepEqual(await iterator.next(), { value: frames, done: false })
  const lease = writer.capturedLease(reviewSession)
  assert.ok(lease)
  assert.equal((await coordination.getLane('codex', reviewSession.nativeSessionId))?.leaseToken, lease.fence.token)
  assert.equal((await iterator.next()).done, true)
  assert.equal(writer.isActive(reviewSession), false)
  assert.equal((await coordination.getLane('codex', reviewSession.nativeSessionId))?.leaseToken, undefined)
})
