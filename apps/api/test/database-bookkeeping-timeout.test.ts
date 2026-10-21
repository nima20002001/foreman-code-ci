import type pg from 'pg'
import type { NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import { afterEach, expect, it, vi } from 'vitest'
import { isDatabaseTimeout, retryDatabaseTimeout } from '../src/infrastructure/databaseTimeout.js'
import { DomainError } from '../src/modules/errors.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { LeaseGuard, SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { RunGraphError } from '../src/modules/run-graph/errors.js'
import { executeRepeatRuntime, type RepeatRuntimeLifecycle } from '../src/modules/runs/repeatRuntime.js'
import { renewOwnedLeases } from '../src/modules/leases/ownerLeases.js'
import { a1Scenario, graphHarness } from './helpers/eng04A1GraphHarness.js'
import { nativeLanes } from './helpers/nativeLanes.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const timeouts = [
  new Error('Query read timeout'),
  Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
  new RunGraphError('GRAPH_TRANSACTION_FAILED', { cause: new Error('Query read timeout') }),
  new Error('Connection terminated due to connection timeout'),
]

it.each(timeouts)('retries bookkeeping until the database answers: %s', async error => {
  vi.useFakeTimers()
  const write = vi.fn().mockRejectedValueOnce(error).mockRejectedValueOnce(error).mockResolvedValue('persisted')
  const pending = retryDatabaseTimeout(write)
  await vi.advanceTimersByTimeAsync(300)
  await expect(pending).resolves.toBe('persisted')
  expect(write).toHaveBeenCalledTimes(3)
})

it('does not retry authorization failures, native failures, or cyclic causes', async () => {
  for (const error of [new DomainError('ACCESS_DENIED', 'Denied', 403), new Error('Native transport failed')]) {
    const work = vi.fn().mockRejectedValue(error)
    await expect(retryDatabaseTimeout(work)).rejects.toBe(error)
    expect(work).toHaveBeenCalledTimes(1)
  }
  const cycle = new Error('Unknown error')
  cycle.cause = cycle
  expect(isDatabaseTimeout(cycle)).toBe(false)
  const denied = new DomainError('ACCESS_DENIED', 'Denied', 403)
  denied.cause = timeouts[0]
  expect(isDatabaseTimeout(denied)).toBe(false)
})

it('interrupts a bookkeeping retry on Stop without another write', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const reason = new DomainError('GRAPH_STOP_CONFLICT', 'Stopped', 409)
  const work = vi.fn().mockRejectedValue(timeouts[0])
  const pending = retryDatabaseTimeout(work, { signal: controller.signal }).catch(error => error)
  await vi.advanceTimersByTimeAsync(0)
  controller.abort(reason)
  expect(await pending).toMatchObject({ name: 'AbortError', cause: reason })
  expect(work).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(work).toHaveBeenCalledTimes(1)
})

it('keeps the credential heartbeat alive through a wrapped database timeout', async () => {
  vi.useFakeTimers()
  const check = vi.fn().mockRejectedValueOnce(timeouts[2]).mockResolvedValue(undefined)
  const onFailure = vi.fn()
  const stop = renewOwnedLeases({
    leases: [{ name: 'execution credential', renewWithinMs: 60_000, remainingMs: () => 600_000, renew: async () => {} }],
    check, signal: new AbortController().signal, onFailure,
  })
  try {
    await vi.advanceTimersByTimeAsync(1_000)
    expect(check).toHaveBeenCalledTimes(2)
    expect(onFailure).not.toHaveBeenCalled()
  } finally {
    await stop()
  }
})

