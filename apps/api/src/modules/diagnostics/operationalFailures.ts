import type { LogComponent } from './logComponent.js'
import type { OperationalFailure } from '@foreman-code/contracts'

const failures = new Map<string, { record: OperationalFailure; lastWarnedAt: number }>()

function failureCode(error: unknown): string {
  const seen = new Set<unknown>()
  while (error && typeof error === 'object' && !seen.has(error) && seen.size < 8) {
    seen.add(error)
    const failure = error as { code?: unknown; name?: unknown; result?: { error?: { code?: unknown } }; cause?: unknown }
    const code = failure.code ?? failure.result?.error?.code
    if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(code)) return code
    if (typeof failure.name === 'string'
      && ['SyntaxError', 'ZodError', 'TimeoutError', 'AbortError', 'TypeError'].includes(failure.name)) return failure.name
    error = failure.cause
  }
  return 'OPERATION_FAILED'
}

/** Retain codes and fixed operation labels, never native output or credentials. */
export function recordOperationalFailure(component: LogComponent, operation: string, error: unknown,
  context: Record<string, unknown> = {}): boolean {
  const key = `${component}:${operation}`
  const previous = failures.get(key)
  const nowMs = Date.now()
  const now = new Date(nowMs).toISOString()
  const warn = !previous || nowMs < previous.lastWarnedAt || nowMs - previous.lastWarnedAt >= 30_000
  const lastError = failureCode(error)
  if (!previous && failures.size === 512) failures.delete(failures.keys().next().value!)
  failures.set(key, { lastWarnedAt: warn ? nowMs : (previous?.lastWarnedAt ?? nowMs),
    record: { component, operation, status: 'degraded', lastError,
    failureCount: (previous?.record.failureCount ?? 0) + 1,
    firstFailedAt: previous?.record.firstFailedAt ?? now, lastFailedAt: now,
    ...(typeof context.nextRetryMs === 'number' && Number.isFinite(context.nextRetryMs) && context.nextRetryMs >= 0
      ? { nextRetryAt: new Date(nowMs + context.nextRetryMs).toISOString() } : {}),
    ...(typeof context.attempt === 'number' && Number.isSafeInteger(context.attempt) && context.attempt >= 0
      ? { attempt: context.attempt } : {}),
    ...(typeof context.elapsedMs === 'number' && Number.isFinite(context.elapsedMs) && context.elapsedMs >= 0
      ? { elapsedMs: context.elapsedMs } : {}),
    ...(context.dataAgeMs === null ? { dataAgeMs: null } : {}),
    ...(typeof context.dataAgeMs === 'number' && Number.isFinite(context.dataAgeMs) && context.dataAgeMs >= 0
      ? { dataAgeMs: context.dataAgeMs } : {}),
    ...(context.pendingBytes === null ? { pendingBytes: null } : {}),
    ...(typeof context.pendingBytes === 'number' && Number.isSafeInteger(context.pendingBytes) && context.pendingBytes >= 0
      ? { pendingBytes: context.pendingBytes } : {}),
    ...(context.pendingSince === null ? { pendingSince: null } : {}),
    ...(typeof context.pendingSince === 'string' && Number.isFinite(Date.parse(context.pendingSince))
      ? { pendingSince: new Date(context.pendingSince).toISOString() } : {}) } })
  return warn
}

export function readOperationalFailures(): OperationalFailure[] {
  return [...failures.values()].map(entry => ({ ...entry.record }))
}

export function updateOperationalFailure(component: LogComponent, operation: string,
  details: Pick<OperationalFailure, 'elapsedMs' | 'selectedSource'>): void {
  const previous = failures.get(`${component}:${operation}`)
  if (previous) Object.assign(previous.record, details)
}
