import { afterEach, describe, expect, it, vi } from 'vitest'
import { telemetryComputerFixture, telemetryOwnedFixture } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { TelemetryCollectedBatchSchema } from '@foreman-code/contracts/resource-telemetry'
import { cpuWindow } from './cpu.js'
import { disjointAccounting, type AccountingHandle } from './linuxCgroup.js'
import { counter, parseHostCpu, parseHostMemory, parseOnlineCpus, parseProcStat, safeBytes, sourceFailure } from './linuxProcfs.js'
import { collectProcessSet, type ProcessIdentity } from './processSet.js'
import { revisionedOwnershipReader, type OwnershipView } from './ownership.js'
import { LinuxSampler, type SamplerPorts } from './sampler.js'
import { createResourceCollector } from './lifecycle.js'

const identity = { mainId: telemetryComputerFixture.mainId, host: telemetryComputerFixture.host }
const signal = () => new AbortController().signal
const stat = (pid: number, start = '100', cpu = '20', parent = 1, rss = '2') => `${pid} (name ) with spaces) S ${parent} 0 0 0 0 0 0 0 0 0 ${cpu} 0 900 999 0 0 0 0 ${start} 0 ${rss}`
const root: ProcessIdentity = { bootId: identity.host.bootId, pid: 42, startTicks: '100' }
const view = (): OwnershipView => ({ selector: telemetryOwnedFixture, leaseId: 'lease-1', launchIds: ['launch-1'],
  observedDeviceId: identity.host.deviceId, observedInstallationId: identity.host.applicationInstallationId,
  roots: [root], accountingHandles: [], shared: false, lifecycle: 'active' })
function ports(views = [view()]): SamplerPorts & { advance(ns: bigint): void } {
  let now = 1_000_000_000n; let ticks = 0
  return { advance(ns) { now += ns; ticks += 10 }, now: () => now,
    wholeHostVisible: true, constants: { clockTicksPerSecond: 250n, pageSize: 16384n },
    read: async path => {
      if (path.includes('boot_id')) return identity.host.bootId
      if (path.includes('online')) return '0-3'
      if (path.includes('meminfo')) return 'MemTotal: 100 kB\nMemAvailable: 40 kB\n'
      return `cpu ${ticks} 0 0 100 0 0 0 0 999 999\n`
    }, process: { stat: async pid => stat(pid, '100', String(20 + ticks)), children: async () => [] },
    ownership: { snapshot: async () => ({ revision: '1', views }), changes: async function* () {} },
  }
}
const handle = (path: string, inode = path): AccountingHandle => ({ boundary: { kind: 'cgroup-v2', path, device: '1', inode }, exclusive: true,
  read: async () => ({ cpu: 100n, memory: 512, cpuFailure: null, memoryFailure: null }) })
afterEach(() => vi.useRealTimers())

