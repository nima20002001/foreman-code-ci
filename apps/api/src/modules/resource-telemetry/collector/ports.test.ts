import { afterEach, expect, it, vi } from 'vitest'
import { telemetryComputerFixture, telemetryOwnedFixture } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { TelemetryCollectedBatchSchema } from '@foreman-code/contracts/resource-telemetry'
import type { PassiveNativeRegistry, TrustedNativeScope, TrustedNativeScopes } from './registryAdapter.js'

const io = vi.hoisted(() => ({ read: vi.fn(), stat: vi.fn(), children: vi.fn(), create: vi.fn() }))
vi.mock('./io.js', () => ({ boundedReader: (concurrency: number) => {
  io.create(concurrency)
  return { read: io.read, process: { stat: io.stat, children: io.children } }
} }))
import { createPassiveLinuxResourceCollector } from './ports.js'

afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

it('mounts one passive worker sampler and reads current captured launches only after authenticated challenge receipt', async () => {
  vi.useFakeTimers()
  const identity = { mainId: telemetryComputerFixture.mainId, host: structuredClone(telemetryComputerFixture.host) }
  let now = 1_000_000_000n
  io.read.mockImplementation(async (path: string) => path.includes('boot_id') ? identity.host.bootId
    : path.includes('online') ? '0-3' : path.includes('meminfo') ? 'MemTotal: 100 kB\nMemAvailable: 40 kB\n' : 'cpu 10 0 0 100 0 0 0 0\n')
  io.stat.mockImplementation(async (pid: number) => `${pid} (captured provider) S 1 0 0 0 0 0 0 0 0 0 20 0 0 0 0 0 0 0 100 0 2`)
  io.children.mockResolvedValue([])
  let revision = '1'
  const snapshot = vi.fn(() => ({ revision, launches: [{ owner: 'actual-native-owner', launchId: `actual-launch-${revision}`,
    bootId: identity.host.bootId, guardian: { pid: 42, startTicks: '100' }, lifecycle: 'active' as const }] }))
  const registry: PassiveNativeRegistry = { revision: () => revision, snapshot, changes: async function* () {} }
  const scope: TrustedNativeScope = { nativeOwner: 'actual-native-owner', selector: structuredClone(telemetryOwnedFixture),
    leaseId: 'captured-lease', observedDeviceId: identity.host.deviceId, observedInstallationId: identity.host.applicationInstallationId,
    shared: false, lifecycle: 'active' }
  const scopes: TrustedNativeScopes = { revision: () => revision, snapshot: async () => [scope], changes: async function* () {} }
  const collector = await createPassiveLinuxResourceCollector({ identity, registry, nativeScopes: actual => {
    expect(actual).toEqual(identity); expect(actual).not.toBe(identity); return scopes
  }, wholeHostVisible: true, signal: new AbortController().signal, constants: { clockTicksPerSecond: 250n, pageSize: 16384n },
  clock: { now: () => now, wall: () => 1000, setTimer: setTimeout, clearTimer: clearTimeout } })
  const consumer = new AbortController()
  const iterator = collector.samples(consumer.signal)[Symbol.asyncIterator]()
  try {
    expect(snapshot).not.toHaveBeenCalled(); expect(io.read).not.toHaveBeenCalled()
    revision = '2'
    const challenge = (challengeId: string) => ({ schemaVersion: 1 as const, identity, challengeId, issuedAtUnixMs: 1000, freshUntilUnixMs: 7000 })
    expect(collector.offer(challenge('first'))).toBe('accepted')
    await vi.advanceTimersByTimeAsync(1)
    const first = (await iterator.next()).value!
    expect(TelemetryCollectedBatchSchema.safeParse(first).success).toBe(true)
    expect(first.owned[0]?.cpu.state).toBe('warmup')
    expect(first.owned[0]?.memory).toMatchObject({ state: 'ok', value: { kind: 'rss-sum', bytes: 32768 } })
    expect(first.captureStartMonoNs).toBe(first.challengeReceivedMonoNs)
    // A new actual launch invalidates the baseline, even on the same owner/connection.
    revision = '3'; now += 2_000_000_000n
    expect(collector.offer(challenge('second'))).toBe('accepted')
    await vi.advanceTimersByTimeAsync(1)
    expect((await iterator.next()).value!.owned[0]?.cpu.state).toBe('warmup')
    expect(io.create).toHaveBeenCalledExactlyOnceWith(8)
  } finally { await collector.close(); consumer.abort(); await iterator.return?.() }
  expect(vi.getTimerCount()).toBe(0)
})
