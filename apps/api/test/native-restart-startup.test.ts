import assert from 'node:assert/strict'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { afterEach, expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { NativeDeliveryError } from '../src/modules/harnesses/errors.js'
import { currentRestartUnit } from './helpers/currentRestartUnit.js'
import { deferred } from './helpers/deferred.js'

const connections: Array<{ close(): Promise<void> }> = []

function fixture(reviewer = true) {
  const f = currentRestartUnit(reviewer)
  connections.push(f.connection)
  return f
}

function startupFailure(startup: Promise<unknown>) {
  return startup.then(
    () => { throw new Error('Startup unexpectedly succeeded during restart') },
    (error: unknown) => error,
  )
}

async function startupStep(step: Promise<void>, failed: Promise<unknown>) {
  await Promise.race([step, failed.then(error => { throw error })])
}

function assertPreserved(f: ReturnType<typeof fixture>, before: ReturnType<typeof f.execution>) {
  assert.deepEqual(f.execution(), before)
  assert.equal(f.state.stopped, false)
  assert.equal(f.state.cleanup, false)
  assert.equal(f.state.revocations, 0)
  assert.equal(f.state.budgetStops, 0)
  assert.equal(f.state.cancels, 0)
  assert.equal(f.state.turns, 0)
  assert.equal(f.rows().at(-1)!.closed, false)
  assert.equal(f.rows().at(-1)!.detached, false)
}

it.each([
  { kind: 'graph work', tick: undefined },
  { kind: 'interval check', tick: { index: 1, everySeconds: 10 } },
])('adopts detached Main $kind before verifying its writable source under a fresh writer lease', async ({ tick }) => {
  const placement = { hostRef: { kind: 'main' } } as AcceptedNodePlacement
  const f = currentRestartUnit(false, placement, tick ? { tick } : {})
  connections.push(f.connection)
  const first = f.cold()
  await first.attachOriginal()
  await first.coordinator.closeForRestart()
  expect(f.rows().at(-1)?.detached).toBe(true)
  const execution = structuredClone(f.execution())
  const restarted = f.cold()
  restarted.manager.originalEnvironment = async () => ({ ORIGINAL_PROCESS_TOKEN: 'retained-fixture-token' })
  const verify = vi.fn(async () => {
    const captures = restarted.coordinator.passiveOwnedNativeSessions()
    expect(captures).toHaveLength(1)
    expect(captures[0]).toMatchObject({ execution, session: f.session })
    captures[0]!.assertCurrent()
    expect(f.state.attaches).toBe(2)
    return 'verified source'
  })
  expect(await restarted.coordinator.withSourceObservationLane(f.owner, execution, verify)).toBe('verified source')
  expect(verify).toHaveBeenCalledOnce()
  expect(restarted.coordinator.passiveOwnedNativeSessions()).toEqual([])
  expect(f.execution()).toEqual(execution)
  expect(f.state.creates).toBe(0)
  expect(f.state.turns).toBe(0)
  expect(f.state.restores).toBe(1)
  await restarted.coordinator.closeForRestart()
})

it('does not invent a source owner from a saved session without confirmed restart detachment', async () => {
  const f = currentRestartUnit(false, { hostRef: { kind: 'main' } } as AcceptedNodePlacement)
  connections.push(f.connection)
  const restarted = f.cold()
  await restarted.coordinator.withSourceObservationLane(f.owner, f.execution(), async () => {
    expect(restarted.coordinator.passiveOwnedNativeSessions()).toEqual([])
  })
  expect(f.state.attaches).toBe(0)
  expect(f.state.creates).toBe(0)
  expect(f.state.turns).toBe(0)
})

it.each(['running', 'waiting'] as const)(
  'repairs a missing Main detachment write from its guardian marker before observing a %s source', async state => {
    const f = currentRestartUnit(false, { hostRef: { kind: 'main' } } as AcceptedNodePlacement)
    connections.push(f.connection)
    const first = f.cold()
    await first.attachOriginal()
    f.state.failCloseWrite = true
    await expect(first.coordinator.closeForRestart()).rejects.toBeInstanceOf(AggregateError)
    expect(f.state.restartDetached).toBe(true)
    expect(f.rows().at(-1)?.detached).toBe(false)
    f.state.failCloseWrite = false
    f.execution().state = state
    const execution = structuredClone(f.execution())
    const originalGeneration = f.rows().at(-1)!.generation
    const restarted = f.cold()
    restarted.manager.originalEnvironment = async () => ({ ORIGINAL_PROCESS_TOKEN: 'retained-fixture-token' })
    const observe = vi.fn(async () => {
      expect(restarted.coordinator.passiveOwnedNativeSessions()).toHaveLength(1)
      expect(f.rows().find(row => row.generation === originalGeneration)).toMatchObject({
        detached: true, detached_reference: f.session, closed: false,
      })
      return 'observed original source'
    })
    expect(await restarted.coordinator.withSourceObservationLane(f.owner, execution, observe))
      .toBe('observed original source')
    expect(observe).toHaveBeenCalledOnce()
    expect(f.execution()).toEqual(execution)
    expect(f.state.attaches).toBe(2)
    expect(f.state.restores).toBe(1)
    expect(f.state.creates).toBe(0)
    expect(f.state.turns).toBe(0)
    expect(f.state.cleanup).toBe(false)
    await restarted.coordinator.closeForRestart()
  },
)

it('preserves an original Main turn while cold attachment opens without detaching its new generation early', async () => {
  const f = currentRestartUnit(false, { hostRef: { kind: 'main' } } as AcceptedNodePlacement)
  connections.push(f.connection)
  const first = f.cold()
  await first.attachOriginal()
  await first.coordinator.closeForRestart()
  const restarted = f.cold()
  restarted.manager.originalEnvironment = async () => ({ ORIGINAL_PROCESS_TOKEN: 'retained-fixture-token' })
  const attaching = deferred()
  const attached = deferred()
  const attach = restarted.manager.attachSession.bind(restarted.manager)
  restarted.manager.attachSession = async (...args) => {
    attaching.resolve()
    await attached.promise
    return attach(...args)
  }
  const observing = restarted.coordinator.withSourceObservationLane(f.owner, f.execution(), async () => 'original source')
  try {
    await attaching.promise
    expect(f.rows()).toHaveLength(2)
    expect(f.rows()[1]).toMatchObject({ detached: false, closed: false })
    const waits = f.state.budgetWaits
    expect(await restarted.coordinator.preserveActiveForRestart(f.owner)).toBe(true)
    expect(f.state.budgetWaits).toBe(waits + 1)
    expect(f.rows()[1]).toMatchObject({ detached: false, closed: false })
    expect(f.state.cleanup).toBe(false)
    expect(f.state.creates).toBe(0)
    expect(f.state.turns).toBe(0)
    attached.resolve()
    expect(await observing).toBe('original source')
    await restarted.coordinator.closeForRestart()
    expect(f.rows()[1]).toMatchObject({ detached: true, closed: false })
  } finally {
    attached.resolve()
    await observing
  }
})

it('does not preserve a cold attachment after its authorization has failed', async () => {
  const f = currentRestartUnit(false, { hostRef: { kind: 'main' } } as AcceptedNodePlacement)
  connections.push(f.connection)
  const first = f.cold()
  await first.attachOriginal()
  await first.coordinator.closeForRestart()
  const restarted = f.cold()
  restarted.manager.originalEnvironment = async () => ({ ORIGINAL_PROCESS_TOKEN: 'retained-fixture-token' })
  restarted.manager.attachSession = async () => {
    throw new DomainError('WORKER_AUTH_REVOKED', 'Original process authorization was revoked.', 403)
  }
  await expect(restarted.coordinator.withSourceObservationLane(f.owner, f.execution(), async () => 'source'))
    .rejects.toMatchObject({ code: 'WORKER_AUTH_REVOKED' })
  expect(await restarted.coordinator.preserveActiveForRestart(f.owner)).toBe(false)
  expect(f.rows()[1]).toMatchObject({ detached: false, closed: false })
  expect(f.state.creates).toBe(0)
  expect(f.state.turns).toBe(0)
})

it.each([
  { state: 'running' as const, missingWrite: false },
  { state: 'running' as const, missingWrite: true },
  { state: 'waiting' as const, missingWrite: false },
  { state: 'waiting' as const, missingWrite: true },
])('preserves a cold $state Main session during another restart (missing detachment write=$missingWrite)',
  async ({ state, missingWrite }) => {
    const f = currentRestartUnit(false, { hostRef: { kind: 'main' } } as AcceptedNodePlacement)
    connections.push(f.connection)
    const first = f.cold()
    await first.attachOriginal()
    f.state.failCloseWrite = missingWrite
    if (missingWrite) await expect(first.coordinator.closeForRestart()).rejects.toBeInstanceOf(AggregateError)
    else await first.coordinator.closeForRestart()
    f.state.failCloseWrite = false
    f.execution().state = state
    const execution = structuredClone(f.execution())
    const before = { resolutions: f.state.resolutions, attaches: f.state.attaches,
      registrations: f.state.beginCalls, waits: f.state.budgetWaits }
    const restarted = f.cold()
    expect(await restarted.coordinator.preserveActiveForRestart(f.owner)).toBe(true)
    expect(f.state.budgetWaits).toBe(before.waits + 1)
    expect(f.rows()).toHaveLength(1)
    expect(f.rows()[0]).toMatchObject({ detached: true, closed: false, detached_reference: f.session })
    expect(f.state.resolutions).toBe(before.resolutions)
    expect(f.state.attaches).toBe(before.attaches)
    expect(f.state.beginCalls).toBe(before.registrations)
    expect(f.execution()).toEqual(execution)
    expect(f.state.cleanup).toBe(false)
    expect(f.state.creates).toBe(0)
    expect(f.state.turns).toBe(0)
    expect(restarted.coordinator.passiveOwnedNativeSessions()).toEqual([])
    await restarted.coordinator.closeForRestart()
  },
)

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()))
  vi.useRealTimers()
})