describe('bounded source parsing', () => {
  it('parses final comm parenthesis and excludes cutime/cstime', () => { expect(parseProcStat(stat(42))).toMatchObject({ pid: 42, cpuTicks: 20n, startTicks: '100', rssPages: 2n }) })
  it.each(['-1', '1.1', '18446744073709551616', '999999999999999999999', '', 'NaN'])('rejects malformed/overflow %s', value => expect(() => counter(value)).toThrow())
  it('rejects unsafe byte integers', () => expect(() => safeBytes(9007199254740992n)).toThrow())
  it('host CPU excludes guest, iowait and steal from active', () => expect(parseHostCpu('cpu 1 2 3 4 5 6 7 8 100 100\n')).toEqual({ active: 19n, total: 36n }))
  it('requires MemAvailable and scales kB exactly', () => { expect(parseHostMemory('MemTotal: 10 kB\nMemAvailable: 4 kB')).toEqual({ bytes: 6144, totalBytes: 10240, availableBytes: 4096 }); expect(() => parseHostMemory('MemTotal: 10 kB\nMemFree: 4 kB')).toThrow() })
  it('rejects available above total', () => expect(() => parseHostMemory('MemTotal: 1 kB\nMemAvailable: 4 kB')).toThrow())
  it('canonicalizes online membership, including equal-count hotplug', () => { expect(parseOnlineCpus('0-2,4')).toBe('0,1,2,4'); expect(parseOnlineCpus('0,1')).not.toBe(parseOnlineCpus('0,2')) })
  it.each(['EACCES', 'EPERM'])('preserves permission failure %s', code => expect(sourceFailure({ code })).toBe('permission-denied'))
  it('does not equate missing with zero', () => expect(sourceFailure({ code: 'ENOENT' })).toBe('source-missing'))
})
describe('CPU windows', () => {
  const initial = { generation: 'g', monoNs: 1n, counter: 100n, total: null }
  it('initial is warmup', () => expect(cpuWindow(undefined, initial)).toBeNull())
  it('actual scheduling interval retains measured zero', () => expect(cpuWindow(initial, { ...initial, monoNs: 2_500_000_001n })).toMatchObject({ elapsedNs: '2500000000', previous: '100', current: '100' }))
  it.each(['owner', 'boot', 'collector', 'cores'])('resets changed %s generation', generation => expect(cpuWindow(initial, { ...initial, generation, monoNs: 2n })).toBeNull())
  it('allows exactly 6s but resets above it and backwards clock', () => { expect(cpuWindow(initial, { ...initial, monoNs: 6_000_000_001n })).not.toBeNull(); expect(cpuWindow(initial, { ...initial, monoNs: 6_000_000_002n })).toBeNull(); expect(cpuWindow(initial, { ...initial, monoNs: 0n })).toBeNull() })
  it('resets decreasing counter', () => expect(cpuWindow(initial, { ...initial, counter: 1n, monoNs: 2n })).toBeNull())
})
describe('captured process sets', () => {
  const collect = (reader: SamplerPorts['process'], retained: ProcessIdentity[] = [], budget = 4096) => collectProcessSet({ roots: [root], retained, bootId: identity.host.bootId, reader, constants: { clockTicksPerSecond: 250n, pageSize: 16384n }, signal: signal(), budget: { remaining: budget }, now: () => 1n })
  it('uses qualified constants and includes guardian root overhead', async () => { const result = await collect({ stat: async pid => stat(pid), children: async () => [] }); expect(result.cpuNs).toBe(80_000_000n); expect(result.rssBytes).toBe(32768); expect(result.limitations).toContain('process-tree-partial') })
  it('rejects PID generation changed mid-read', async () => { let reads = 0; const result = await collect({ stat: async pid => stat(pid, ++reads === 1 ? '100' : '101'), children: async () => [] }); expect(result.cpuNs).toBeNull(); expect(result.limitations).toContain('identity-changed') })
  it('retains known reparented and setsid child identity', async () => { const child = { ...root, pid: 43, startTicks: '200' }; const result = await collect({ stat: async pid => stat(pid, pid === 42 ? '100' : '200', '20', 1), children: async () => [] }, [child]); expect(result.identities).toContainEqual(child); expect(result.rssBytes).toBe(65536) })
  it('does not adopt reused parent or wrong boot', async () => { const result = await collect({ stat: async pid => stat(pid, '999'), children: async () => [43] }, [{ ...root, bootId: 'other', pid: 43 }]); expect(result.cpuNs).toBeNull(); expect(result.identities).not.toContainEqual({ ...root, pid: 43 }) })
  it('missing/denied/empty never proves closure', async () => { const result = await collect({ stat: async () => { throw Object.assign(new Error(), { code: 'EACCES' }) }, children: async () => [] }); expect(result.cpuNs).toBeNull(); expect(result.identities).toEqual([root]); expect(result.limitations).toContain('permission-denied') })
  it('enforces identity budget and deduplicates shared roots', async () => { const result = await collect({ stat: async pid => stat(pid), children: async () => [43, 44] }, [root], 1); expect(result.identities).toHaveLength(1); expect(result.limitations).toContain('limit-exceeded') })
})
describe('owned/host sampler', () => {
  it('refreshes storage every ten seconds while CPU and memory remain live', async () => {
    const p = ports([])
    let availableBytes = 250
    p.storage = vi.fn(async () => ({ totalBytes: 1000, availableBytes }))
    const sampler = new LinuxSampler(p)
    await sampler.capture(identity, signal())
    availableBytes = 100
    p.advance(2_000_000_000n)
    const warm = await sampler.capture(identity, signal())
    expect(warm.host?.storage?.availableBytes).toBe(250)
    expect(warm.host?.cpu.state).toBe('ok')
    expect(warm.host?.memory.state).toBe('ok')
    expect(p.storage).toHaveBeenCalledTimes(1)
    p.advance(8_000_000_000n)
    expect((await sampler.capture(identity, signal())).host?.storage?.availableBytes).toBe(100)
    expect(p.storage).toHaveBeenCalledTimes(2)
  })
  it('invalidates storage on collector generation changes, reset and backwards time', async () => {
    const p = ports([])
    p.storage = vi.fn(async () => ({ totalBytes: 1000, availableBytes: 250 }))
    const sampler = new LinuxSampler(p)
    await sampler.capture(identity, signal())
    const changed = { ...identity, host: { ...identity.host, collectorGeneration: 'replacement-collector' } }
    await sampler.capture(changed, signal())
    sampler.reset()
    await sampler.capture(changed, signal())
    p.advance(-1n)
    await sampler.capture(changed, signal())
    expect(p.storage).toHaveBeenCalledTimes(4)
  })
  it('retries failed storage refreshes without publishing an old value', async () => {
    const p = ports([])
    const storage = vi.fn(async () => ({ totalBytes: 1000, availableBytes: 250 }))
    p.storage = storage
    const sampler = new LinuxSampler(p)
    await sampler.capture(identity, signal())
    p.advance(10_000_000_000n)
    storage.mockRejectedValueOnce(new Error('storage unavailable'))
    expect((await sampler.capture(identity, signal())).host?.storage).toBeNull()
    expect((await sampler.capture(identity, signal())).host?.storage?.availableBytes).toBe(250)
    expect(storage).toHaveBeenCalledTimes(3)
  })
  it('reports host storage for the computer and none when the host cannot report it', async () => {
    const p = ports(); p.storage = async () => ({ totalBytes: 1000, availableBytes: 250 })
    expect((await new LinuxSampler(p).capture(identity, signal())).host?.storage).toEqual({ totalBytes: 1000, availableBytes: 250 })
    p.storage = async () => { throw Object.assign(new Error(), { code: 'EACCES' }) }
    const failed = await new LinuxSampler(p).capture(identity, signal())
    expect(failed.host?.storage).toBeNull(); expect(failed.host?.memory.state).toBe('ok')
    p.wholeHostVisible = false
    expect((await new LinuxSampler(p).capture(identity, signal())).host?.storage).toBeUndefined()
  })
  it('initial CPU warms while RAM is independently usable', async () => { const p = ports(); const sample = await new LinuxSampler(p).capture(identity, signal()); expect(sample.host?.cpu.state).toBe('warmup'); expect(sample.host?.memory).toMatchObject({ state: 'ok', value: { bytes: 61440 } }); expect(sample.owned[0]?.memory).toMatchObject({ state: 'ok', value: { kind: 'rss-sum', sharedPagesMayDoubleCount: true } }) })
  it('process CPU uses only common exact generations and real elapsed', async () => { const p = ports(); const sampler = new LinuxSampler(p); await sampler.capture(identity, signal()); p.advance(2_500_000_000n); const result = await sampler.capture(identity, signal()); expect(result.owned[0]?.cpu).toMatchObject({ state: 'ok', intervalDeltaNs: '40000000', windowStartMonoNs: '1000000000', windowEndMonoNs: '3500000000' }) })
  it('process exit does not create a negative lifetime-sum delta', async () => { const p = ports(); let child = true; p.process = { stat: async pid => stat(pid), children: async pid => pid === 42 && child ? [43] : [] }; const sampler = new LinuxSampler(p); await sampler.capture(identity, signal()); child = false; p.process.stat = async pid => { if (pid === 43) throw Object.assign(new Error(), { code: 'ENOENT' }); return stat(pid) }; p.advance(2_000_000_000n); expect((await sampler.capture(identity, signal())).owned[0]?.cpu).toMatchObject({ state: 'ok', intervalDeltaNs: '0' }) })
  it('nested cgroups count once and shared memberships are explicit', async () => { const v = view(); v.accountingHandles = [handle('/sys/fs/cgroup/a', '1'), handle('/sys/fs/cgroup/a/b', '2')]; const shared = { ...v, selector: { ...v.selector, attributionRef: 'other' } }; const result = await new LinuxSampler(ports([v, shared])).capture(identity, signal()); expect(result.owned[0]?.memory).toMatchObject({ state: 'ok', value: { bytes: 512, kind: 'cgroup-current' } }); expect(result.owned[0]?.coverage.shared).toBe(true); expect(disjointAccounting(v.accountingHandles).handles).toHaveLength(1) })
  it('closed and ended do not sample, background unconfirmed still samples', async () => { const closed = { ...view(), lifecycle: 'closed' as const }; const background = { ...view(), selector: { ...view().selector, attributionRef: 'background' }, lifecycle: 'closure-unconfirmed' as const }; const result = await new LinuxSampler(ports([closed, background])).capture(identity, signal()); expect(result.owned[0]?.cpu).toMatchObject({ state: 'unavailable', reason: 'closed' }); expect(result.owned[1]?.memory.state).toBe('ok') })
  it('bounds host plus owned rows and reports namespace restriction under the trusted identity', async () => {
    const p = ports(Array.from({ length: 65 }, (_, i) => ({ ...view(), selector: { ...view().selector, attributionRef: `scope-${i}` } })))
    p.wholeHostVisible = false; const read = vi.spyOn(p, 'read'); const result = await new LinuxSampler(p).capture(identity, signal())
    expect(result.owned).toHaveLength(63); expect(result.truncated).toBe(true)
    expect(result.host).toEqual({ selector: telemetryComputerFixture, coverage: { boundary: 'partial', shared: false, reasons: ['namespace-restricted'] },
      cpu: { state: 'unavailable', reason: 'namespace-restricted' }, memory: { state: 'unavailable', reason: 'namespace-restricted' } })
    expect(read.mock.calls.some(([path]) => path === '/proc/stat' || path === '/proc/meminfo')).toBe(false)
    expect(result.diagnostics).toContain('namespace-restricted')
  })
  it('retries revision changes without mutating ownership', async () => { let revision = '1'; let count = 0; const reader = revisionedOwnershipReader({ revision: () => revision, read: async () => { if (++count === 1) revision = '2'; return [view()] }, changes: async function* () {} }); expect((await reader.snapshot(signal())).revision).toBe('2'); expect(count).toBe(2) })
})
describe('challenge lifecycle', () => {
  it('captures only after challenge, single cadence, two-frame queue and idempotent close', async () => {
    vi.useFakeTimers(); const p = ports([]); const collector = createResourceCollector({ identity, ports: p });
    const challenge = (id: string) => ({ schemaVersion: 1 as const, identity, challengeId: id, issuedAtUnixMs: 1000, freshUntilUnixMs: 7000 })
    expect(collector.offer(challenge('1'))).toBe('accepted'); expect(collector.offer(challenge('1'))).toBe('coalesced');
    await vi.advanceTimersByTimeAsync(1)
    const abort = new AbortController(); const iterator = collector.samples(abort.signal)[Symbol.asyncIterator](); const first = await iterator.next()
    expect(TelemetryCollectedBatchSchema.safeParse(first.value).success).toBe(true)
    expect(BigInt(first.value!.captureStartMonoNs)).toBeGreaterThanOrEqual(BigInt(first.value!.challengeReceivedMonoNs))
    expect(collector.offer({ ...challenge('wrong'), identity: { ...identity, mainId: 'bad' } })).toBe('rejected')
    const closeA = collector.close(); const closeB = collector.close(); expect(closeA).toBe(closeB); await closeA; expect(collector.offer(challenge('2'))).toBe('rejected'); await iterator.return?.(); expect(vi.getTimerCount()).toBe(0)
  })
  it('joins slow outstanding reads before close resolves', async () => {
    vi.useFakeTimers(); const p = ports([]); const original = p.read
    // Both independent reads must settle, so use one shared gate.
    let release!: () => void; const gate = new Promise<void>(r => { release = r }); p.read = async (path, sig, cap) => { await gate; sig.throwIfAborted(); return original(path, sig, cap) }
    const collector = createResourceCollector({ identity, ports: p }); collector.offer({ schemaVersion: 1, identity, challengeId: 'slow', issuedAtUnixMs: 1, freshUntilUnixMs: 6001 }); await vi.advanceTimersByTimeAsync(1)
    let done = false; const closing = collector.close().then(() => { done = true }); await Promise.resolve(); expect(done).toBe(false); release(); await closing; expect(done).toBe(true)
  })
})

