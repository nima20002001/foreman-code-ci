import { describe, expect, it } from 'vitest'
import { DeviceRequestQueue } from './deviceRequestQueue.js'

describe('background device requests while an Agent works on the computer', () => {
  it('admits a background status read while one long foreground request is in flight', async () => {
    const queue = new DeviceRequestQueue()
    const releaseAgent = await queue.acquire({ priority: 'foreground', stop: false })
    const releaseStatus = await queue.acquire({ priority: 'background', stop: false })
    releaseStatus()
    releaseAgent()
  })

  it('still yields background work when only the reserved foreground slot is left', async () => {
    const queue = new DeviceRequestQueue()
    const held = await Promise.all(Array.from({ length: 7 }, () => queue.acquire({ priority: 'foreground', stop: false })))
    await expect(queue.acquire({ priority: 'background', stop: false })).rejects.toMatchObject({ reason: 'background_yield' })
    for (const release of held) release()
  })
})
