import { describe, expect, it } from 'vitest'
import { asForegroundWork, effectiveDeviceRequestPriority } from './deviceRequestQueue.js'

describe('device request priority during tool calls', () => {
  it('treats harness discovery and checks as foreground while serving a tool call', async () => {
    const inside = await asForegroundWork(async () => [
      effectiveDeviceRequestPriority('harness-discovery-v1', { operation: 'discover' }),
      effectiveDeviceRequestPriority('host-harness-check-v1', { operation: 'check' }),
    ])
    expect(inside).toEqual(['foreground', 'foreground'])
  })

  it('keeps unattended discovery in the background and honours an explicit priority', () => {
    expect(effectiveDeviceRequestPriority('harness-discovery-v1', { operation: 'discover' })).toBe('background')
    expect(effectiveDeviceRequestPriority('execution-v1', {}, 'background')).toBe('background')
  })
})
