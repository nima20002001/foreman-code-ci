import type { NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import type { DeviceHistoryGap } from '@foreman-code/contracts/device-application'
import { afterEach, expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { nativeLanes } from './helpers/nativeLanes.js'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function fixture(failure: Error) {
  const session: NativeSessionReference = {
    harness: 'codex', providerVersion: 'fixture', nativeSessionId: 'history-session',
  }
  const gap: DeviceHistoryGap = { fromSequence: 10, toSequence: 29, reason: 'retention' }
  const event: NativeHarnessEvent = {
    sequence: 30, type: 'native.notification', payload: {}, occurredAt: new Date().toISOString(),
  }
  const startTurn = vi.fn<NativeHarnessSessionManager['startTurn']>(async function* (_session, input) {
    await input.onSubmitted?.('history-turn')
    await input.onEventsSkipped?.(gap)
    yield event
  })
  const provider = {
    harness: 'codex', createSession: async () => session, startTurn,
    reconcile: async () => ({ events: [], pendingInteractions: [] }),
    cancel: vi.fn(), close: vi.fn(),
  } as unknown as NativeHarnessSessionManager
  const coordination = nativeLanes()
  const record = vi.fn<typeof coordination.recordSkippedEvents>()
    .mockRejectedValueOnce(failure).mockResolvedValue(undefined)
  coordination.recordSkippedEvents = record
  const writer = new SingleWriterSessionManager(provider, coordination, 'history-agent', 9_000)
  const skipped = vi.fn<(gap: DeviceHistoryGap) => Promise<void>>(async () => {})
  const collect = async () => {
    await writer.createSession({ kind: 'operator' } as Parameters<typeof writer.createSession>[0])
    const events: NativeHarnessEvent[] = []
    for await (const value of writer.startTurn(session, {
      prompt: 'Continue', clientCorrelationId: 'history-correlation', onEventsSkipped: skipped,
    })) events.push(value)
    return events
  }
  return { collect, startTurn, provider, record, skipped, gap, event }
}

it.each(['40P01', '40001'])('retries skipped-range bookkeeping after PostgreSQL conflict %s', async code => {
  vi.useFakeTimers()
  const failure = Object.assign(new Error('Database transaction conflict'), { code })
  const f = fixture(failure)
  const outcome = f.collect().catch(error => error)
  await vi.advanceTimersByTimeAsync(500)
  expect(await outcome).toEqual([f.event])
  expect(f.record).toHaveBeenCalledTimes(2)
  expect(f.skipped).toHaveBeenCalledExactlyOnceWith(f.gap)
  expect(f.startTurn).toHaveBeenCalledOnce()
  expect(f.provider.cancel).not.toHaveBeenCalled()
  expect(f.provider.close).not.toHaveBeenCalled()
})

it('rejects skipped-range ownership loss without retrying or notifying the consumer', async () => {
  const failure = new DomainError('SESSION_LANE_LEASE_LOST', 'Another writer owns the session.', 409)
  const f = fixture(failure)
  await expect(f.collect()).rejects.toBe(failure)
  expect(f.record).toHaveBeenCalledOnce()
  expect(f.skipped).not.toHaveBeenCalled()
  expect(f.startTurn).toHaveBeenCalledOnce()
})
