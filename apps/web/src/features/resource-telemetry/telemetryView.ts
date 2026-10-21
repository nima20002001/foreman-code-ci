import type { TelemetryReason, TelemetrySample } from '@foreman-code/contracts/resource-telemetry'
import type { Tone } from '../../shared/ui/nocturne'

const MIB = 1024 ** 2
const GIB = 1024 ** 3

/** Binary units only; exact bytes stay available to callers for titles. */
export function formatBinaryBytes(bytes: number): string {
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(2)} GiB`
  const mib = bytes / MIB
  if (bytes === 0) return '0 MiB'
  return mib < 0.01 ? '<0.01 MiB' : `${mib < 10 ? mib.toFixed(2) : mib.toFixed(1)} MiB`
}

export function formatPercent(value: number): string { return `${value.toFixed(1)}%` }

export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms)
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)} s`
  const minutes = Math.floor(safe / 60_000)
  return `${minutes} min ${Math.floor((safe % 60_000) / 1000)} s`
}

export const reasonLabels: Record<TelemetryReason, string> = {
  'not-yet-sampled': 'Not sampled yet', unsupported: 'Unsupported on this computer', 'source-failure': 'Reading source failed',
  'counter-invalid': 'Counter invalid', 'permission-denied': 'Operating system denied the read', 'namespace-restricted': 'Namespace restricted',
  stale: 'Past server freshness window', offline: 'Computer worker offline', ended: 'Execution ended', closed: 'Execution closed',
  'ownership-unavailable': 'Ownership unavailable', 'shared-restricted': 'Shared processes restricted', limit: 'Server limit reached',
  evicted: 'Evicted from server cache', 'clock-discontinuity': 'Clock discontinuity', warmup: 'Warming up (needs two samples)',
  'process-tree-partial': 'Process tree partially observed', 'short-lived-unobserved': 'Short-lived processes not observed',
  'identity-changed': 'Process identity changed', 'escaped-boundary': 'Processes escaped the boundary',
  'nested-boundary': 'Nested boundary excluded', 'source-missing': 'Reading source missing', 'wall-clock-skew': 'Computer clocks disagree',
}

export const cpuSourceLabels = { 'host-active-ticks': 'Host active ticks', 'cgroup-usage-usec': 'cgroup CPU usage', 'process-utime-stime': 'Process user+system time' } as const
export const memorySourceLabels = { 'host-used-estimate': 'Host used estimate (total − available)', 'cgroup-current': 'cgroup current',
  'rss-sum': 'RSS sum (shared pages may be double counted)' } as const

export type MetricStatus = 'fresh' | 'warmup' | 'stale' | 'unavailable' | 'permission-denied' | 'deadline-passed'
export interface MetricView {
  label: 'CPU' | 'RAM'
  status: MetricStatus
  statusLabel: string
  tone: Tone
  /** Null whenever there is no current value; a real zero is the string "0.0%" / "0 MiB". */
  headline: string | null
  headlineNote: string | null
  source: string | null
  details: string[]
  reason: string | null
}

export interface SampleClock { nowMs: number; ageMs: number; freshRemainingMs: number }

/** Server instants advanced by conservative request transit plus monotonic elapsed since arrival. */
export function sampleClock(sample: TelemetrySample, elapsedMs: number): SampleClock {
  const elapsed = Math.max(0, elapsedMs)
  const nowMs = sample.serverNowUnixMs + elapsed
  return { nowMs, ageMs: sample.ageUpperBoundMs + elapsed, freshRemainingMs: sample.freshUntilUnixMs - nowMs }
}

type Metric = TelemetrySample['cpu'] | TelemetrySample['memory']

const statusText = { warmup: 'Warming up', stale: 'Stale', unavailable: 'Unavailable', 'permission-denied': 'OS permission denied' } as const
const statusTone: Record<'warmup' | 'stale' | 'unavailable' | 'permission-denied', Tone> = { warmup: 'info', stale: 'warning', unavailable: 'neutral', 'permission-denied': 'danger' }

function fresh(metric: Metric, sample: TelemetrySample, clock: SampleClock): boolean {
  return metric.state === 'fresh' && sample.presence === 'online' && clock.nowMs < metric.freshUntilUnixMs && clock.nowMs < sample.freshUntilUnixMs
}