it.each(['preflight', 'graph admission'] as const)(
  'retries %s database timeouts without requesting native cancellation', async phase => {
    const scenario = a1Scenario('sequential', `database-timeout-${phase.replace(' ', '-')}`)
    const h = graphHarness(scenario)
    const lifecycle: RepeatRuntimeLifecycle = {
      preflight: vi.fn(async () => {}), markRunning: async () => {},
      currentState: async () => ({ executionState: 'running', stopRequested: false }),
      persistWait: async () => false, cancelNativeAndRequestCleanup: vi.fn(async () => true),
      settleRun: vi.fn(async () => {}), requestCleanup: vi.fn(async () => {}),
      finishNative: async () => {}, finishCleanup: async () => {},
    }
    const admission = vi.fn(h.input.store.admit)
    const failure = phase === 'preflight' ? vi.mocked(lifecycle.preflight) : admission
    failure.mockRejectedValueOnce(timeouts[0]).mockRejectedValueOnce(timeouts[1]).mockRejectedValueOnce(timeouts[2])
    await executeRepeatRuntime({ ...h.input, store: { ...h.input.store, admit: admission },
      owner: { assertOwned() {} }, lifecycle })
    expect(failure.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(lifecycle.cancelNativeAndRequestCleanup).not.toHaveBeenCalled()
    expect(lifecycle.settleRun).not.toHaveBeenCalled()
    expect(lifecycle.requestCleanup).toHaveBeenCalledTimes(1) // Normal completed-run cleanup only.
  },
)

it('still settles an explicit Stop while preflight bookkeeping is unavailable', async () => {
  const h = graphHarness(a1Scenario('single', 'database-timeout-stop'))
  const stopped = new DomainError('GRAPH_STOP_CONFLICT', 'Stop requested', 409)
  const lifecycle: RepeatRuntimeLifecycle = {
    preflight: async () => {
      h.controller.abort(stopped)
      throw timeouts[0]
    },
    markRunning: async () => {},
    currentState: async () => ({ executionState: 'running', stopRequested: true }),
    persistWait: async () => false, cancelNativeAndRequestCleanup: vi.fn(async () => true),
    settleRun: vi.fn(async () => {}), requestCleanup: vi.fn(async () => {}),
    finishNative: async () => {}, finishCleanup: async () => {},
  }
  await expect(executeRepeatRuntime({ ...h.input, owner: { assertOwned() {} }, lifecycle })).rejects.toBe(stopped)
  expect(lifecycle.requestCleanup).toHaveBeenCalledTimes(1)
  expect(lifecycle.cancelNativeAndRequestCleanup).toHaveBeenCalledTimes(1)
  expect(lifecycle.settleRun).toHaveBeenCalledWith(true, false)
})

it.each(timeouts)('keeps a healthy lease through a foreground timeout: %s', async error => {
  vi.useFakeTimers()
  const check = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined)
  const guard = new LeaseGuard(9_000, check, async () => new Date(Date.now() + 9_000).toISOString())
  try {
    const pending = guard.check()
    await vi.advanceTimersByTimeAsync(100)
    await pending
    expect(check).toHaveBeenCalledTimes(2)
    expect(guard.signal.aborted).toBe(false)
  } finally {
    await guard.stop()
  }
})

it('still stops at lease expiry when all database checks time out', async () => {
  vi.useFakeTimers()
  const guard = new LeaseGuard(900, async () => { throw timeouts[0] }, async () => { throw timeouts[0] })
  try {
    const pending = guard.check().catch(error => error)
    await vi.advanceTimersByTimeAsync(900)
    expect(await pending).toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
    expect(guard.signal.aborted).toBe(true)
  } finally {
    await guard.stop()
  }
})

it('confirms the same writer before foreground work resumes after expiry', async () => {
  vi.useFakeTimers()
  let unavailable = true
  const check = vi.fn(async () => {
    if (unavailable) throw timeouts[0]
  })
  const recover = vi.fn(async () => {
    if (unavailable) throw timeouts[0]
    return new Date(Date.now() + 900).toISOString()
  })
  const guard = new LeaseGuard(900, check, recover, new AbortController().signal,
    new Date(Date.now() + 900).toISOString(), { recover })
  const confirmed = vi.fn()
  const pending = guard.check().then(confirmed)
  try {
    await vi.advanceTimersByTimeAsync(2_000)
    expect(guard.signal.aborted).toBe(false)
    expect(confirmed).not.toHaveBeenCalled()
    unavailable = false
    await vi.advanceTimersByTimeAsync(1_000)
    await pending
    expect(confirmed).toHaveBeenCalledOnce()
    expect(recover).toHaveBeenCalled()
  } finally {
    await guard.stop()
  }
})

it('honors Stop during expired native lease recovery without another renewal', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const reason = new DomainError('GRAPH_STOP_CONFLICT', 'Stopped', 409)
  const recover = vi.fn().mockRejectedValue(timeouts[0])
  const guard = new LeaseGuard(900, async () => { throw timeouts[0] }, recover, controller.signal,
    new Date(Date.now() + 900).toISOString(), { recover })
  const pending = guard.check().catch(error => error)
  try {
    await vi.advanceTimersByTimeAsync(2_000)
    expect(guard.signal.aborted).toBe(false)
    controller.abort(reason)
    expect(await pending).toBe(reason)
    const attempts = recover.mock.calls.length
    await vi.advanceTimersByTimeAsync(2_000)
    expect(recover).toHaveBeenCalledTimes(attempts)
  } finally {
    await guard.stop()
  }
})

it('ends native observation on a non-database renewal failure', async () => {
  vi.useFakeTimers()
  const failed = new Error('Native writer configuration failed')
  const recover = vi.fn().mockRejectedValue(failed)
  const guard = new LeaseGuard(900, async () => {}, recover, new AbortController().signal,
    new Date(Date.now() + 900).toISOString(), { recover })
  try {
    await vi.advanceTimersByTimeAsync(300)
    expect(guard.signal.reason).toBe(failed)
    expect(recover).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(900)
    expect(recover).toHaveBeenCalledOnce()
  } finally {
    await guard.stop()
  }
})