describe('generation and source failure isolation', () => {
  it('same manager second launch resets its CPU baseline', async () => {
    const v = view(); const p = ports([v]); const sampler = new LinuxSampler(p); await sampler.capture(identity, signal()); p.advance(2_000_000_000n)
    v.launchIds = ['launch-1', 'launch-2']; expect((await sampler.capture(identity, signal())).owned[0]?.cpu.state).toBe('warmup')
  })
  it('same-count core hotplug and collector restart reset CPU only', async () => {
    const p = ports(); const original = p.read; let online = '0-3'; p.read = (path, sig, cap) => path.includes('online') ? Promise.resolve(online) : original(path, sig, cap)
    const sampler = new LinuxSampler(p); await sampler.capture(identity, signal()); p.advance(2_000_000_000n); online = '1-4'
    expect((await sampler.capture(identity, signal())).host?.cpu.state).toBe('warmup'); p.advance(2_000_000_000n)
    const changed = { ...identity, host: { ...identity.host, collectorGeneration: 'collector-2' } }; const result = await sampler.capture(changed, signal())
    expect(result.host?.cpu.state).toBe('warmup'); expect(result.host?.memory.state).toBe('ok')
  })
  it('boot changed during read rejects the capture', async () => {
    const p = ports(); const original = p.read; let calls = 0; p.read = (path, sig, cap) => path.includes('boot_id') && ++calls > 1 ? Promise.resolve('different-boot') : original(path, sig, cap)
    await expect(new LinuxSampler(p).capture(identity, signal())).rejects.toThrow('identity-changed')
  })
  it('cgroup inode replacement resets CPU, not memory', async () => {
    const v = view(); v.accountingHandles = [handle('/sys/fs/cgroup/a', '1')]; const p = ports([v]); const sampler = new LinuxSampler(p)
    await sampler.capture(identity, signal()); p.advance(2_000_000_000n); v.accountingHandles = [handle('/sys/fs/cgroup/a', '2')]
    const result = await sampler.capture(identity, signal()); expect(result.owned[0]?.cpu.state).toBe('warmup'); expect(result.owned[0]?.memory.state).toBe('ok')
  })
  it('permission-denied CPU preserves independently valid cgroup RAM', async () => {
    const v = view(); v.accountingHandles = [{ ...handle('/sys/fs/cgroup/a'), read: async () => ({ cpu: null, memory: 1024, cpuFailure: 'permission-denied', memoryFailure: null }) }]
    const result = await new LinuxSampler(ports([v])).capture(identity, signal()); expect(result.owned[0]?.cpu).toEqual({ state: 'permission-denied', reason: 'permission-denied' }); expect(result.owned[0]?.memory.state).toBe('ok'); expect(result.owned[0]?.coverage.boundary).toBe('partial')
  })
  it('OS host CPU denial cannot suppress RAM', async () => {
    const p = ports(); const original = p.read; p.read = (path, sig, cap) => path === '/proc/stat' ? Promise.reject(Object.assign(new Error(), { code: 'EPERM' })) : original(path, sig, cap)
    const result = await new LinuxSampler(p).capture(identity, signal()); expect(result.host?.cpu.state).toBe('permission-denied'); expect(result.host?.memory.state).toBe('ok')
  })
  it('replaced observed host does not expose ownership values', async () => { const v = view(); v.observedDeviceId = 'another-device'; expect((await new LinuxSampler(ports([v])).capture(identity, signal())).owned).toEqual([]) })
  it('accounting source cap remains partial', async () => { const v = view(); v.accountingHandles = Array.from({ length: 9 }, (_, i) => handle(`/sys/fs/cgroup/${i}`, String(i))); const result = await new LinuxSampler(ports([v])).capture(identity, signal()); expect(result.owned[0]?.coverage).toMatchObject({ boundary: 'partial', reasons: ['limit'] }) })
  it('memory measured zero remains a real zero', async () => { const p = ports(); const original = p.read; p.read = (path, sig, cap) => path.includes('meminfo') ? Promise.resolve('MemTotal: 1 kB\nMemAvailable: 1 kB') : original(path, sig, cap); expect((await new LinuxSampler(p).capture(identity, signal())).host?.memory).toMatchObject({ state: 'ok', value: { bytes: 0 } }) })
})