async function orphanedWriterFixture() {
  const f = currentRestartUnit(false, { hostRef: { kind: 'main' } } as AcceptedNodePlacement)
  connections.push(f.connection)
  f.state.restartDetached = true
  const restarted = f.cold()
  await restarted.store.begin(f.execution())
  const lane = await f.coordination.ensureLane({
    id: 'original-writer-lane', harness: f.session.harness, nativeSessionId: f.session.nativeSessionId,
    ownerAgentId: f.execution().agentId, observedStatus: 'busy', connectionGeneration: 2,
    correlationId: `execution:${f.execution().id}`, currentTurnOrMessageId: 'original-turn',
    leaseOwner: f.execution().agentId, leaseToken: 'orphaned-writer-token',
    leaseExpiresAt: new Date(Date.now() + 500).toISOString(), observedAt: f.f.createdAt, revision: 1,
  })
  restarted.manager.originalEnvironment = async () => ({ ORIGINAL_PROCESS_TOKEN: 'retained-fixture-token' })
  return { ...f, restarted, lane }
}

it('waits for the orphaned source writer lease to expire before attaching the original Main session', async () => {
  vi.useFakeTimers()
  const f = await orphanedWriterFixture()
  let settled = false
  const result = f.restarted.coordinator.withSourceObservationLane(f.owner, f.execution(), async () => {
    const captured = f.restarted.coordinator.passiveOwnedNativeSessions()[0]!
    expect(captured.writer.token).not.toBe(f.lane.leaseToken)
    await expect(f.coordination.assertLaneLease(f.lane.id, f.lane.leaseToken!))
      .rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
    return 'original source'
  })
    .then(value => ({ value }), error => ({ error }))
    .finally(() => { settled = true })
  await vi.advanceTimersByTimeAsync(499)
  expect(settled).toBe(false)
  // Only the read-only liveness probe of the original process resolved a manager; no attachment yet.
  expect(f.state.resolutions).toBe(1)
  expect(f.state.attaches).toBe(0)
  await vi.advanceTimersByTimeAsync(1)
  expect(await result).toEqual({ value: 'original source' })
  const lane = await f.coordination.getLane(f.session.harness, f.session.nativeSessionId)
  expect(lane?.leaseToken).toBeUndefined()
  expect(lane?.connectionGeneration).toBe(f.lane.connectionGeneration)
  expect(lane?.correlationId).toBe(f.lane.correlationId)
  expect(lane?.currentTurnOrMessageId).toBe(f.lane.currentTurnOrMessageId)
  expect(f.state.attaches).toBe(1)
  expect(f.state.restores).toBe(1)
  expect(f.state.creates).toBe(0)
  expect(f.state.turns).toBe(0)
  await f.restarted.coordinator.closeForRestart()
})

