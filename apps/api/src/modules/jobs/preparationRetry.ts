import { setTimeout as delay } from 'node:timers/promises'
import { isTransientExecutionError } from '../runs/executionRetryPolicy.js'

export class JobPreparationRetryError extends Error {
  constructor(override readonly cause: unknown) {
    super('Job preparation is waiting for infrastructure recovery.', { cause })
  }
}

/** Retry only preparation ports; validation and native entry keep their own failure semantics. */
export async function retryJobPreparation<T>(signal: AbortSignal, prepare: () => Promise<T> | T): Promise<T> {
  for (;;) {
    signal.throwIfAborted()
    try {
      return await prepare()
    } catch (error) {
      if (!isTransientExecutionError(error)) throw error
      if (signal.aborted) throw new JobPreparationRetryError(error)
      try {
        await delay(100, undefined, { signal })
      } catch {
        throw new JobPreparationRetryError(error)
      }
    }
  }
}