describe('hard collector bounds', () => {
  it('4097 captured roots are truncated to 4096 without a proc table scan', async () => {
    const roots = Array.from({ length: 4097 }, (_, i) => ({ ...root, pid: i + 2 })); const statRead = vi.fn(async (pid: number) => stat(pid));
    const result = await collectProcessSet({ roots, retained: [], bootId: identity.host.bootId, reader: { stat: statRead, children: async () => [] }, constants: { clockTicksPerSecond: 100n, pageSize: 4096n }, signal: signal(), budget: { remaining: 4096 }, now: () => 1n })
    expect(result.identities).toHaveLength(4096); expect(result.limitations).toContain('limit-exceeded'); expect(statRead).toHaveBeenCalledTimes(8192)
  })
  it('scan clock budget leaves uncertainty instead of zero', async () => {
    let time = 0n; const result = await collectProcessSet({ roots: [root], retained: [], bootId: identity.host.bootId, reader: { stat: async pid => stat(pid), children: async () => [] }, constants: { clockTicksPerSecond: 100n, pageSize: 4096n }, signal: signal(), budget: { remaining: 4096 }, now: () => { time += 300_000_000n; return time } })
    expect(result.cpuNs).toBeNull(); expect(result.limitations).toContain('limit-exceeded')
  })
  it('overflow memory cannot erase valid CPU measurement', async () => {
    const v = view(); v.accountingHandles = [handle('/sys/fs/cgroup/a'), handle('/sys/fs/cgroup/b')].map(h => ({ ...h, read: async () => ({ cpu: 100n, memory: Number.MAX_SAFE_INTEGER, cpuFailure: null, memoryFailure: null }) }))
    const result = await new LinuxSampler(ports([v])).capture(identity, signal()); expect(result.owned[0]?.cpu.state).toBe('warmup'); expect(result.owned[0]?.memory).toMatchObject({ state: 'unavailable', reason: 'counter-invalid' })
  })
})