it.each(['writer', 'owner'] as const)('refuses cold source attachment when the %s changes while waiting', async changed => {
  vi.useFakeTimers()
  const f = await orphanedWriterFixture()
  const observing = f.restarted.coordinator.withSourceObservationLane(f.owner, f.execution(), async () => 'source')
  const rejected = changed === 'writer'
    ? expect(observing).rejects.toMatchObject({ code: 'SESSION_LANE_BUSY' })
    : expect(observing).rejects.toThrow('RUN_OWNERSHIP_LOST')
  await vi.advanceTimersByTimeAsync(0)
  expect(f.state.resolutions).toBe(1)
  if (changed === 'writer') {
    await f.coordination.renewLane(f.lane.id, f.lane.leaseToken!, 1_000)
  } else {
    f.state.owned = false
  }
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  expect(f.state.attaches).toBe(0)
  expect(f.state.beginCalls).toBe(1)
  expect(f.state.creates).toBe(0)
  expect(f.state.turns).toBe(0)
})

for (const { reviewer, wrapped } of [
  { reviewer: false, wrapped: false },
  { reviewer: true, wrapped: false },
  { reviewer: true, wrapped: true },
]) {
  const kind = reviewer ? 'reviewer attachment' : 'workflow observation'
  it(`drains canceled ${kind} before restart succeeds${wrapped ? ' through native delivery errors' : ''}`, async () => {
    const f = fixture(reviewer)
    const first = f.cold()
    const before = structuredClone(f.execution())
    const attaching = deferred()
    const disposing = deferred()
    const disposed = deferred()
    let disposals = 0
    first.manager.attachSession = async (_reference, _input, signal) => {
      attaching.resolve()
      return new Promise<NativeSessionReference>((_resolve, reject) => {
        signal!.addEventListener('abort', () => {
          const error = wrapped
            ? new NativeDeliveryError('session_creation', 'not_sent', signal!.reason)
            : signal!.reason
          reject(error)
        }, { once: true })
      })
    }
    first.manager.dispose = async () => {
      disposals++
      disposing.resolve()
      await disposed.promise
    }
    const failed = startupFailure(first.attachOriginal())
    await startupStep(attaching.promise, failed)
    let settled = false
    const closing = first.coordinator.closeForRestart().finally(() => { settled = true })
    try {
      await Promise.race([disposing.promise, closing])
      assert.equal(settled, false)
      assertPreserved(f, before)
      disposed.resolve()
      await closing
      assert.equal(disposals, 1)
      assert.equal(f.state.restartCloses, 0)
      assertPreserved(f, before)
      const error = await failed
      assert.ok(error instanceof Error)
      assert.match(error.message, /application restart/)
    } finally {
      disposed.resolve()
      await Promise.allSettled([closing, failed])
    }
  })
}

