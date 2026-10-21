import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { telemetryComputerFixture, telemetryOwnedFixture } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { TELEMETRY_LIMITS, TelemetryCollectedBatchSchema, TelemetryReadResultSchema, TelemetryReasonSchema, telemetrySelectorKey, type TelemetryCollectedBatch, type CollectionChallenge, type TrustedTelemetryContext } from '@foreman-code/contracts/resource-telemetry'
import { ResourceTelemetryService } from './service.js'
import { readTelemetry } from '../readback/adapters.js'
import type { TelemetryOwnershipView } from './ports.js'
import { createResourceCollector } from '../collector/lifecycle.js'
import type { OwnershipView } from '../collector/ownership.js'
const principal: ManagementPrincipal = { id: 'operator-1', name: 'Test Operator', audience: 'operator',
  grants: [], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }
const signal = () => new AbortController().signal
function setup() {
  let mono = 0, wall = 1_000_000, active = true, presence: 'online' | 'offline' = 'online', permitted = true, sharedAllowed = true
  let ownership: TelemetryOwnershipView | null = { selector: telemetryOwnedFixture, state: 'active', sharedOwners: [] }
  const service = new ResourceTelemetryService({ clock: { monotonicMs: () => mono, unixMs: () => wall },
    sessions: { active: vi.fn(async () => active), presence: vi.fn(async () => presence) },
    reads: { allow: vi.fn(async (_principal, selector) => permitted && (selector.scope !== 'owned' || selector.owner.kind !== 'workflow-execution' || selector.owner.workspaceId === 'workspace-1')),
      allowSharedOwner: vi.fn(async () => sharedAllowed) }, ownership: { resolve: vi.fn(async () => ownership) } })
  const h = telemetryComputerFixture.host
  const context: TrustedTelemetryContext = { kind: 'main-local', mainId: telemetryComputerFixture.mainId,
    deviceId: h.deviceId, applicationInstallationId: h.applicationInstallationId, bootId: h.bootId, runtimeEpoch: h.runtimeEpoch, capability: 'resource-telemetry/v1' }
  return { service, context, advance(ms: number) { mono += ms; wall += Math.floor(ms) }, wall(ms: number) { wall += ms },
    active(value: boolean) { active = value }, presence(value: 'online' | 'offline') { presence = value }, permitted(value: boolean) { permitted = value },
    shared(value: boolean) { sharedAllowed = value }, ownership(value: TelemetryOwnershipView | null) { ownership = value } }
}
function batch(challenge: CollectionChallenge, sequence = '1', start = '1000000'): TelemetryCollectedBatch {
  return { schemaVersion: 1, identity: structuredClone(challenge.identity), challengeId: challenge.challengeId, sequence,
    collectedAtUnixMs: challenge.issuedAtUnixMs, challengeReceivedMonoNs: start, captureStartMonoNs: start,
    captureEndMonoNs: (BigInt(start) + 1_000_000n).toString(), logicalCpuCount: 8,
    host: { selector: { ...telemetryComputerFixture, host: structuredClone(challenge.identity.host) }, coverage: { boundary: 'complete-boundary', shared: false, reasons: [] },
      cpu: { state: 'warmup', reason: 'warmup' }, memory: { state: 'ok', value: { kind: 'host-used-estimate', bytes: 0, totalBytes: 8192, availableBytes: 8192, sharedPagesMayDoubleCount: false } } },
    owned: [{ selector: { ...telemetryOwnedFixture, host: structuredClone(challenge.identity.host) }, coverage: { boundary: 'partial', shared: false, reasons: [] },
      cpu: { state: 'warmup', reason: 'warmup' }, memory: { state: 'ok', value: { kind: 'rss-sum', bytes: 4096, totalBytes: null, availableBytes: null, sharedPagesMayDoubleCount: true } } }], diagnostics: [], truncated: false }
}
async function capture(s: ReturnType<typeof setup>, seq = '1', start = '1000000') {
  const c = await s.service.challenge(s.context, signal())
  if (!c) throw new Error('challenge unavailable')
  const b = batch(c, seq, start)
  const receipt = await s.service.ingest(s.context, JSON.stringify(b), signal())
  return { c, b, receipt }
}
async function ready() {
  const s = setup(); await s.service.handshake(s.context, 'collector-1', signal()); return s
}
describe('computer storage', () => {
  it('publishes current free disk space and withholds it once the computer is offline or stale', async () => {
    const s = await ready()
    const c = (await s.service.challenge(s.context, signal()))!
    const b = batch(c)
    b.host!.storage = { totalBytes: 1000, availableBytes: 250 }
    expect((await s.service.ingest(s.context, JSON.stringify(b), signal())).status).toBe('accepted')
    const fresh = TelemetryReadResultSchema.parse(await s.service.read(principal, telemetryComputerFixture, signal()))
    expect(fresh.kind === 'sample' && fresh.sample.storage).toEqual({ totalBytes: 1000, availableBytes: 250 })
    s.presence('offline')
    const offline = TelemetryReadResultSchema.parse(await s.service.read(principal, telemetryComputerFixture, signal()))
    expect(offline.kind === 'sample' && offline.sample.storage).toBeNull()
    s.presence('online'); s.advance(TELEMETRY_LIMITS.freshMs)
    const stale = TelemetryReadResultSchema.parse(await s.service.read(principal, telemetryComputerFixture, signal()))
    expect(stale.kind === 'sample' && stale.sample.storage).toBeNull()
  })

  it('rejects storage reported for an owned scope', async () => {
    const s = await ready()
    const c = (await s.service.challenge(s.context, signal()))!
    const b = batch(c)
    b.owned[0]!.storage = { totalBytes: 1000, availableBytes: 250 }
    await expect(s.service.ingest(s.context, JSON.stringify(b), signal())).rejects.toThrow()
  })
})
describe('fresh computer memory for Job admission', () => {
  it('uses current authenticated memory and refuses another boot or a stale sample', async () => {
    const s = await ready()
    const { c } = await capture(s)
    const host = c.identity.host
    const expected = { hostRef: host.hostRef, applicationInstallationId: host.applicationInstallationId,
      bootId: host.bootId, keyRevision: host.keyRevision, authorizationRevision: host.authorizationRevision }
    expect(await s.service.availableComputerMemory(expected, signal())).toBe(8192)
    expect(await s.service.availableComputerMemory({ ...expected,
      bootId: '22222222-2222-4222-8222-222222222222' }, signal())).toBeNull()
    s.advance(TELEMETRY_LIMITS.freshMs)
    expect(await s.service.availableComputerMemory(expected, signal())).toBeNull()
  })

  it('does not consume offline or revoked computer data for admission', async () => {
    const s = await ready()
    const { c } = await capture(s)
    const host = c.identity.host
    const expected = { hostRef: host.hostRef, applicationInstallationId: host.applicationInstallationId,
      bootId: host.bootId, keyRevision: host.keyRevision, authorizationRevision: host.authorizationRevision }
    s.presence('offline')
    expect(await s.service.availableComputerMemory(expected, signal())).toBeNull()
    s.presence('online')
    s.active(false)
    expect(await s.service.availableComputerMemory(expected, signal())).toBeNull()
  })
})
async function collected(s: ReturnType<typeof setup>, views: OwnershipView[], wholeHostVisible = true) {
  const challenge = (await s.service.challenge(s.context, signal()))!
  vi.useFakeTimers()
  const collector = createResourceCollector({ identity: challenge.identity,
    clock: { now: () => 1_000_000n, wall: () => challenge.issuedAtUnixMs, setTimer: setTimeout, clearTimer: clearTimeout },
    ports: { now: () => 1_000_000n, wholeHostVisible, constants: { clockTicksPerSecond: 100n, pageSize: 4096n },
      read: async path => path.includes('boot_id') ? challenge.identity.host.bootId : path.includes('online') ? '0-7'
        : path.includes('meminfo') ? 'MemTotal: 8 kB\nMemAvailable: 4 kB' : 'cpu 1 0 0 10 0 0 0 0',
      process: { stat: async () => { throw new Error('unexpected process read') }, children: async () => [] },
      ownership: { snapshot: async () => ({ revision: '1', views }), changes: async function* () {} } } })
  const iterator = collector.samples(signal())[Symbol.asyncIterator]()
  try {
    expect(collector.offer(challenge)).toBe('accepted'); await vi.advanceTimersByTimeAsync(1)
    return TelemetryCollectedBatchSchema.parse((await iterator.next()).value)
  } finally { await collector.close(); await iterator.return?.(); vi.useRealTimers() }
}
const collectorView = (lifecycle: OwnershipView['lifecycle']): OwnershipView => ({ selector: telemetryOwnedFixture,
  lifecycle, leaseId: 'lease-1', launchIds: ['launch-1'], observedDeviceId: telemetryOwnedFixture.host.deviceId,
  observedInstallationId: telemetryOwnedFixture.host.applicationInstallationId, roots: [], shared: false,
  accountingHandles: [{ boundary: { kind: 'cgroup-v2', path: '/sys/fs/cgroup/owned', device: '1', inode: '1' }, exclusive: true,
    read: async () => ({ cpu: 100n, memory: 4096, cpuFailure: null, memoryFailure: null }) }] })
