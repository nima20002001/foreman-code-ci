import { isObject } from './codexStdioTransport.js'

export const CODEX_CAPACITY_ATTEMPTS = 5

export function codexCapacityDelay(attempt: number): number {
  return 20_000 * 2 ** (attempt - 1)
}

export function waitForCodexCapacity(milliseconds: number, signal: AbortSignal,
  timers: { schedule: typeof setTimeout; cancelTimer: typeof clearTimeout }): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener('abort', abort)
      resolve()
    }
    const abort = () => {
      timers.cancelTimer(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    const timer = timers.schedule(finish, milliseconds)
    signal.addEventListener('abort', abort, { once: true })
  })
}

export function isCodexCapacityError(error: unknown): boolean {
  if (!isObject(error)) return false
  const info = error.codexErrorInfo
  if (info === 'rateLimitExceeded' || info === 'serverOverloaded') return true
  if (isObject(info)) {
    return Object.values(info).some(value => isObject(value)
      && typeof value.httpStatusCode === 'number'
      && [429, 500, 502, 503, 504].includes(value.httpStatusCode))
  }
  // Older providers can omit the structured reason for model-capacity failures.
  if (info !== undefined && info !== null && info !== 'other') return false
  return typeof error.message === 'string'
    && /selected model is at capacity|server (?:is )?overloaded|rate limit(?:ed| exceeded)/i.test(error.message)
}
