import { expect, it, vi } from 'vitest'
import { DeviceApplicationError } from '../../devices/deviceApplicationError.js'
import { physicalFixture } from './__tests__/installedWorkflowHost.js'

it.each(['backpressure', 'timeout'])('retries transient %s while reading the original native process', async code => {
  const f = await physicalFixture()
  f.request.mockRejectedValueOnce(new DeviceApplicationError(code))
  vi.useFakeTimers()
  try {
    const result = f.producer.prefetch(f.readout.receipt, f.placement, f.source)
    const checked = expect(result).resolves.toMatchObject({ kind: 'original-remote-physical' })
    await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(5_000)])
    await checked
    expect(f.request).toHaveBeenCalledTimes(2)
    expect(f.request.mock.calls[1]).toEqual(f.request.mock.calls[0])
    const call = f.request.mock.calls[0] as unknown as [unknown, { timeoutMs?: number }]
    expect(call[1]?.timeoutMs).toBeGreaterThanOrEqual(120_000)
  } finally {
    vi.useRealTimers()
    await f.sqlConnection.close()
  }
})

it('validates the returned observation expiry after a slow request rather than expiring before it arrives', async () => {
  const f = await physicalFixture()
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  f.request.mockImplementation(async () => {
    now += 65_000
    f.readout.expiresAt = new Date(now + 60_000).toISOString()
    return { payload: f.readout }
  })
  try {
    await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source))
      .resolves.toMatchObject({ kind: 'original-remote-physical' })
    expect(f.request).toHaveBeenCalledOnce()
  } finally { await f.sqlConnection.close() }
})

it('still rejects an expired physical observation without retrying its validation failure', async () => {
  const f = await physicalFixture()
  f.readout.expiresAt = new Date(Date.now() - 1).toISOString()
  try {
    await expect(f.producer.prefetch(f.readout.receipt, f.placement, f.source))
      .rejects.toMatchObject({ code: 'REMOTE_NATIVE_PHYSICAL_UNAVAILABLE' })
    expect(f.request).toHaveBeenCalledOnce()
  } finally { await f.sqlConnection.close() }
})
