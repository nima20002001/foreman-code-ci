import { afterEach, expect, it, vi } from 'vitest'
import { dispatchFleet, readyStatus } from './dispatchFleet.testSupport.js'
import { DeviceApplicationAdmissionError } from '../devices/deviceApplicationError.js'

const computer = { key: 'builder', label: 'Builder', priority: 0,
  hostRef: { kind: 'main' as const, mainId: 'fixture-main' } }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('backs off unavailable computer status reads instead of probing on every dispatch wakeup', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const status = vi.fn().mockRejectedValue(new DeviceApplicationAdmissionError('background_yield'))
  const f = dispatchFleet([computer], [], { status })
  const dispatch = async () => { await f.service.dispatch(); await f.service.drain() }
  try {
    await dispatch()
    expect(status).toHaveBeenCalledTimes(1)
    for (let attempt = 1; attempt <= 7; attempt++) {
      vi.setSystemTime(Date.now() + Math.min(300_000, 5000 * 2 ** (attempt - 1)) - 1)
      await dispatch()
      expect(status).toHaveBeenCalledTimes(attempt)
      vi.setSystemTime(Date.now() + 1)
      await dispatch()
      expect(status).toHaveBeenCalledTimes(attempt + 1)
    }
    status.mockResolvedValue(readyStatus())
    vi.setSystemTime(Date.now() + 300_000)
    await dispatch()
    expect(status).toHaveBeenCalledTimes(9)
    status.mockRejectedValue(new DeviceApplicationAdmissionError('background_yield'))
    vi.setSystemTime(Date.now() + 5000)
    await dispatch()
    expect(status).toHaveBeenCalledTimes(10)
    vi.setSystemTime(Date.now() + 4999)
    await dispatch()
    expect(status).toHaveBeenCalledTimes(10)
    vi.setSystemTime(Date.now() + 1)
    await dispatch()
    expect(status).toHaveBeenCalledTimes(11)
  } finally {
    await f.service.close()
  }
})
