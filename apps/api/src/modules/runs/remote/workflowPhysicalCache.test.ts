import { expect, it } from 'vitest'
import { DomainError } from '../../errors.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'

it('reuses physical history within the same caller lifetime', async () => {
  const f = await physicalFixture()
  const caller = new AbortController()
  try {
    for (let read = 0; read < 3; read++) {
      const prepared = await f.producer.prefetch(f.readout.receipt, f.placement, f.source, caller.signal)
      expect(f.producer.confirmedClosed(prepared, f.session)).toBe(false)
    }
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.request.mock.calls[0]?.[1]?.signal).toBe(caller.signal)
  } finally { await f.sqlConnection.close() }
})

it('refreshes physical history for restart cleanup after the observer aborts', async () => {
  const f = await physicalFixture()
  const observer = new AbortController()
  const cleanup = new AbortController()
  const restart = new DomainError('ENGINE_RESTART', 'The native lifetime is detaching for application restart.', 409)
  try {
    const previous = await f.producer.prefetch(f.readout.receipt, f.placement, f.source, observer.signal)
    observer.abort(restart)
    expect(() => f.producer.confirmedClosed(previous, f.session)).toThrow(restart)
    const prepared = await f.producer.prefetch(f.readout.receipt, f.placement, f.source, cleanup.signal)
    expect(f.producer.confirmedClosed(prepared, f.session)).toBe(false)
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.request.mock.calls[1]?.[1]?.signal).toBe(cleanup.signal)
  } finally { await f.sqlConnection.close() }
})

it('keeps a later caller independent of a still-live cached observer', async () => {
  const f = await physicalFixture()
  const observer = new AbortController()
  const cleanup = new AbortController()
  try {
    await f.producer.prefetch(f.readout.receipt, f.placement, f.source, observer.signal)
    const prepared = await f.producer.prefetch(f.readout.receipt, f.placement, f.source, cleanup.signal)
    observer.abort(new Error('Observation ended'))
    expect(f.producer.confirmedClosed(prepared, f.session)).toBe(false)
    expect(f.request).toHaveBeenCalledTimes(2)
    const stopped = new Error('Cleanup ended')
    cleanup.abort(stopped)
    expect(() => f.producer.confirmedClosed(prepared, f.session)).toThrow(stopped)
  } finally { await f.sqlConnection.close() }
})

it('rejects a canceled caller before reading cached physical history', async () => {
  const f = await physicalFixture()
  const caller = new AbortController()
  const stopped = new Error('Caller stopped')
  try {
    await f.producer.prefetch(f.readout.receipt, f.placement, f.source, caller.signal)
    caller.abort(stopped)
    await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source, caller.signal)).rejects.toBe(stopped)
    expect(f.request).toHaveBeenCalledOnce()
  } finally { await f.sqlConnection.close() }
})

it('rejects an invalid fresh observation after its cached observer aborts', async () => {
  const f = await physicalFixture()
  const observer = new AbortController()
  try {
    await f.producer.prefetch(f.readout.receipt, f.placement, f.source, observer.signal)
    observer.abort(new Error('Observation ended'))
    f.request.mockResolvedValueOnce({ payload: {
      ...f.readout, expiresAt: new Date(Date.now() - 1).toISOString(),
    } })
    await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source, new AbortController().signal))
      .rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE', details: { reason: 'connection_expired' } })
    expect(f.request).toHaveBeenCalledTimes(2)
  } finally { await f.sqlConnection.close() }
})
