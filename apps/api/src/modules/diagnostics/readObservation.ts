import type { ReadObservation } from '@foreman-code/contracts'
import { HarnessExecutionError } from '../harnesses/errors.js'

/** Error codes identify the cause without exposing provider output, paths or credentials. */
export function failedReadObservation(previous: ReadObservation | undefined, error: unknown,
  message: string, now = Date.now()): ReadObservation {
  const code = error instanceof HarnessExecutionError ? error.result.error?.code
    : (error as { code?: unknown } | null)?.code
  let reason = 'READ_FAILED'
  if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(code)) reason = code
  else if (error instanceof Error && ['AbortError', 'TimeoutError', 'SyntaxError'].includes(error.name)) reason = error.name
  return { status: 'unavailable', lastError: `${message} (${reason}).`, failedAt: new Date(now).toISOString(),
    lastSuccess: previous?.lastSuccess ?? null, consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1 }
}

export function successfulReadObservation(now = Date.now()): ReadObservation {
  return { status: 'available', lastError: null, failedAt: null,
    lastSuccess: new Date(now).toISOString(), consecutiveFailures: 0 }
}