it('waits for canceled credential preflight and disposes without attaching a saved session', async () => {
  const f = fixture()
  const first = f.cold()
  const before = structuredClone(f.execution())
  const preparing = deferred()
  const prepared = deferred()
  let disposals = 0
  f.beforePreflight(async () => {
    preparing.resolve()
    await prepared.promise
  })
  first.manager.dispose = async () => { disposals++ }
  const failed = startupFailure(first.attachOriginal())
  await startupStep(preparing.promise, failed)
  let settled = false
  const closing = first.coordinator.closeForRestart().finally(() => { settled = true })
  try {
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(settled, false)
    assert.equal(disposals, 0)
    prepared.resolve()
    await closing
    await failed
    assert.equal(disposals, 1)
    assert.equal(f.state.attaches, 0)
    assert.equal(f.state.restartCloses, 0)
    assertPreserved(f, before)
  } finally {
    prepared.resolve()
    await Promise.allSettled([closing, failed])
  }
})

for (const drainBeforeClosure of [false, true]) {
  it(`preserves caller restart cancellation ${drainBeforeClosure ? 'before closure' : 'while closure drains startup'}`, async () => {
    const f = fixture()
    const first = f.cold()
    const before = structuredClone(f.execution())
    const caller = new AbortController()
    const attaching = deferred()
    const aborted = deferred()
    const canceled = deferred()
    let disposals = 0
    first.manager.attachSession = async (_reference, _input, signal) => {
      attaching.resolve()
      await new Promise<void>((resolve) => {
        signal!.addEventListener('abort', () => {
          aborted.resolve()
          resolve()
        }, { once: true })
      })
      await canceled.promise
      throw signal!.reason
    }
    first.manager.dispose = async () => { disposals++ }
    const failed = startupFailure(first.attachOriginal(caller.signal))
    await startupStep(attaching.promise, failed)
    caller.abort(new DomainError('ENGINE_RESTART', 'The caller is shutting down for restart.', 409))
    await aborted.promise
    let closing: Promise<void> | undefined
    try {
      if (drainBeforeClosure) {
        canceled.resolve()
        await failed
        assertPreserved(f, before)
      }
      closing = first.coordinator.closeForRestart()
      canceled.resolve()
      await closing
      const error = await failed
      assert.ok(error instanceof Error)
      assert.match(error.message, /caller is shutting down/)
      assert.equal(disposals, 1)
      assert.equal(f.state.restartCloses, 0)
      assertPreserved(f, before)
    } finally {
      canceled.resolve()
      await Promise.allSettled([closing, failed])
    }
  })
}

