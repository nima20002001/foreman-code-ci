import { afterEach, expect, it, vi } from 'vitest'
import { dispatchFleet } from './dispatchFleet.testSupport.js'

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

it('bounds failed dispatch retries and resets the delay after a successful pass', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = dispatchFleet([], [])
  const computers = vi.spyOn(f.endpoint, 'computers').mockRejectedValue(new Error('Query read timeout'))
  try {
    await f.service.dispatch()
    expect(computers).toHaveBeenCalledTimes(1)
    for (let attempt = 1; attempt <= 10; attempt++) {
      const delay = Math.min(300_000, 1000 * 2 ** (attempt - 1))
      vi.setSystemTime(Date.now() + delay - 1)
      await f.service.dispatch()
      expect(computers).toHaveBeenCalledTimes(attempt)
      vi.setSystemTime(Date.now() + 1)
      await f.service.dispatch()
      expect(computers).toHaveBeenCalledTimes(attempt + 1)
    }
    computers.mockResolvedValue([])
    vi.setSystemTime(Date.now() + 300_000)
    await f.service.dispatch()
    expect(computers).toHaveBeenCalledTimes(12)
    computers.mockRejectedValue(new Error('Connection terminated'))
    vi.setSystemTime(Date.now() + 5000)
    await f.service.dispatch()
    expect(computers).toHaveBeenCalledTimes(13)
    vi.setSystemTime(Date.now() + 999)
    await f.service.dispatch()
    expect(computers).toHaveBeenCalledTimes(13)
    vi.setSystemTime(Date.now() + 1)
    await f.service.dispatch()
    expect(computers).toHaveBeenCalledTimes(14)
  } finally {
    await f.service.close()
  }
})
