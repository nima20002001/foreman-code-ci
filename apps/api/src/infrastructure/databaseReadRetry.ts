import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'

const reads = new AsyncLocalStorage<{ retried: boolean; signal?: AbortSignal | undefined }>()

import { isDatabasePoolTimeout } from '@foreman-code/contracts/failure'
export { isDatabasePoolTimeout }

/** One acquisition retry per read, including tools whose handlers format their own errors. */
export function withDatabaseReadRetry<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return reads.run({ retried: false, signal }, work)
}

export async function acquireDatabaseConnection<T>(acquire: () => Promise<T>): Promise<T> {
  const read = reads.getStore()
  read?.signal?.throwIfAborted()
  try {
    return await acquire()
  } catch (error) {
    if (!read || read.retried || !isDatabasePoolTimeout(error)) throw error
    read.signal?.throwIfAborted()
    read.retried = true
    await delay(50, undefined, { signal: read.signal })
    return acquire()
  }
}