describe('collector queue and failure joining', () => {
  const fakeClock = () => ({ now: () => BigInt(Date.now()) * 1_000_000n, wall: Date.now, setTimer: setTimeout, clearTimer: clearTimeout })
  const challenge = (id: string) => ({ schemaVersion: 1 as const, identity, challengeId: id, issuedAtUnixMs: 0, freshUntilUnixMs: 6000 })
  it('retains at most two outgoing frames and reports sequence gaps', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const p = ports([]); const clock = fakeClock(); p.now = clock.now
    const collector = createResourceCollector({ identity, ports: p, clock })
    collector.offer(challenge('1')); await vi.advanceTimersByTimeAsync(1)
    collector.offer(challenge('2')); await vi.advanceTimersByTimeAsync(2000)
    collector.offer(challenge('3')); await vi.advanceTimersByTimeAsync(2000)
    const iter = collector.samples(signal())[Symbol.asyncIterator](); expect((await iter.next()).value?.sequence).toBe('2'); expect((await iter.next()).value?.sequence).toBe('3')
    await collector.close(); await iter.return?.(); expect(vi.getTimerCount()).toBe(0)
  })
  it('one failed source cannot abandon a concurrent live read', async () => {
    vi.useFakeTimers(); const p = ports([]); let release!: () => void; const gate = new Promise<void>(r => { release = r })
    p.read = async path => { if (path.includes('boot_id')) throw new Error('source-missing'); await gate; return '0' }
    const collector = createResourceCollector({ identity, ports: p }); collector.offer(challenge('failure')); await vi.advanceTimersByTimeAsync(1)
    let joined = false; const close = collector.close().then(() => { joined = true }); await Promise.resolve(); expect(joined).toBe(false); release(); await close; expect(joined).toBe(true)
  })
  it('caps outstanding challenges and skips missed ticks after slow capture', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const p = ports([]); const original = p.read; const clock = fakeClock(); p.now = clock.now
    let release!: () => void; const gate = new Promise<void>(r => { release = r }); let slow = true
    p.read = async (path, sig, cap) => { if (slow) await gate; return original(path, sig, cap) }
    const collector = createResourceCollector({ identity, ports: p, clock }); expect(collector.offer(challenge('1'))).toBe('accepted'); await vi.advanceTimersByTimeAsync(1)
    expect(collector.offer(challenge('2'))).toBe('accepted'); expect(collector.offer(challenge('3'))).toBe('rejected')
    await vi.advanceTimersByTimeAsync(3000); slow = false; release(); await vi.advanceTimersByTimeAsync(0)
    const iter = collector.samples(signal())[Symbol.asyncIterator](); expect((await iter.next()).value?.sequence).toBe('1')
    let resolved = false; const second = iter.next().then(result => { resolved = true; return result }); await vi.advanceTimersByTimeAsync(998); expect(resolved).toBe(false); await vi.advanceTimersByTimeAsync(1); expect((await second).value?.sequence).toBe('2')
    await collector.close(); await iter.return?.()
  })
})

