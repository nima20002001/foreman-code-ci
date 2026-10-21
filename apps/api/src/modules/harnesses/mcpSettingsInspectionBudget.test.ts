import { afterEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { HarnessMcpSettingsService } from './mcpSettings.js'
import { fingerprint, type NativeMcpAdapter } from './nativeMcpCommon.js'

const phases = ['binary-identity', 'version', 'authentication', 'schema',
  'initialize', 'config-read', 'mcp-list', 'config-recheck']
const principal: ManagementPrincipal = {
  id: 'owner', name: 'Owner', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
  grants: [{ actions: ['harnesses:read', 'harnesses:update'], scope: {} }],
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function fixture(duration = 14_000) {
  vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Inspection deadline exceeded', 'TimeoutError')), milliseconds)
    return controller.signal
  })
  const active = new Set<string>()
  const started: string[] = []
  let warm = false
  const adapter: NativeMcpAdapter = {
    async read(signal) {
      for (const phase of phases) {
        if (warm && phase === 'schema') continue
        signal.throwIfAborted()
        started.push(phase)
        active.add(phase)
        try {
          await new Promise<void>((resolve, reject) => {
            const finish = () => {
              signal.removeEventListener('abort', abort)
              resolve()
            }
            const timer = setTimeout(finish, duration)
            const abort = () => {
              clearTimeout(timer)
              signal.removeEventListener('abort', abort)
              reject(signal.reason)
            }
            signal.addEventListener('abort', abort, { once: true })
          })
        } finally {
          active.delete(phase)
        }
      }
      warm = true
      return { harness: 'codex', revision: fingerprint({}), file: '/missing-native-config', version: '1',
        user: {}, userConfig: {}, effective: {} }
    },
    async apply() { throw new Error('Read-only inspection cannot write configuration') },
  }
  const closeProcesses = vi.fn(async () => {})
  const service = new HarnessMcpSettingsService({} as never, {} as never, { codex: adapter }, () => {}, closeProcesses)
  return { service, active, started, closeProcesses }
}

it('allows cold and warm settings inspection to use the same two-minute budget as preflight', async () => {
  const f = fixture()
  try {
    for (const duration of [112_000, 98_000]) {
      const pending = f.service.list(principal, 'codex')
      const assertion = expect(pending).resolves.toMatchObject({ harness: 'codex', servers: [] })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(f.active.size).toBe(1)
      await vi.advanceTimersByTimeAsync(duration - 60_000)
      await assertion
      expect(f.active.size).toBe(0)
    }
    expect(f.started).toEqual([...phases, ...phases.filter(phase => phase !== 'schema')])
  } finally {
    await f.service.shutdown()
  }
})

it('bounds the whole settings inspection and closes the phase active at the deadline', async () => {
  const f = fixture(16_000)
  try {
    const pending = f.service.list(principal, 'codex')
    const assertion = expect(pending).rejects.toMatchObject({ code: 'HARNESS_CHECK_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(119_999)
    expect([...f.active]).toEqual(['config-recheck'])
    await vi.advanceTimersByTimeAsync(1)
    await assertion
    expect(f.active.size).toBe(0)
    expect(f.started).toEqual(phases)
  } finally {
    await f.service.shutdown()
  }
})

it.each(phases)('settles settings shutdown during %s before releasing process ownership', async selected => {
  const f = fixture()
  const pending = f.service.list(principal, 'codex')
  const assertion = expect(pending).rejects.toMatchObject({ code: 'HARNESS_CHECK_TIMEOUT' })
  try {
    await vi.advanceTimersByTimeAsync(phases.indexOf(selected) * 14_000 + 1)
    expect([...f.active]).toEqual([selected])
    await f.service.shutdown()
    await assertion
    expect(f.active.size).toBe(0)
    expect(f.closeProcesses).toHaveBeenCalledOnce()
    expect(f.started).toEqual(phases.slice(0, phases.indexOf(selected) + 1))
  } finally {
    await f.service.shutdown()
  }
})