it('records detachment only after an attachment that completes late is positively closed', async () => {
  const f = fixture()
  const first = f.cold()
  const before = structuredClone(f.execution())
  const attaching = deferred()
  const attached = deferred()
  const closingNative = deferred()
  const closedNative = deferred()
  first.manager.attachSession = async (reference) => {
    attaching.resolve()
    await attached.promise
    return reference
  }
  f.beforeClose(async () => {
    closingNative.resolve()
    await closedNative.promise
  })
  const failed = startupFailure(first.attachOriginal())
  await startupStep(attaching.promise, failed)
  const closing = first.coordinator.closeForRestart()
  try {
    assertPreserved(f, before)
    attached.resolve()
    await Promise.race([closingNative.promise, closing])
    assertPreserved(f, before)
    closedNative.resolve()
    await closing
    await failed
    assert.equal(f.rows().at(-1)!.detached, true)
    assert.equal(f.rows().at(-1)!.closed, false)
    assert.equal(f.state.restartCloses, 1)
    assert.equal(f.state.revocations, 0)
    assert.equal(f.state.cancels, 0)
    assert.deepEqual(f.execution(), before)
  } finally {
    attached.resolve()
    closedNative.resolve()
    await Promise.allSettled([closing, failed])
  }
})

it('retries disposal of the same aborted attachment without inventing closure records', async () => {
  const f = fixture()
  const first = f.cold()
  const before = structuredClone(f.execution())
  const attaching = deferred()
  first.manager.attachSession = async (_reference, _input, signal) => {
    attaching.resolve()
    return new Promise<NativeSessionReference>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    })
  }
  let disposals = 0
  first.manager.dispose = async () => {
    disposals++
    if (disposals === 1) throw new Error('Original transport disposal is uncertain')
  }
  const failed = startupFailure(first.attachOriginal())
  await startupStep(attaching.promise, failed)
  await assert.rejects(first.coordinator.closeForRestart(), AggregateError)
  await failed
  assertPreserved(f, before)
  assert.equal(f.state.restartCloses, 0)
  await first.coordinator.closeForRestart()
  assert.equal(disposals, 2)
  assertPreserved(f, before)
})

it('does not reinterpret uncertain native cleanup as expected restart cancellation', async () => {
  const f = fixture()
  const first = f.cold()
  const attaching = deferred()
  first.manager.attachSession = async (_reference, _input, signal) => {
    attaching.resolve()
    return new Promise<NativeSessionReference>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new NativeDeliveryError(
        'session_creation', 'unknown', signal!.reason, 'pending',
      )), { once: true })
    })
  }
  const failed = startupFailure(first.attachOriginal())
  await startupStep(attaching.promise, failed)
  await assert.rejects(first.coordinator.closeForRestart(), AggregateError)
  await failed
  assert.equal(f.rows().at(-1)!.closed, false)
  assert.equal(f.rows().at(-1)!.detached, false)
  assert.equal(f.state.restartCloses, 0)
})

it('hands over an interrupted ordinary remote workflow attachment before disposing its manager', async () => {
  const placement = { hostRef: { kind: 'device' } } as AcceptedNodePlacement
  const f = currentRestartUnit(false, placement)
  connections.push(f.connection)
  const first = f.cold()
  const before = structuredClone(f.execution())
  const attaching = deferred()
  let attempts = 0
  let detached = false
  first.manager.attachSession = async (reference, input, signal) => {
    attempts++
    assert.deepEqual(reference, f.session)
    assert.equal(input.correlationId, `execution:${before.id}`)
    if (attempts > 1) {
      assert.equal(signal?.aborted, false)
      return reference
    }
    attaching.resolve()
    return new Promise<NativeSessionReference>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })
    })
  }
  const closeForRestart = first.manager.closeForRestart!.bind(first.manager)
  first.manager.closeForRestart = async reference => {
    await closeForRestart(reference)
    detached = true
  }
  first.manager.dispose = async () => {
    assert.equal(detached, true, 'live remote work requires confirmed restart detachment')
  }
  const failed = startupFailure(first.attachOriginal())
  await attaching.promise
  await first.coordinator.closeForRestart()
  const error = await failed
  assert.ok(error instanceof DomainError)
  assert.equal(error.code, 'ENGINE_RESTART')
  assert.equal(attempts, 2)
  assert.equal(f.state.preflightCalls, 0)
  assert.equal(f.state.restores, 0)
  await first.manager.dispose!()
  assert.deepEqual(f.execution(), before)
  assert.equal(f.rows().at(-1)!.detached, true)
  assert.equal(f.rows().at(-1)!.closed, false)
  assert.equal(f.state.creates, 0)
  assert.equal(f.state.turns, 0)
  assert.equal(f.state.cancels, 0)
  assert.equal(f.state.revocations, 0)
  assert.equal(f.state.budgetStops, 0)
})