describe('global deadline and absent captures', () => {
  it('does not begin another scope read after global scan deadline', async () => {
    const p = ports(); const original = p.read; let time = 0n; p.now = () => time
    p.read = async (path, sig, cap) => { const value = await original(path, sig, cap); if (path === '/proc/meminfo') time = 300_000_000n; return value }
    const proc = vi.spyOn(p.process, 'stat'); const result = await new LinuxSampler(p).capture(identity, signal())
    expect(result.owned[0]?.cpu).toEqual({ state: 'unavailable', reason: 'limit' }); expect(proc).not.toHaveBeenCalled(); expect(result.truncated).toBe(true)
  })
  it('missing producer registration stays ownership-unavailable', async () => { const v = view(); v.launchIds = []; const result = await new LinuxSampler(ports([v])).capture(identity, signal()); expect(result.owned[0]?.memory).toEqual({ state: 'unavailable', reason: 'ownership-unavailable' }) })
})
it('I/O errors remain source failures, independently of malformed counters', () => { expect(sourceFailure({ code: 'EIO' })).toBe('source-failure'); expect(sourceFailure(new Error('invalid-counter'))).toBe('invalid-counter') })

describe('independent proc fallback failures', () => {
  const collect = (text: string, deniedChildren = false) => collectProcessSet({ roots: [root], retained: [], bootId: identity.host.bootId,
    reader: { stat: async () => text, children: async () => { if (deniedChildren) throw Object.assign(new Error(), { code: 'EACCES' }); return [] } }, constants: { clockTicksPerSecond: 250n, pageSize: 16384n }, signal: signal(), budget: { remaining: 4096 }, now: () => 1n })
  it('malformed CPU preserves usable RSS', async () => { const result = await collect(stat(42, '100', 'NaN')); expect(result.cpuNs).toBeNull(); expect(result.rssBytes).toBe(32768); expect(result.limitations).toContain('invalid-counter') })
  it('malformed RSS preserves valid CPU', async () => { const result = await collect(stat(42, '100', '20', 1, '-1')); expect(result.cpuNs).toBe(80000000n); expect(result.rssBytes).toBeNull() })
  it('denied child list preserves validated root subtotal and explicit partial reason', async () => { const result = await collect(stat(42), true); expect(result.cpuNs).toBe(80000000n); expect(result.rssBytes).toBe(32768); expect(result.limitations).toContain('permission-denied') })
})
it('passive ownership source failure cannot suppress valid host memory', async () => {
  const p = ports(); p.ownership.snapshot = async () => { throw Object.assign(new Error(), { code: 'EACCES' }) }
  const result = await new LinuxSampler(p).capture(identity, signal()); expect(result.host?.memory.state).toBe('ok'); expect(result.owned).toEqual([]); expect(result.diagnostics).toEqual(['permission-denied', 'ownership-unavailable'])
})

it('captured root birth changes warm CPU instead of reporting an invented zero on PID reuse', async () => {
  const v = view(); const p = ports([v]); const sampler = new LinuxSampler(p)
  await sampler.capture(identity, signal()); p.advance(2_000_000_000n)
  v.roots = [{ ...root, startTicks: '101' }]; p.process.stat = async pid => stat(pid, '101')
  expect((await sampler.capture(identity, signal())).owned[0]?.cpu.state).toBe('warmup')
})
it('unaccounted OCI helper keeps usable boundary values explicitly partial', async () => {
  const v = view(); v.accountingHandles = [handle('/sys/fs/cgroup/job')]; v.accountingIncomplete = true
  const row = (await new LinuxSampler(ports([v])).capture(identity, signal())).owned[0]!
  expect(row.memory.state).toBe('ok'); expect(row.coverage).toMatchObject({ boundary: 'partial', reasons: ['escaped-boundary'] })
})
