import { setTimeout as delay } from 'node:timers/promises'
import { componentLogger } from '../modules/diagnostics/logger.js'

import { isDatabaseTimeout } from '@foreman-code/contracts/failure'
export { isDatabaseTimeout }

export interface DatabaseRetryOptions {
  signal?: AbortSignal | undefined
  check?(): void
  timeoutMs?: number
}

/** Retry only replay-safe bookkeeping. Native submissions are never passed here. */
export function retryDatabaseTimeout<T>(work: () => Promise<T>, options: DatabaseRetryOptions = {}): Promise<T> {
  return retryDatabaseOperation(work, isDatabaseTimeout, options)
}

export async function retryDatabaseOperation<T>(
  work: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: DatabaseRetryOptions = {},
): Promise<T> {
  let waitMs = 100
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Database retry timeout must be positive.')
  let attempt = 0
  for (;;) {
    options.signal?.throwIfAborted()
    options.check?.()
    try {
      const result = await work()
      options.signal?.throwIfAborted()
      options.check?.()
      return result
    } catch (error) {
      options.signal?.throwIfAborted()
      options.check?.()
      if (!isRetryable(error)) throw error
      attempt += 1
      const elapsedMs = Date.now() - startedAt
      componentLogger('engine').warn({ operation: 'retry database operation', err: error, attempt, elapsedMs,
        nextRetryMs: Math.min(waitMs, Math.max(0, timeoutMs - elapsedMs)) },
      'Database operation is temporarily unavailable; retrying.')
      if (elapsedMs >= timeoutMs) {
        throw Object.assign(new Error('Database operation retry deadline exceeded.', { cause: error }),
          { code: 'DATABASE_RETRY_DEADLINE_EXCEEDED', attempts: attempt, elapsedMs })
      }
      await delay(Math.min(waitMs, timeoutMs - elapsedMs), undefined, { signal: options.signal })
      waitMs = Math.min(1_000, waitMs * 2)
    }
  }
}
