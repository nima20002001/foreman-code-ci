import type { ServiceHealth } from '@foreman-code/contracts/computer-maintenance'

/** cadenceMs: how often the loop runs (omit for event-driven work). deadlineMs: the longest one pass may take. */
export interface ServiceSchedule { cadenceMs?: number; deadlineMs: number }

interface Entry extends ServiceSchedule {
  lastStartedAt: number | null
  lastSuccessAt: number | null
  lastFailureAt: number | null
  lastError: string | null
  nextDueAt: number | null
  inFlight: number
  inFlightSince: number | null
}

/** A loop that misses its due time by this much more than its cadence is stalled. */
const MISSED_CADENCE_GRACE_MS = 60_000
const services = new Map<string, Entry>()

function describe(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? `${error.code}: ` : ''
  const message = error instanceof Error ? error.message : String(error)
  return `${code}${message}`.replace(/\s+/gu, ' ').slice(0, 500)
}

function entry(name: string, schedule: ServiceSchedule, now: number): Entry {
  let current = services.get(name)
  if (!current) {
    current = { ...schedule, lastStartedAt: null, lastSuccessAt: null, lastFailureAt: null, lastError: null,
      nextDueAt: schedule.cadenceMs === undefined ? null : now + schedule.cadenceMs, inFlight: 0, inFlightSince: null }
    services.set(name, current)
  }
  Object.assign(current, schedule)
  return current
}

/** Registers a loop before its first pass so a loop that never starts is reported as stalled. */
export function registerService(name: string, schedule: ServiceSchedule, now = Date.now()): void {
  entry(name, schedule, now)
}

/** Records one pass of a background loop. Concurrent passes share one in-flight interval. */
export async function trackService<T>(name: string, schedule: ServiceSchedule, work: () => Promise<T>,
  clock: () => number = Date.now): Promise<T> {
  const current = entry(name, schedule, clock())
  const started = clock()
  current.lastStartedAt = started
  if (current.inFlight++ === 0) current.inFlightSince = started
  try {
    const result = await work()
    current.lastSuccessAt = clock()
    return result
  } catch (error) {
    current.lastFailureAt = clock()
    current.lastError = describe(error)
    throw error
  } finally {
    if (--current.inFlight === 0) current.inFlightSince = null
    current.nextDueAt = current.cadenceMs === undefined ? null : clock() + current.cadenceMs
  }
}

/** Records a failure observed outside a tracked pass, such as a pass that reported partial errors. */
export function reportServiceFailure(name: string, error: unknown, now = Date.now()): void {
  const current = services.get(name)
  if (!current) return
  current.lastFailureAt = now
  current.lastError = describe(error)
}

/** Replaces the state of a unit that runs outside this process and is observed through its own record. */
export function reportService(name: string, schedule: ServiceSchedule, state: {
  lastStartedAt: number | null; lastSuccessAt: number | null; lastFailureAt: number | null; lastError: string | null
  nextDueAt: number | null; inFlightSince: number | null
}, now = Date.now()): void {
  Object.assign(entry(name, schedule, now), state, { inFlight: state.inFlightSince === null ? 0 : 1,
    lastError: state.lastError?.slice(0, 500) ?? null })
}

const iso = (value: number | null) => value === null ? null : new Date(value).toISOString()

export function readServiceHealth(now = Date.now()): ServiceHealth[] {
  return [...services].sort(([left], [right]) => left.localeCompare(right)).slice(0, 50).map(([name, value]) => {
    const overdue = value.inFlightSince !== null && now - value.inFlightSince > value.deadlineMs
    const missed = value.inFlightSince === null && value.nextDueAt !== null
      && now > value.nextDueAt + Math.max(MISSED_CADENCE_GRACE_MS, value.cadenceMs ?? 0)
    let status: ServiceHealth['status'] = value.cadenceMs === undefined && value.inFlightSince === null ? 'idle' : 'ok'
    if (value.lastFailureAt !== null && value.lastFailureAt >= (value.lastSuccessAt ?? 0)) status = 'failing'
    if (overdue || missed) status = 'stalled'
    return { name, status, lastStartedAt: iso(value.lastStartedAt), lastSuccessAt: iso(value.lastSuccessAt),
      lastError: overdue ? (`In flight for ${Math.round((now - value.inFlightSince!) / 1000)} s, over its `
        + `${Math.round(value.deadlineMs / 1000)} s deadline.${value.lastError ? ` Last error: ${value.lastError}` : ''}`).slice(0, 500)
        : value.lastError,
      nextDueAt: iso(value.nextDueAt), inFlightSince: iso(value.inFlightSince) }
  })
}
