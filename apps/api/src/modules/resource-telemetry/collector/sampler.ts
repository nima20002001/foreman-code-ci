import { createHash } from 'node:crypto'
import { TELEMETRY_LIMITS, telemetryCanonical, type TelemetryCollectedRow, type TelemetryIdentity, type TelemetryStorage } from '@foreman-code/contracts/resource-telemetry'
import { cpuWindow, type CpuBaseline } from './cpu.js'
import { disjointAccounting } from './linuxCgroup.js'
import { counter as parseCounter, parseHostCpu, parseHostMemory, parseOnlineCpus, safeBytes, sourceFailure, type HostConstants } from './linuxProcfs.js'
import type { OwnershipReader } from './ownership.js'
import { collectProcessSet, type ProcessIdentity, type ProcessReader } from './processSet.js'

type Reason = TelemetryCollectedRow['coverage']['reasons'][number]
function reason(error: unknown): Reason {
  const value = error instanceof Error && error.message === 'permission-denied' ? 'permission-denied' : sourceFailure(error)
  return value === 'limit-exceeded' ? 'limit' : value === 'invalid-counter' ? 'counter-invalid' : value
}
function failed(error: unknown): { state: 'permission-denied' | 'unavailable'; reason: Reason } {
  const code = reason(error); return { state: code === 'permission-denied' ? code : 'unavailable', reason: code }
}
export interface SamplerPorts {
  read(path: string, signal: AbortSignal, maxBytes?: number): Promise<string>
  process: ProcessReader
  ownership: OwnershipReader
  constants: HostConstants
  /** Trusted runtime qualification; container namespace cannot claim the whole host. */
  wholeHostVisible: boolean
  /** Free space on the computer's home filesystem; omitted where the host cannot report it. */
  storage?(signal: AbortSignal): Promise<TelemetryStorage>
  now(): bigint
}
interface ScopeBaseline { cpu?: CpuBaseline; processes?: Map<string, bigint>; retained: ProcessIdentity[] }
export class LinuxSampler {
  private sources = new Map<string, string>()
  private baselines = new Map<string, ScopeBaseline>()
  private storage: { generation: string; at: bigint; value: TelemetryStorage } | undefined
  constructor(private readonly ports: SamplerPorts) {}
  reset(): void { this.baselines.clear(); this.sources.clear(); this.storage = undefined }
  private async captureStorage(identity: TelemetryIdentity, signal: AbortSignal): Promise<TelemetryStorage | null> {
    if (!this.ports.storage) return null
    const generation = telemetryCanonical(identity)
    const now = this.ports.now()
    const cached = this.storage
    signal.throwIfAborted()
    if (cached?.generation === generation && now >= cached.at && now - cached.at < 10_000_000_000n) {
      return cached.value
    }
    this.storage = undefined
    const value = await this.ports.storage(signal)
    signal.throwIfAborted()
    this.storage = { generation, at: now, value }
    return value
  }
  async capture(identity: TelemetryIdentity, signal: AbortSignal): Promise<{ host: TelemetryCollectedRow | null; owned: TelemetryCollectedRow[]; logicalCpuCount: number; truncated: boolean; diagnostics: Reason[] }> {
    const p = this.ports
    const deadlineNs = p.now() + 250_000_000n
    const sources = await Promise.allSettled([p.read('/proc/sys/kernel/random/boot_id', signal, 128), p.read('/sys/devices/system/cpu/online', signal, 32768)])
    const failure = sources.find(source => source.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
    const boot = (sources[0] as PromiseFulfilledResult<string>).value
    const online = (sources[1] as PromiseFulfilledResult<string>).value
    if (boot.trim() !== identity.host.bootId) { this.reset(); throw new Error('identity-changed') }
    const coreSet = parseOnlineCpus(online); const logicalCpuCount = coreSet.split(',').length
    if (logicalCpuCount > 4096) throw new Error('limit-exceeded')
    const generation = `${telemetryCanonical(identity)}:${coreSet}`
    const cpuCapture = (key: string, counter: bigint, total: bigint | null, basis: 'host-active-ticks' | 'cgroup-usage-usec' | 'process-utime-stime', monoNs: bigint, processCounters?: Map<string, bigint>): TelemetryCollectedRow['cpu'] => {
      const baseline = this.baselines.get(key) ?? { retained: [] }
      try { parseCounter(counter.toString()); if (total !== null) parseCounter(total.toString()) } catch { delete baseline.cpu; return { state: 'unavailable', reason: 'counter-invalid' } }
      let processDelta = 0n
      if (processCounters && baseline.processes) {
        for (const [pid, value] of processCounters) { const previous = baseline.processes.get(pid); if (previous !== undefined && value >= previous) processDelta += value - previous }
        counter = (baseline.cpu?.counter ?? 0n) + processDelta
      }
      const current = { generation: `${generation}:${key}:${basis}`, monoNs, counter, total }
      const window = cpuWindow(baseline.cpu, current)
      let intervalDeltaNs: string | null = null
      if (processCounters && baseline.processes && window) {
        intervalDeltaNs = processDelta.toString()
      }
      const previousMono = baseline.cpu?.monoNs
      baseline.cpu = current
      if (processCounters) baseline.processes = processCounters
      this.baselines.set(key, baseline)
      if (!window || previousMono === undefined) return { state: 'warmup', reason: 'warmup' }
      return { state: 'ok', basis, windowStartMonoNs: previousMono.toString(), windowEndMonoNs: monoNs.toString(),
        previousCounter: window.previous, currentCounter: window.current, previousTotal: window.previousTotal,
        currentTotal: window.currentTotal, intervalDeltaNs, baselineRef: createHash('sha256').update(current.generation + ':' + (this.sources.get(key) ?? 'process-set')).digest('hex') }
    }
    let host: TelemetryCollectedRow
    if (p.wholeHostVisible) {
      const [cpu, memory, storage] = await Promise.allSettled([p.read('/proc/stat', signal).then(text => ({ ...parseHostCpu(text), monoNs: p.now() })), p.read('/proc/meminfo', signal).then(parseHostMemory),
        this.captureStorage(identity, signal)])
      host = { selector: { schemaVersion: 1, scope: 'computer', ...identity }, coverage: { boundary: 'complete-boundary', shared: false, reasons: [] },
        cpu: cpu.status === 'fulfilled' ? cpuCapture('computer', cpu.value.active, cpu.value.total, 'host-active-ticks', cpu.value.monoNs) : failed(cpu.reason),
        memory: memory.status === 'fulfilled' ? { state: 'ok', value: { kind: 'host-used-estimate', ...memory.value, sharedPagesMayDoubleCount: false } } : failed(memory.reason),
        storage: storage.status === 'fulfilled' ? storage.value : null }
      if (cpu.status === 'rejected') this.baselines.delete('computer')
    } else {
      this.baselines.delete('computer')
      host = { selector: { schemaVersion: 1, scope: 'computer', ...identity },
        coverage: { boundary: 'partial', shared: false, reasons: ['namespace-restricted'] },
        cpu: { state: 'unavailable', reason: 'namespace-restricted' }, memory: { state: 'unavailable', reason: 'namespace-restricted' } }
    }
    let snapshot
    try { snapshot = await p.ownership.snapshot(signal) } catch (error) {
      signal.throwIfAborted()
      if ((await p.read('/proc/sys/kernel/random/boot_id', signal, 128)).trim() !== identity.host.bootId) { this.reset(); throw new Error('identity-changed', { cause: error }) }
      for (const key of this.baselines.keys()) if (key !== 'computer') this.baselines.delete(key)
      this.sources.clear()
      return { host, owned: [], logicalCpuCount, truncated: reason(error) === 'limit',
        diagnostics: [...new Set<Reason>([reason(error), 'ownership-unavailable', ...(p.wholeHostVisible ? [] : ['namespace-restricted' as const])])] }
    }
    const ownedLimit = TELEMETRY_LIMITS.rows - 1
    const views = snapshot.views.slice(0, ownedLimit)
    const alive = new Set(['computer']); const owned: TelemetryCollectedRow[] = []
    const budget = { remaining: 4096 }
    const capturedMemberships: Array<{ row: TelemetryCollectedRow; identities: Set<string> }> = []
    for (const view of views) {
      signal.throwIfAborted()
      const key = createHash('sha256').update(telemetryCanonical(view.selector) + ':' + view.leaseId + ':' + telemetryCanonical({ launches: [...view.launchIds].sort(), roots: view.roots.map(root => `${root.bootId}:${root.pid}:${root.startTicks}`).sort() })).digest('hex')
      alive.add(key)
      const selector = view.selector
      if (selector.mainId !== identity.mainId || telemetryCanonical(selector.host) !== telemetryCanonical(identity.host)
        || view.observedDeviceId !== identity.host.deviceId || view.observedInstallationId !== identity.host.applicationInstallationId) continue
      const coverage: TelemetryCollectedRow['coverage'] = { boundary: 'partial', shared: view.shared, reasons: [] }
      if (view.lifecycle === 'closed' || view.lifecycle === 'ended') {
        this.baselines.delete(key)
        const reason = view.lifecycle
        owned.push({ selector, coverage, cpu: { state: 'unavailable', reason }, memory: { state: 'unavailable', reason } }); continue
      }
      if (p.now() > deadlineNs) {
        this.baselines.delete(key)
        owned.push({ selector, coverage: { ...coverage, reasons: ['limit'] }, cpu: { state: 'unavailable', reason: 'limit' }, memory: { state: 'unavailable', reason: 'limit' } }); continue
      }
      if (!view.launchIds.length) {
        this.baselines.delete(key)
        owned.push({ selector, coverage, cpu: { state: 'unavailable', reason: 'ownership-unavailable' }, memory: { state: 'unavailable', reason: 'ownership-unavailable' } }); continue
      }
      let captured: ProcessIdentity[] = []
      let cpu: TelemetryCollectedRow['cpu']; let memory: TelemetryCollectedRow['memory']
      const accounting = disjointAccounting(view.accountingHandles)
      coverage.shared ||= accounting.shared || views.some(other => other !== view && other.accountingHandles.some(a => accounting.handles.some(b => a.boundary.device === b.boundary.device && (a.boundary.inode === b.boundary.inode || a.boundary.path.startsWith(b.boundary.path + '/') || b.boundary.path.startsWith(a.boundary.path + '/')))))
      coverage.shared ||= views.some(other => other !== view && other.roots.some(a => view.roots.some(b => a.bootId === b.bootId && a.pid === b.pid && a.startTicks === b.startTicks)))
      if (accounting.handles.length) {
        const results = await Promise.allSettled(accounting.handles.slice(0, 8).map(handle => handle.read(signal)))
        const values = results.filter(r => r.status === 'fulfilled').map(r => r.value)
        const limited = accounting.handles.length > 8
        const cpuValid = values.filter(v => v.cpu !== null); const memoryValid = values.filter(v => v.memory !== null)
        coverage.boundary = !limited && values.length === results.length && cpuValid.length === values.length && memoryValid.length === values.length ? 'complete-boundary' : 'partial'
        if (coverage.boundary === 'partial') {
          const failures = [...values.flatMap(value => [value.cpuFailure, value.memoryFailure].filter((value): value is string => value !== null)).map(value => reason(new Error(value))), ...results.filter(value => value.status === 'rejected').map(value => reason(value.reason))]
          coverage.reasons = [...new Set(limited ? ['limit' as const, ...failures] : failures.length ? failures : ['source-failure' as const])].slice(0, 16)
        }
        const sourceKey = accounting.handles.map(h => `${h.boundary.device}:${h.boundary.inode}`).join(',')
        const oldSource = this.sources.get(key)
        if (oldSource !== sourceKey || cpuValid.length !== results.length) this.baselines.delete(key)
        this.sources.set(key, sourceKey)
        cpu = cpuValid.length ? cpuCapture(key, cpuValid.reduce((sum, value) => sum + value.cpu!, 0n), null, 'cgroup-usage-usec', p.now()) : failed(new Error(values[0]?.cpuFailure ?? 'source-missing'))
        try { memory = memoryValid.length ? { state: 'ok', value: { kind: 'cgroup-current', bytes: safeBytes(memoryValid.reduce((sum, value) => sum + BigInt(value.memory!), 0n)), totalBytes: null, availableBytes: null, sharedPagesMayDoubleCount: false } } : failed(new Error(values[0]?.memoryFailure ?? 'source-missing')) } catch (error) { memory = failed(error); coverage.boundary = 'partial'; coverage.reasons.push('counter-invalid') }
      } else {
        const baseline = this.baselines.get(key) ?? { retained: [] }
        const result = await collectProcessSet({ roots: view.roots, retained: baseline.retained, bootId: identity.host.bootId,
          reader: p.process, constants: p.constants, signal, budget, now: p.now, deadlineNs })
        captured = result.identities
        baseline.retained = result.identities; this.baselines.set(key, baseline)
        coverage.reasons = [...new Set(result.limitations.map(value => value === 'limit-exceeded' ? 'limit' : value === 'invalid-counter' ? 'counter-invalid' : value as Reason))].slice(0, 16)
        const failure = result.limitations.includes('permission-denied') ? { state: 'permission-denied' as const, reason: 'permission-denied' as const } : { state: 'unavailable' as const, reason: result.limitations.includes('invalid-counter') ? 'counter-invalid' as const : result.limitations.includes('source-missing') ? 'source-missing' as const : 'source-failure' as const }
        cpu = result.cpuNs === null ? failure : cpuCapture(key, result.cpuNs, null, 'process-utime-stime', p.now(), result.counters)
        memory = result.rssBytes === null ? failure : { state: 'ok', value: { kind: 'rss-sum', bytes: result.rssBytes, totalBytes: null, availableBytes: null, sharedPagesMayDoubleCount: true } }
      }
      if (cpu.state !== 'ok' && cpu.state !== 'warmup') { const baseline = this.baselines.get(key); if (baseline) delete baseline.cpu }
      if (view.accountingIncomplete) { coverage.boundary = 'partial'; if (!coverage.reasons.includes('escaped-boundary')) coverage.reasons.push('escaped-boundary') }
      if (view.captureTruncated) { coverage.boundary = 'partial'; if (!coverage.reasons.includes('limit')) coverage.reasons.push('limit') }
      const row = { selector, coverage, cpu, memory }; owned.push(row)
      capturedMemberships.push({ row, identities: new Set(captured.map(value => `${value.bootId}:${value.pid}:${value.startTicks}`)) })
    }
    for (let i = 0; i < capturedMemberships.length; i++) for (let j = i + 1; j < capturedMemberships.length; j++) {
      const a = capturedMemberships[i]!; const b = capturedMemberships[j]!
      if ([...a.identities].some(value => b.identities.has(value))) { a.row.coverage.shared = true; b.row.coverage.shared = true }
    }
    for (const key of this.baselines.keys()) if (!alive.has(key)) this.baselines.delete(key)
    for (const key of this.sources.keys()) if (!alive.has(key)) this.sources.delete(key)
    const bootAfter = await p.read('/proc/sys/kernel/random/boot_id', signal, 128)
    if (bootAfter.trim() !== identity.host.bootId) { this.reset(); throw new Error('identity-changed') }
    return { host, owned, logicalCpuCount, truncated: snapshot.views.length > ownedLimit || budget.remaining <= 0 || owned.some(row => row.coverage.reasons.includes('limit')),
      diagnostics: p.wholeHostVisible ? [] : ['namespace-restricted'] }
  }
}