it('still rejects confirmed writer ownership loss immediately', async () => {
  const lost = new DomainError('SESSION_LANE_LEASE_LOST', 'Another owner claimed the lane', 409)
  const check = vi.fn().mockRejectedValue(lost)
  const guard = new LeaseGuard(9_000, check, async () => new Date(Date.now() + 9_000).toISOString())
  try {
    await expect(guard.check()).rejects.toMatchObject({ code: lost.code })
    expect(check).toHaveBeenCalledTimes(1)
    expect(guard.signal.aborted).toBe(true)
  } finally {
    await guard.stop()
  }
})

it.each(['acknowledgement', 'claim before write', 'claim after write', 'release before write', 'release after write'])(
  'continues the same native iterator through a %s timeout', async mode => {
    vi.useFakeTimers()
    const session: NativeSessionReference = { harness: 'codex', providerVersion: 'fixture', nativeSessionId: 'timeout-session' }
    const event: NativeHarnessEvent = { sequence: 0, type: 'native.notification', payload: {}, occurredAt: new Date().toISOString() }
    const startTurn = vi.fn(async function* (_session, input) {
      await input.onSubmitted?.('timeout-turn')
      yield event
    } as NativeHarnessSessionManager['startTurn'])
    const provider = {
      harness: 'codex', createSession: async () => session, startTurn,
      reconcile: async () => ({ events: [], pendingInteractions: [] }),
      cancel: vi.fn(), close: vi.fn(),
    } as unknown as NativeHarnessSessionManager
    const coordination = nativeLanes()
    const acknowledge = coordination.acknowledgeLaneTurn.bind(coordination)
    vi.spyOn(coordination, 'acknowledgeLaneTurn').mockImplementationOnce(async (...args) => {
      await acknowledge(...args)
      throw timeouts[0]
    })
    vi.spyOn(coordination, 'assertLaneLease').mockRejectedValueOnce(timeouts[1])
    if (mode.startsWith('claim')) {
      const claim = coordination.claimLane.bind(coordination)
      vi.spyOn(coordination, 'claimLane').mockImplementationOnce(async (...args) => {
        if (mode === 'claim after write') await claim(...args)
        throw timeouts[0]
      })
    }
    if (mode.startsWith('release')) {
      const release = coordination.releaseLane.bind(coordination)
      vi.spyOn(coordination, 'releaseLane').mockImplementationOnce(async (...args) => {
        if (mode === 'release after write') await release(...args)
        throw timeouts[0]
      })
    }
    const writer = new SingleWriterSessionManager(provider, coordination, 'timeout-agent', 9_000)
    await writer.createSession({ kind: 'operator' } as Parameters<typeof writer.createSession>[0])
    const iterator = writer.startTurn(session, { prompt: 'Continue', clientCorrelationId: 'timeout-correlation' })[Symbol.asyncIterator]()
    try {
      const pending = iterator.next()
      await vi.advanceTimersByTimeAsync(500)
      await expect(pending).resolves.toEqual({ value: event, done: false })
      const completed = iterator.next()
      await vi.advanceTimersByTimeAsync(500)
      await expect(completed).resolves.toEqual({ value: undefined, done: true })
      expect(startTurn).toHaveBeenCalledTimes(1)
      expect(provider.cancel).not.toHaveBeenCalled()
      expect(provider.close).not.toHaveBeenCalled()
    } finally {
      await iterator.return?.()
    }
  },
)

it('restores the owner connection after a timeout without replaying an uncertain COMMIT', async () => {
  vi.useFakeTimers()
  const empty = { rows: [], rowCount: 0 }
  const query = vi.fn().mockResolvedValue(empty)
    .mockResolvedValueOnce(empty)
    .mockRejectedValueOnce(timeouts[0])
    .mockRejectedValueOnce(timeouts[1])
  const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => {})
  const mutation = vi.fn(async () => 'candidate')
  try {
    const failed = connection.transaction(mutation).catch(error => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await failed).toBe(timeouts[0])
    expect(mutation).toHaveBeenCalledTimes(1)
    const readback = { rows: [{ accepted: true }], rowCount: 1 }
    query.mockResolvedValueOnce(readback)
    await expect(connection.query('select true as accepted')).resolves.toEqual(readback)
    await expect(connection.transaction(async () => 'reconciled')).resolves.toBe('reconciled')
    expect(mutation).toHaveBeenCalledTimes(1)
  } finally {
    await connection.close()
  }
})
