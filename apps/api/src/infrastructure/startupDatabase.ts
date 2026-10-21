import { isTransientDatabaseOrSocketError } from '@foreman-code/contracts/failure'
import { isDatabasePoolTimeout } from './databaseReadRetry.js'
import { isDatabaseTimeout, retryDatabaseOperation, type DatabaseRetryOptions } from './databaseTimeout.js'

const transientConnectionCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  '08000', '08001', '08003', '08006',
  '57P01', '57P02', '57P03', '53300',
])

function isTransientStartupDatabaseError(error: unknown): boolean {
  if (isDatabaseTimeout(error)) return true
  const seen = new Set<object>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    const code = 'code' in error ? error.code : undefined
    if (code !== undefined && code !== 'GRAPH_TRANSACTION_FAILED') {
      return typeof code === 'string' && transientConnectionCodes.has(code)
    }
    if (isDatabasePoolTimeout(error)) return true
    if (error instanceof Error && error.message === 'Connection terminated unexpectedly') return true
    error = 'cause' in error ? error.cause : undefined
  }
  return false
}

/** Each operation must be replay-safe; initialization also registers routes and cannot be retried as a whole. */
export function retryStartupDatabase<T>(
  work: () => Promise<T>,
  options: DatabaseRetryOptions = {},
): Promise<T> {
  return retryDatabaseOperation(work, isTransientStartupDatabaseError, options)
}

/** First pass of a background loop that also runs on a timer: a transient database or socket failure is reported and
 * left to the next tick; anything else still fails startup. */
export async function runBackgroundPassAtStartup(pass: () => Promise<void>, report: (error: unknown) => void): Promise<void> {
  try { await pass() } catch (error) {
    if (!isTransientDatabaseOrSocketError(error)) throw error
    report(error)
  }
}
