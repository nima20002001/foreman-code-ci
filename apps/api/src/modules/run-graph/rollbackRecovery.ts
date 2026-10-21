import type pg from 'pg'
import { retryDatabaseTimeout } from '../../infrastructure/databaseTimeout.js'
import { rollbackTransaction } from '../../infrastructure/transaction.js'
import { timeRuntimeOperation } from '../../infrastructure/runtimeTiming.js'

/** A stalled PostgreSQL query can keep every later rollback queued behind it. */
export async function recoverGraphRollback(client: pg.ClientBase, closing: AbortSignal): Promise<void> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('Graph rollback recovery timed out.')), 5_000)
  timer.unref()
  const signal = AbortSignal.any([closing, deadline.signal])
  let onAbort: (() => void) | undefined
  try {
    signal.throwIfAborted()
    const canceled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    await Promise.race([
      retryDatabaseTimeout(() => timeRuntimeOperation('db', 'sql.rollback', () => rollbackTransaction(client)), { signal }),
      canceled,
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
