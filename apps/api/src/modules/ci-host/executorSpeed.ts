import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import type { CiDurations, CiRunRecord } from '@foreman-code/contracts'
import type { HostCiComputer, HostCiEndpoint, HostRef } from './serviceTypes.js'

const SAMPLES = 10
const MIN_FACTOR = 0.5
const MAX_FACTOR = 3
/** A cached estimate is reused this long even when no ticket reports finishing (collected durations land late). */
const CACHE_MS = 30_000

/** The only run fields speed estimation reads. */
export type ExecutorSpeedRun = Pick<CiRunRecord, 'id' | 'gate' | 'suite' | 'state' | 'computer' | 'startedAt'
  | 'finishedAt' | 'files' | 'plannedHostKey' | 'expectedDurationMs' | 'speedFactor'>

export interface ExecutorThroughput {
  factor: number
  throughput: number
  conservativeThroughput: number
}
/** Cloud slots of one provider share measurements; build computers have individual measurements. */
export type ExecutorSpeeds = ReadonlyMap<string, number | ExecutorThroughput>

function refSpeedKey(hostRef: HostRef, computers: readonly HostCiComputer[]): string | undefined {
  if (hostRef.kind === 'cloud') return `cloud:${hostRef.provider}`
  return computers.find(computer => isDeepStrictEqual(computer.hostRef, hostRef))?.key
}

export function executorSpeedKey(computer: HostCiComputer): string {
  return computer.hostRef.kind === 'cloud' ? `cloud:${computer.hostRef.provider}` : computer.key
}

/** Recent passed parts, newest first, measure file work per wall time. Cloud slowdown estimates undo the
 * previously applied factor and exclude parts planned for a different executor. */
export function estimateExecutorSpeeds(runs: readonly ExecutorSpeedRun[],
  computers: readonly HostCiComputer[], durations: ReadonlyMap<string, CiDurations> = new Map())
  : Map<string, number | ExecutorThroughput> {
  const samples = new Map<string, number[]>()
  const throughput = new Map<string, number[]>()
  for (const run of runs) {
    if (!run.gate || run.suite !== 'integration' || run.state !== 'passed' || !run.computer
      || !run.startedAt || !run.finishedAt) continue
    const key = refSpeedKey(run.computer.hostRef, computers)
    if (!key) continue
    const actual = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
    if (!Number.isFinite(actual) || actual <= 0) continue
    const measured = durations.get(run.id)
    const work = run.files.reduce((sum, file) => sum + (measured?.[file] ?? 0), 0)
    if (run.files.length && run.files.every(file => (measured?.[file] ?? 0) > 0) && work > 0) {
      const list = throughput.get(key) ?? []
      if (list.length < SAMPLES) list.push(work / actual)
      throughput.set(key, list)
    }
    const planned = computers.find(computer => computer.key === run.plannedHostKey)
    if (!planned || executorSpeedKey(planned) !== key || !run.expectedDurationMs) continue
    const list = samples.get(key) ?? []
    if (list.length >= SAMPLES) continue
    list.push(actual * (run.speedFactor ?? 1) / run.expectedDurationMs)
    samples.set(key, list)
  }
  const result = new Map<string, number | ExecutorThroughput>([...samples].map(([key, ratios]) =>
    [key, Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, median(ratios)))]))
  for (const [key, values] of throughput) {
    const typical = median(values)
    const factor = result.get(key)
    result.set(key, { factor: typeof factor === 'number' ? factor : 1, throughput: typical,
      conservativeThroughput: Math.min(typical, values[0]!) })
  }
  return result
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

interface SpeedRow {
  record: ExecutorSpeedRun
  test_results?: { files?: { file: string; durationMs?: number | null }[] } | null
  durations?: CiDurations | null
}
interface SpeedCache { at: number; pending?: Promise<Map<string, number | ExecutorThroughput>> | undefined
  speeds?: Map<string, number | ExecutorThroughput> }
/** One estimate per planner (its endpoint): a service shares it across passes, never with another service. */
const caches = new WeakMap<HostCiEndpoint, SpeedCache>()

/** Forget the planner's cached estimate; a finished gate integration part changes the measurements. */
export function invalidateExecutorSpeeds(endpoint: HostCiEndpoint) {
  caches.delete(endpoint)
}

/** Reads recent passed gate integration parts and estimates each current executor's speed. Concurrent callers
 * share one read and later ones reuse it until a gate part finishes. */
export async function readExecutorSpeeds(pool: pg.Pool, endpoint: HostCiEndpoint)
  : Promise<Map<string, number | ExecutorThroughput>> {
  const cached = caches.get(endpoint)
  if (cached?.pending) return cached.pending
  if (cached?.speeds && Date.now() - cached.at < CACHE_MS) return cached.speeds
  const entry: SpeedCache = { at: Date.now() }
  caches.set(endpoint, entry)
  entry.pending = loadExecutorSpeeds(pool, endpoint).then(speeds => {
    entry.speeds = speeds
    entry.at = Date.now()
    return speeds
  }).catch(error => {
    if (caches.get(endpoint) === entry) caches.delete(endpoint)
    throw error
  }).finally(() => { entry.pending = undefined })
  return entry.pending
}

async function loadExecutorSpeeds(pool: pg.Pool, endpoint: HostCiEndpoint)
  : Promise<Map<string, number | ExecutorThroughput>> {
  // Only file names and durations of the reports are needed, so the database projects them.
  const rows = (await pool.query<SpeedRow>(
    `select jsonb_build_object('id',record->'id','gate',record->'gate','suite',record->'suite',
        'state',record->'state','computer',record->'computer','startedAt',record->'startedAt',
        'finishedAt',record->'finishedAt','files',record->'files','plannedHostKey',record->'plannedHostKey',
        'expectedDurationMs',record->'expectedDurationMs','speedFactor',record->'speedFactor') as record,
      case when test_results is null then null else jsonb_build_object('files',
        (select coalesce(jsonb_agg(jsonb_build_object('file',file->'file','durationMs',file->'durationMs')),'[]'::jsonb)
          from jsonb_array_elements(test_results->'files') as file)) end as test_results,
      durations from ci_runs
    where state='passed' and record->>'suite'='integration' and record->>'gate'='true'
      and record->>'finishedAt' is not null order by created_at desc limit 300`)).rows
  const durations = new Map<string, CiDurations>()
  for (const row of rows) {
    const measured = row.test_results?.files
      ? Object.fromEntries(row.test_results.files.map(file => [file.file, file.durationMs ?? 0])) : null
    if (measured && row.record.files.length && row.record.files.every(file => (measured[file] ?? 0) > 0)) {
      durations.set(row.record.id, measured)
    } else if (row.durations) {
      durations.set(row.record.id, row.durations)
    }
  }
  return estimateExecutorSpeeds(rows.map(row => row.record), await endpoint.computers(), durations)
}