describe('authenticated telemetry ingestion and scoped readback', () => {
  it('reads real collector namespace restrictions without authorizing the computer from an owned grant', async () => {
    const s = await ready(), b = await collected(s, [collectorView('active')], false)
    await s.service.ingest(s.context, JSON.stringify(b), signal())
    const read = TelemetryReadResultSchema.parse(await s.service.read(principal, telemetryComputerFixture, signal()))
    expect(read.kind).toBe('sample')
    if (read.kind !== 'sample') throw new Error('sample')
    expect(read.sample.identity).toEqual(b.identity); expect(read.lastKnown).toBeNull()
    expect(read.sample.cpu).toMatchObject({ state: 'unavailable', reason: 'namespace-restricted', value: null })
    expect(read.sample.memory).toMatchObject({ state: 'unavailable', reason: 'namespace-restricted', value: null })
    s.service.ports.reads.allow = async (_p, selector) => selector.scope === 'owned'
    expect((await s.service.read(principal, telemetryComputerFixture, signal())).kind).toBe('denied')
    expect((await s.service.read(principal, telemetryOwnedFixture, signal())).kind).toBe('sample')
  })
  it.each(['ended', 'closed'] as const)('accepts real collector %s rows while refreshing host and another live owner', async lifecycle => {
    const s = await ready(), terminal = collectorView(lifecycle), live = collectorView('active')
    terminal.launchIds = []
    live.accountingHandles = live.accountingHandles.map(handle => ({ ...handle, boundary: { ...handle.boundary, path: '/sys/fs/cgroup/live', inode: '2' } }))
    if (telemetryOwnedFixture.owner.kind !== 'workflow-execution') throw new Error('workflow fixture')
    live.selector = { ...telemetryOwnedFixture, owner: { ...telemetryOwnedFixture.owner, attemptId: 'attempt-live' }, attributionRef: 'lease-live' }
    s.service.ports.ownership.resolve = async selector => ({ selector, state: telemetrySelectorKey(selector) === telemetrySelectorKey(terminal.selector) ? lifecycle : 'active', sharedOwners: [] })
    const b = await collected(s, [terminal, live]); await s.service.ingest(s.context, JSON.stringify(b), signal())
    for (const selector of [telemetryComputerFixture, live.selector]) {
      const read = TelemetryReadResultSchema.parse(await s.service.read(principal, selector, signal()))
      expect(read.kind === 'sample' && read.sample.memory.state).toBe('fresh')
    }
    const read = TelemetryReadResultSchema.parse(await s.service.read(principal, terminal.selector, signal()))
    expect(read.kind === 'sample' && read.sample.ownershipState).toBe(lifecycle)
    expect(read.kind === 'sample' && read.sample.memory.reason).toBe(lifecycle)
    expect(read.kind === 'sample' && read.lastKnown).toBeNull()
  })
  it.each(['ended', 'closed'] as const)('rejects forged %s rows, numeric terminal rows and retired attempts', async lifecycle => {
    const s = await ready(), c = (await s.service.challenge(s.context, signal()))!, b = batch(c)
    const unavailable = { state: 'unavailable', reason: lifecycle } as const
    b.owned[0]!.cpu = unavailable; b.owned[0]!.memory = unavailable
    await expect(s.service.ingest(s.context, JSON.stringify(b), signal())).rejects.toThrow('owner-binding')
    s.ownership({ selector: telemetryOwnedFixture, state: lifecycle, sharedOwners: [] })
    await expect(s.service.ingest(s.context, JSON.stringify(batch(c)), signal())).rejects.toThrow('owner-binding')
    s.ownership(null)
    await expect(s.service.ingest(s.context, JSON.stringify(b), signal())).rejects.toThrow('owner-binding')
    expect((await s.service.read(principal, telemetryComputerFixture, signal())).kind).toBe('no-sample')
  })
  it('revalidates exact terminal ownership after asynchronous authority reads', async () => {
    const s = await ready(), c = (await s.service.challenge(s.context, signal()))!, b = batch(c)
    b.owned[0]!.cpu = { state: 'unavailable', reason: 'closed' }; b.owned[0]!.memory = { state: 'unavailable', reason: 'closed' }
    let calls = 0
    s.service.ports.ownership.resolve = async () => ({ selector: telemetryOwnedFixture, state: ++calls === 1 ? 'closed' : 'active', sharedOwners: [] })
    await expect(s.service.ingest(s.context, JSON.stringify(b), signal())).rejects.toThrow('owner-binding')
    expect((await s.service.read(principal, telemetryComputerFixture, signal())).kind).toBe('no-sample')
  })
  it('issues one-use bounded challenges and rejects prechallenge/expired capture', async () => {
    const s = await ready(); const c = (await s.service.challenge(s.context, signal()))!
    expect(await s.service.challenge(s.context, signal())).toBeNull()
    s.advance(2000); expect(await s.service.challenge(s.context, signal())).not.toBeNull()
    s.advance(2000); expect(await s.service.challenge(s.context, signal())).toBeNull()
    const b = batch(c); b.captureStartMonoNs = '0'
    await expect(s.service.ingest(s.context, JSON.stringify(b), signal())).rejects.toThrow('schema')
    s.advance(2000)
    await expect(s.service.ingest(s.context, JSON.stringify(batch(c)), signal())).rejects.toThrow('challenge')
  })
  it('is idempotent without renewing freshness, rejects conflict/out of order and counts gaps', async () => {
    const s = await ready(); const first = await capture(s)
    s.advance(1000)
    expect((await s.service.ingest(s.context, JSON.stringify(first.b), signal())).status).toBe('duplicate')
    const conflicting = { ...first.b, collectedAtUnixMs: first.b.collectedAtUnixMs + 1 }
    await expect(s.service.ingest(s.context, JSON.stringify(conflicting), signal())).rejects.toThrow('conflicting-duplicate')
    s.advance(1000); const second = await capture(s, '4', '2001000000')
    expect(second.receipt.gaps).toBe('2')
    await expect(s.service.ingest(s.context, JSON.stringify(first.b), signal())).rejects.toThrow('out-of-order')
    await expect(s.service.ingest(s.context, JSON.stringify({ ...second.b, sequence: '5' }), signal())).rejects.toThrow('challenge')
  })
  it.each([5999, 6000, 6001])('expires by main monotonic age %i independently of wall skew', async age => {
    const s = await ready(); await capture(s); s.advance(age); s.wall(86_400_000)
    const read = await s.service.read(principal, telemetryOwnedFixture, signal())
    expect(read.kind).toBe('sample')
    if (read.kind !== 'sample') throw new Error('sample')
    expect(read.sample.memory.state).toBe(age < 6000 ? 'fresh' : 'stale')
    expect(read.sample.memory.value).toEqual(age < 6000 ? read.lastKnown!.memory.value : null)
    expect(read.sample.ageUpperBoundMs).toBe(age)
    if (age < 6000) expect(read.sample.memory.freshUntilUnixMs).toBe(read.sample.freshUntilUnixMs)
    expect(read.lastKnown!.receivedAtUnixMs).toBe(1_000_000)
  })
  it.each([0.25, Number(123456n) / 1_000_000])('keeps Unix deadlines valid with fractional monotonic elapsed %s', async elapsed => {
    const s = await ready(), c = (await s.service.challenge(s.context, signal()))!
    s.advance(elapsed)
    await s.service.ingest(s.context, JSON.stringify(batch(c)), signal())
    const retainedDeadline = Math.floor(1_000_000 + 6000 - elapsed)
    s.advance(0.5); s.wall(10)
    const read = TelemetryReadResultSchema.parse(await s.service.read(principal, telemetryOwnedFixture, signal()))
    if (read.kind !== 'sample') throw new Error('sample')
    expect(read.sample.ageUpperBoundMs).toBe(elapsed + 0.5)
    expect(read.sample.freshUntilUnixMs).toBe(Math.floor(1_000_010 + 6000 - elapsed - 0.5))
    expect(read.sample.memory.freshUntilUnixMs).toBe(read.sample.freshUntilUnixMs)
    expect(read.lastKnown!.freshUntilUnixMs).toBe(retainedDeadline)
    expect(read.lastKnown!.memory.freshUntilUnixMs).toBe(retainedDeadline)
    s.advance(5999.25 - elapsed)
    const stillFresh = TelemetryReadResultSchema.parse(await s.service.read(principal, telemetryOwnedFixture, signal()))
    expect(stillFresh.kind === 'sample' && stillFresh.sample.ageUpperBoundMs).toBe(5999.75)
    expect(stillFresh.kind === 'sample' && stillFresh.sample.memory.state).toBe('fresh')
    s.advance(0.25)
    const expired = TelemetryReadResultSchema.parse(await s.service.read(principal, telemetryOwnedFixture, signal()))
    expect(expired.kind === 'sample' && expired.sample.ageUpperBoundMs).toBe(6000)
    expect(expired.kind === 'sample' && expired.sample.memory.state).toBe('stale')
    expect(expired.kind === 'sample' && expired.lastKnown!.freshUntilUnixMs).toBe(retainedDeadline)
  })
  it.each([false, true])('bounds truncated coverage with a full reason list and existing limit=%s', async existingLimit => {
    const s = await ready(), c = (await s.service.challenge(s.context, signal()))!, b = batch(c)
    const reasons: TelemetryCollectedBatch['owned'][number]['coverage']['reasons'] = TelemetryReasonSchema.options.filter(reason => reason !== 'limit').slice(0, 16)
    if (existingLimit) reasons[0] = 'limit'
    b.truncated = true; b.owned[0]!.coverage = { boundary: 'complete-boundary', shared: false, reasons }
    TelemetryCollectedBatchSchema.parse(b)
    await s.service.ingest(s.context, JSON.stringify(b), signal())
    const read = TelemetryReadResultSchema.parse(await s.service.read(principal, telemetryOwnedFixture, signal()))
    if (read.kind !== 'sample') throw new Error('sample')
    for (const sample of [read.sample, read.lastKnown!]) {
      expect(sample.coverage.boundary).toBe('partial')
      expect(sample.coverage.reasons).toHaveLength(16)
      expect(sample.coverage.reasons).toContain('limit')
      expect(new Set(sample.coverage.reasons).size).toBe(16)
    }
  })
  it('computes real zero CPU after warmup and independently fresh memory', async () => {
    const s = await ready(); await capture(s)
    const first = await s.service.read(principal, telemetryOwnedFixture, signal())
    expect(first.kind === 'sample' && first.sample.cpu.state).toBe('warmup')
    s.advance(2000); const c = (await s.service.challenge(s.context, signal()))!, b = batch(c, '2', '2001000000')
    b.owned[0]!.cpu = { state: 'ok', basis: 'cgroup-usage-usec', previousCounter: '100', currentCounter: '100',
      previousTotal: null, currentTotal: null, intervalDeltaNs: null, baselineRef: 'boundary-1', windowStartMonoNs: '1000000', windowEndMonoNs: '2001000000' }
    await s.service.ingest(s.context, JSON.stringify(b), signal())
    const read = await s.service.read(principal, telemetryOwnedFixture, signal())
    expect(read.kind === 'sample' && read.sample.cpu.state === 'fresh' && read.sample.cpu.value.hostCapacityPercent).toBe(0)
  })
  it('rejects invalid counter arithmetic instead of clamping and handles core changes', async () => {
    const s = await ready(); await capture(s); s.advance(2000)
    const c = (await s.service.challenge(s.context, signal()))!, b = batch(c, '2', '2001000000')
    b.owned[0]!.cpu = { state: 'ok', basis: 'cgroup-usage-usec', previousCounter: '10', currentCounter: '1',
      previousTotal: null, currentTotal: null, intervalDeltaNs: null, baselineRef: 'b', windowStartMonoNs: '1000000', windowEndMonoNs: '2001000000' }
    await s.service.ingest(s.context, JSON.stringify(b), signal())
    const read = await s.service.read(principal, telemetryOwnedFixture, signal())
    expect(read.kind === 'sample' && read.sample.cpu.state).toBe('unavailable')
  })
  it('denies before cache lookup, never leaks lastKnown, and treats host permission separately', async () => {
    const s = await ready(); await capture(s); s.permitted(false)
    expect(await s.service.read(principal, telemetryComputerFixture, signal())).toEqual({ kind: 'denied', selectorKey: telemetrySelectorKey(telemetryComputerFixture) })
    expect(await s.service.read(principal, telemetryOwnedFixture, signal())).toEqual({ kind: 'denied', selectorKey: telemetrySelectorKey(telemetryOwnedFixture) })
    s.permitted(true)
    const foreign = { ...telemetryOwnedFixture, owner: { ...telemetryOwnedFixture.owner, workspaceId: 'other' } }
    expect((await s.service.read(principal, foreign, signal())).kind).toBe('denied')
  })
  it('keeps offline/ended lastKnown original and expires it after 15 minutes', async () => {
    const s = await ready(); await capture(s); s.presence('offline')
    const offline = await s.service.read(principal, telemetryOwnedFixture, signal())
    expect(offline.kind === 'sample' && offline.sample.memory.value).toBeNull()
    expect(offline.kind === 'sample' && offline.lastKnown!.memory.state).toBe('fresh')
    s.presence('online'); s.ownership({ selector: telemetryOwnedFixture, state: 'ended', sharedOwners: [] })
    expect((await s.service.read(principal, telemetryOwnedFixture, signal())).kind).toBe('sample')
    s.advance(2000)
    const c = (await s.service.challenge(s.context, signal()))!, ended = batch(c, '2')
    ended.owned[0]!.cpu = { state: 'unavailable', reason: 'ended' }; ended.owned[0]!.memory = { state: 'unavailable', reason: 'ended' }
    await s.service.ingest(s.context, JSON.stringify(ended), signal())
    const terminal = TelemetryReadResultSchema.parse(await s.service.read(principal, telemetryOwnedFixture, signal()))
    expect(terminal.kind === 'sample' && terminal.sample.memory.reason).toBe('ended')
    expect(terminal.kind === 'sample' && terminal.lastKnown!.receivedAtUnixMs).toBe(1_000_000)
    expect(terminal.kind === 'sample' && terminal.lastKnown!.memory.value?.bytes).toBe(4096)
    s.advance(900000)
    const expired = TelemetryReadResultSchema.parse(await s.service.read(principal, telemetryOwnedFixture, signal()))
    expect(expired.kind === 'no-sample' && expired.reason).toBe('ended')
    expect(JSON.stringify(expired)).not.toContain('4096')
    s.permitted(false); expect((await s.service.read(principal, telemetryOwnedFixture, signal())).kind).toBe('denied')
  })
  it('expires numeric samples into reason-only tombstones and clears them on revocation', async () => {
    const s = await ready(); await capture(s); s.advance(TELEMETRY_LIMITS.lastKnownMs)
    const expired = TelemetryReadResultSchema.parse(await s.service.read(principal, telemetryComputerFixture, signal()))
    expect(expired.kind === 'no-sample' && expired.reason).toBe('stale')
    expect(JSON.stringify(expired)).not.toContain('8192')
    s.service.revoke(s.context)
    expect((await s.service.read(principal, telemetryComputerFixture, signal())).kind).toBe('no-sample')
    const reset = await s.service.handshake(s.context, 'collector-1', signal())
    expect(reset.host).toEqual(telemetryComputerFixture.host)
    const read = await s.service.read(principal, telemetryComputerFixture, signal())
    expect(read.kind === 'no-sample' && read.reason).toBe('not-yet-sampled')
  })
  it.each(['active', 'ended', 'closed'] as const)('keeps a bounded nonnumeric reason after cache pressure for an %s owner', async lifecycle => {
    const s = await ready()
    const byteLength = Buffer.byteLength
    // Force the actual cache accounting path over its fixed cap without weakening wire/schema bounds.
    const accounting = vi.spyOn(Buffer, 'byteLength').mockImplementation((value, encoding) =>
      typeof value === 'string' && value.includes('"latest":') ? TELEMETRY_LIMITS.cacheBytes : byteLength(value, encoding))
    try {
      await capture(s); s.ownership({ selector: telemetryOwnedFixture, state: lifecycle, sharedOwners: [] })
      const read = TelemetryReadResultSchema.parse(await s.service.read(principal, telemetryOwnedFixture, signal()))
      expect(read.kind === 'no-sample' && read.reason).toBe(lifecycle === 'active' ? 'evicted' : lifecycle)
      expect(JSON.stringify(read)).not.toContain('4096')
      s.permitted(false); expect((await s.service.read(principal, telemetryOwnedFixture, signal())).kind).toBe('denied')
    } finally { accounting.mockRestore() }
  })
  it('fences identity, collector generation, observed host and stale accepted ownership', async () => {
    const s = await ready(); const c = (await s.service.challenge(s.context, signal()))!
    const wrong = batch(c); wrong.identity.host.collectorGeneration = 'spoof'
    await expect(s.service.ingest(s.context, JSON.stringify(wrong), signal())).rejects.toThrow('identity')
    const stale = batch(c); s.ownership({ selector: { ...telemetryOwnedFixture, attributionRevision: '2' }, state: 'active', sharedOwners: [] })
    await expect(s.service.ingest(s.context, JSON.stringify(stale), signal())).rejects.toThrow('owner-binding')
    const host = batch(c); host.owned[0]!.selector.host.applicationInstallationId = 'wrong-install'
    await expect(s.service.ingest(s.context, JSON.stringify(host), signal())).rejects.toThrow('observed-host')
  })
  it('rejects old connection/revoked callbacks and drops caches on authenticated reset', async () => {
    const s = await ready(); const original = await capture(s)
    await s.service.handshake(s.context, 'collector-2', signal())
    await expect(s.service.ingest(s.context, JSON.stringify(original.b), signal())).rejects.toThrow('identity')
    expect((await s.service.read(principal, telemetryOwnedFixture, signal())).kind).toBe('no-sample')
    s.active(false)
    await expect(s.service.challenge(s.context, signal())).rejects.toThrow('authorization')
  })
  it('does not disclose shared co-owner values and marks omitted rows unavailable', async () => {
    const s = await ready(); await capture(s)
    s.ownership({ selector: telemetryOwnedFixture, state: 'active', sharedOwners: [telemetryOwnedFixture.owner] }); s.shared(false)
    const read = await s.service.read(principal, telemetryOwnedFixture, signal())
    expect(read.kind === 'no-sample' && read.reason).toBe('shared-restricted')
    s.shared(true); s.ownership({ selector: telemetryOwnedFixture, state: 'active', sharedOwners: [] }); s.advance(2000); const c = (await s.service.challenge(s.context, signal()))!, b = batch(c, '2'); b.owned = []
    await s.service.ingest(s.context, JSON.stringify(b), signal())
    const missing = await s.service.read(principal, telemetryOwnedFixture, signal())
    expect(missing.kind === 'sample' && missing.sample.memory.state).toBe('unavailable')
  })
  it('withholds historically unenumerated shared values until a new authorized capture', async () => {
    const s = await ready(), challenge = (await s.service.challenge(s.context, signal()))!, b = batch(challenge)
    b.owned[0]!.coverage.shared = true
    await s.service.ingest(s.context, JSON.stringify(b), signal())
    expect(await s.service.read(principal, telemetryOwnedFixture, signal())).toMatchObject({ kind: 'no-sample', reason: 'shared-restricted' })
    const read = await s.service.read(principal, telemetryOwnedFixture, signal())
    expect('lastKnown' in read).toBe(false)
    s.ownership({ selector: telemetryOwnedFixture, state: 'active', sharedOwners: [telemetryOwnedFixture.owner], sharedOwnersComplete: false })
    expect(await s.service.read(principal, telemetryOwnedFixture, signal())).toMatchObject({ kind: 'no-sample', reason: 'shared-restricted' })
    s.ownership({ selector: telemetryOwnedFixture, state: 'active', sharedOwners: [telemetryOwnedFixture.owner], sharedOwnersComplete: true })
    expect(await s.service.read(principal, telemetryOwnedFixture, signal())).toMatchObject({ kind: 'no-sample', reason: 'shared-restricted' })
    s.advance(2000)
    const next = batch((await s.service.challenge(s.context, signal()))!, '2')
    next.owned[0]!.coverage.shared = true
    await s.service.ingest(s.context, JSON.stringify(next), signal())
    expect((await s.service.read(principal, telemetryOwnedFixture, signal())).kind).toBe('sample')
  })
  it('keeps all current accepted rows when a full batch replaces one omitted owner', async () => {
    const s = await ready(), c = (await s.service.challenge(s.context, signal()))!, first = batch(c)
    const ownedRow = (index: number) => ({ ...structuredClone(first.owned[0]!), selector: {
      ...structuredClone(telemetryOwnedFixture), owner: { kind: 'operator-conversation' as const,
        conversationId: `conversation-${index}`, leaseId: `lease-${index}` } } })
    first.owned = Array.from({ length: TELEMETRY_LIMITS.rows - 1 }, (_, index) => ownedRow(index))
    const retired = first.owned[0]!.selector
    let retiredEnded = false
    s.service.ports.ownership.resolve = async selector => ({ selector,
      state: retiredEnded && telemetrySelectorKey(selector) === telemetrySelectorKey(retired) ? 'ended' : 'active', sharedOwners: [] })
    const firstJson = JSON.stringify(first)
    expect(Buffer.byteLength(firstJson)).toBeLessThanOrEqual(TELEMETRY_LIMITS.batchBytes)
    await s.service.ingest(s.context, firstJson, signal())
    s.advance(2000); retiredEnded = true
    const nextChallenge = (await s.service.challenge(s.context, signal()))!, second = batch(nextChallenge, '2', '2001000000')
    const replacement = ownedRow(TELEMETRY_LIMITS.rows)
    second.owned = [...first.owned.slice(1), replacement]
    second.host!.memory = { state: 'ok', value: { kind: 'host-used-estimate', bytes: 1024,
      totalBytes: 8192, availableBytes: 7168, sharedPagesMayDoubleCount: false } }
    replacement.memory = { state: 'ok', value: { kind: 'rss-sum', bytes: 8192,
      totalBytes: null, availableBytes: null, sharedPagesMayDoubleCount: true } }
    const secondJson = JSON.stringify(second)
    expect(Buffer.byteLength(secondJson)).toBeLessThanOrEqual(TELEMETRY_LIMITS.batchBytes)
    await s.service.ingest(s.context, secondJson, signal())
    const audit = { record: async () => {} }
    for (const row of [second.host!, ...second.owned]) {
      const read = await readTelemetry(s.service, principal, row.selector, signal(), 'http', audit)
      expect(read.kind).toBe('sample')
      if (read.kind !== 'sample') throw new Error('sample')
      expect(read.sample.sequence).toBe('2')
      expect(read.sample.memory.state).toBe('fresh')
      expect(read.sample.memory.value).toEqual(row.memory.state === 'ok' ? row.memory.value : null)
      expect(read.lastKnown!.sequence).toBe('2')
    }
    const omitted = await readTelemetry(s.service, principal, retired, signal(), 'http', audit)
    expect(omitted.kind).toBe('no-sample')
    expect(omitted.kind === 'no-sample' && omitted.reason).toBe('ended')
    await s.service.close()
  })
  it('rejects oversized raw JSON before parsing and uint64/negative/nonfinite payloads', async () => {
    const s = await ready(); await expect(s.service.ingest(s.context, ' '.repeat(65537), signal())).rejects.toThrow('batch-limit')
    const c = (await s.service.challenge(s.context, signal()))!
    for (const sequence of ['-1', '18446744073709551616', '01']) await expect(s.service.ingest(s.context, JSON.stringify(batch(c, sequence)), signal())).rejects.toThrow('schema')
  })
  it('bounds queued frames, fences revocation during async authorization, and joins close', async () => {
    const s = await ready(); const c = (await s.service.challenge(s.context, signal()))!
    let unblock!: () => void
    s.service.ports.ownership.resolve = async () => { await new Promise<void>(resolve => { unblock = resolve }); return { selector: telemetryOwnedFixture, state: 'active', sharedOwners: [] } }
    const first = s.service.ingest(s.context, JSON.stringify(batch(c)), signal())
    await vi.waitFor(() => expect(unblock).toBeTypeOf('function'))
    const second = s.service.ingest(s.context, JSON.stringify(batch(c, '2')), signal())
    await expect(s.service.ingest(s.context, JSON.stringify(batch(c, '3')), signal())).rejects.toThrow('backpressure')
    s.service.revoke(s.context); unblock()
    await expect(first).rejects.toThrow('authorization'); await expect(second).rejects.toThrow('authorization')
    await s.service.close()
  })
  it.each(['cgroup-usage-usec', 'process-utime-stime'] as const)('checks owned %s arithmetic against actual windows', async basis => {
    const s = await ready(); await capture(s); s.advance(2000)
    const c = (await s.service.challenge(s.context, signal()))!, b = batch(c, '2', '2001000000')
    b.owned[0]!.cpu = { state: 'ok', basis, previousCounter: '10', currentCounter: basis === 'cgroup-usage-usec' ? '4000010' : '1',
      previousTotal: null, currentTotal: null, intervalDeltaNs: basis === 'process-utime-stime' ? '1000000000' : null,
      baselineRef: 'b', windowStartMonoNs: '1000000', windowEndMonoNs: '2001000000' }
    await s.service.ingest(s.context, JSON.stringify(b), signal())
    const result = await s.service.read(principal, telemetryOwnedFixture, signal())
    expect(result.kind === 'sample' && result.sample.cpu.state === 'fresh' && result.sample.cpu.value.hostCapacityPercent)
      .toBe(basis === 'cgroup-usage-usec' ? 25 : 6.25)
  })
  it('calculates host active/total ticks without guest, idle, iowait or steal as active', async () => {
    const s = await ready(); await capture(s); s.advance(2000)
    const c = (await s.service.challenge(s.context, signal()))!, b = batch(c, '2', '2001000000')
    b.host!.cpu = { state: 'ok', basis: 'host-active-ticks', previousCounter: '60', currentCounter: '80',
      previousTotal: '200', currentTotal: '240', intervalDeltaNs: null, baselineRef: 'host', windowStartMonoNs: '1000000', windowEndMonoNs: '2001000000' }
    await s.service.ingest(s.context, JSON.stringify(b), signal())
    const result = await s.service.read(principal, telemetryComputerFixture, signal())
    expect(result.kind === 'sample' && result.sample.cpu.state === 'fresh' && result.sample.cpu.value.hostCapacityPercent).toBe(50)
  })
  it('binds remote W07 device/key/auth/boot/epoch/install exactly, never to main origin', async () => {
    const s = setup(), context: TrustedTelemetryContext = { kind: 'remote', capability: 'resource-telemetry/v1', binding: {
      mainId: telemetryComputerFixture.mainId, deviceId: '55555555-5555-4555-8555-555555555555',
      workerInstallationId: '66666666-6666-4666-8666-666666666666', bootId: '77777777-7777-4777-8777-777777777777',
      keyRevision: 1, authorizationRevision: 2, connectionGeneration: 3, connectionEpoch: '88888888-8888-4888-8888-888888888888' } }
    const identity = await s.service.handshake(context, 'remote-1', signal())
    const c = (await s.service.challenge(context, signal()))!, b = batch(c)
    b.owned = []
    await s.service.ingest(context, JSON.stringify(b), signal())
    const selector = { ...telemetryComputerFixture, host: identity.host }
    const result = await s.service.read(principal, selector, signal())
    expect(result.kind === 'sample' && result.sample.identity.host.hostRef.kind).toBe('device')
    expect(result.kind === 'sample' && result.sample.identity.host.applicationInstallationId).toBe(context.binding.workerInstallationId)
    for (const field of ['mainId', 'deviceId', 'workerInstallationId', 'bootId', 'connectionEpoch'] as const) {
      const wrong = { ...context, binding: { ...context.binding, [field]: '99999999-9999-4999-8999-999999999999' } }
      await expect(s.service.ingest(wrong, JSON.stringify(b), signal())).rejects.toThrow('session-generation')
    }
    for (const field of ['keyRevision', 'authorizationRevision', 'connectionGeneration'] as const) {
      const wrong = { ...context, binding: { ...context.binding, [field]: context.binding[field] + 1 } }
      await expect(s.service.ingest(wrong, JSON.stringify(b), signal())).rejects.toThrow('session-generation')
    }
    await s.service.close()
  })
  it('enforces the device cap and does not retain old generations after restart/close', async () => {
    const s = setup()
    for (let i = 1; i <= 32; i++) await s.service.handshake({ ...s.context,
      deviceId: `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111` }, 'collector-1', signal())
    await expect(s.service.handshake(s.context, 'collector-1', signal())).rejects.toThrow('device-limit')
    await s.service.close()
    await expect(s.service.handshake(s.context, 'collector-2', signal())).rejects.toThrow('authorization')
  })
  it('changes emits expiry without collection, coalesces slow reads, and cleans timers on abort', async () => {
    vi.useFakeTimers()
    const s = await ready(); await capture(s)
    const controller = new AbortController(), changes = s.service.changes(principal, telemetryOwnedFixture, controller.signal)[Symbol.asyncIterator]()
    try {
      const first = await changes.next(); expect(first.value!.kind).toBe('sample')
      const next = changes.next(); s.advance(6000); await vi.advanceTimersByTimeAsync(1000)
      const stale = await next
      expect(stale.value!.kind === 'sample' && stale.value!.sample.memory.state).toBe('stale')
      controller.abort(); await changes.return?.(); await s.service.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally { controller.abort(); vi.useRealTimers() }
  })
  it('preserves exact A/B/A keys and never redirects an old attempt to a newer attribution', async () => {
    const s = await ready(); await capture(s)
    const old = await s.service.read(principal, telemetryOwnedFixture, signal())
    const nextSelector = { ...telemetryOwnedFixture, attributionRevision: '2' }
    s.ownership({ selector: nextSelector, state: 'active', sharedOwners: [] })
    const newer = await s.service.read(principal, nextSelector, signal())
    const oldAgain = await s.service.read(principal, telemetryOwnedFixture, signal())
    expect(old.kind === 'sample' && old.sample.selectorKey).toBe(telemetrySelectorKey(telemetryOwnedFixture))
    expect(newer.kind).toBe('no-sample'); expect(oldAgain.kind).toBe('no-sample')
    expect(telemetrySelectorKey(nextSelector)).not.toBe(telemetrySelectorKey(telemetryOwnedFixture))
  })

  it('does not publish ownership that ends during asynchronous revalidation', async () => {
    const s = await ready(), c = (await s.service.challenge(s.context, signal()))!
    let calls = 0
    s.service.ports.ownership.resolve = async () => ({ selector: telemetryOwnedFixture, state: ++calls === 1 ? 'active' : 'ended', sharedOwners: [] })
    await expect(s.service.ingest(s.context, JSON.stringify(batch(c)), signal())).rejects.toThrow('owner-binding')
    expect((await s.service.read(principal, telemetryOwnedFixture, signal())).kind).toBe('no-sample')
  })
  it('clears current private values for revoked/expired principals independent of port admission', async () => {
    const s = await ready(); await capture(s)
    const revoked = { ...principal, revokedAt: '2026-10-01T00:00:00Z' }
    expect((await s.service.read(revoked, telemetryOwnedFixture, signal())).kind).toBe('denied')
    const expired = { ...principal, expiresAt: '1970-01-01T00:00:00Z' }
    expect((await s.service.read(expired, telemetryComputerFixture, signal())).kind).toBe('denied')
  })
  it('close aborts and joins asynchronous callbacks even after their device is revoked', async () => {
    const s = await ready(), c = (await s.service.challenge(s.context, signal()))!
    let entered = false
    s.service.ports.ownership.resolve = async (_selector, abortSignal) => {
      entered = true
      await new Promise<void>((_resolve, reject) => { abortSignal.addEventListener('abort', () => reject(abortSignal.reason), { once: true }) })
      return null
    }
    const ingest = s.service.ingest(s.context, JSON.stringify(batch(c)), signal())
    const rejection = expect(ingest).rejects.toThrow('authorization')
    await vi.waitFor(() => expect(entered).toBe(true))
    s.service.revoke(s.context)
    await s.service.close(); await rejection
  })

  it('keeps OS CPU denial independent of usable RAM and warms up after logical-core changes', async () => {
    const s = await ready(), c = (await s.service.challenge(s.context, signal()))!, b = batch(c)
    b.owned[0]!.cpu = { state: 'permission-denied', reason: 'permission-denied' }
    await s.service.ingest(s.context, JSON.stringify(b), signal())
    const first = await s.service.read(principal, telemetryOwnedFixture, signal())
    expect(first.kind === 'sample' && first.sample.cpu.state).toBe('permission-denied')
    expect(first.kind === 'sample' && first.sample.memory.state).toBe('fresh')
    s.advance(2000); const c2 = (await s.service.challenge(s.context, signal()))!, b2 = batch(c2, '2', '2001000000')
    b2.logicalCpuCount = 4
    b2.owned[0]!.cpu = { state: 'ok', basis: 'cgroup-usage-usec', previousCounter: '0', currentCounter: '0',
      previousTotal: null, currentTotal: null, intervalDeltaNs: null, baselineRef: 'b', windowStartMonoNs: '1000000', windowEndMonoNs: '2001000000' }
    await s.service.ingest(s.context, JSON.stringify(b2), signal())
    const changed = await s.service.read(principal, telemetryOwnedFixture, signal())
    expect(changed.kind === 'sample' && changed.sample.cpu.state).toBe('warmup')
  })
  it('rejects a long-delayed frame without making receive time a new freshness origin', async () => {
    const s = await ready(), c = (await s.service.challenge(s.context, signal()))!, b = batch(c)
    s.advance(6001)
    await expect(s.service.ingest(s.context, JSON.stringify(b), signal())).rejects.toThrow('challenge')
    expect((await s.service.read(principal, telemetryOwnedFixture, signal())).kind).toBe('no-sample')
  })

})