function cpuValue(metric: Extract<TelemetrySample['cpu'], { state: 'fresh' }>): Pick<MetricView, 'headline' | 'headlineNote' | 'source' | 'details'> {
  const cpu = metric.value
  const window = Number(BigInt(cpu.elapsedNs) / 1_000_000n) / 1000
  return { headline: formatPercent(cpu.hostCapacityPercent), headlineNote: 'of whole computer capacity', source: cpuSourceLabels[cpu.basis],
    details: [`${cpu.logicalCpuCount} logical CPUs · ${window.toFixed(1)} s window`,
      ...(cpu.oneCorePercent === null ? [] : [`${formatPercent(cpu.oneCorePercent)} of one logical CPU`])] }
}

function memoryValue(metric: Extract<TelemetrySample['memory'], { state: 'fresh' }>): Pick<MetricView, 'headline' | 'headlineNote' | 'source' | 'details'> {
  const memory = metric.value
  const details: string[] = []
  if (memory.totalBytes !== null) details.push(`${Math.min(100, memory.bytes / (memory.totalBytes || 1) * 100).toFixed(1)}% of ${formatBinaryBytes(memory.totalBytes)} total`)
  if (memory.availableBytes !== null) details.push(`${formatBinaryBytes(memory.availableBytes)} available`)
  if (memory.sharedPagesMayDoubleCount) details.push('Shared pages may be double counted')
  return { headline: formatBinaryBytes(memory.bytes), headlineNote: null, source: memorySourceLabels[memory.kind], details }
}
/** Format an actually retained value without changing its timestamps or claiming it is current. */
export function capturedMetricView(label: 'CPU' | 'RAM', sample: TelemetrySample) {
  return label === 'CPU' ? sample.cpu.state === 'fresh' ? cpuValue(sample.cpu) : null
    : sample.memory.state === 'fresh' ? memoryValue(sample.memory) : null
}

export function metricView(label: 'CPU' | 'RAM', sample: TelemetrySample, elapsedMs: number): MetricView {
  const metric: Metric = label === 'CPU' ? sample.cpu : sample.memory
  const clock = sampleClock(sample, elapsedMs)
  if (metric.state === 'fresh') {
    const value = label === 'CPU' ? cpuValue(sample.cpu as Extract<TelemetrySample['cpu'], { state: 'fresh' }>) : memoryValue(sample.memory as Extract<TelemetrySample['memory'], { state: 'fresh' }>)
    const sampled = `Sampled ${new Date(metric.sampledAtUnixMs).toISOString()}`
    if (fresh(metric, sample, clock)) return { label, status: 'fresh', statusLabel: 'Fresh', tone: 'success', ...value, details: [...value.details, sampled], reason: null }
    // The server deadline passed (or presence changed) since this response: never keep showing it as current.
    return { label, status: 'deadline-passed', statusLabel: 'Freshness deadline passed', tone: 'warning', headline: null, headlineNote: null,
      source: value.source, details: ['Waiting for a newer server reading'], reason: null }
  }
  return { label, status: metric.state, statusLabel: statusText[metric.state], tone: statusTone[metric.state], headline: null, headlineNote: null, source: null,
    details: metric.sampledAtUnixMs === null ? [] : [`Last attempted ${new Date(metric.sampledAtUnixMs).toISOString()}`], reason: reasonLabels[metric.reason] }
}

export interface CoverageView { shared: boolean; partial: boolean; reasons: string[] }
export function coverageView(sample: TelemetrySample): CoverageView {
  return { shared: sample.coverage.shared, partial: sample.coverage.boundary === 'partial', reasons: sample.coverage.reasons.map(reason => reasonLabels[reason]) }
}

/** Whether any metric of this sample may be presented as the current reading. */
export function isCurrent(sample: TelemetrySample, elapsedMs: number): boolean {
  const clock = sampleClock(sample, elapsedMs)
  return fresh(sample.cpu, sample, clock) || fresh(sample.memory, sample, clock)
}

export function shortId(value: string): string { return value.length > 12 ? `${value.slice(0, 8)}…` : value }
