import { DomainError } from '../errors.js'
import { SOURCE_LIMITS } from '../sources/manifest.js'

export const START_PREPARATION_TIMEOUT_MS = 5_000

/** Cancellation fences admission even if source preparation finishes after its deadline. */
export async function prepareRunStart<T>(operation: (signal: AbortSignal, sourcePreparationStarted: () => void) => Promise<T>,
  signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timeout = () => controller.abort(new DomainError(
    'RUN_START_PREPARATION_TIMEOUT', 'Start preparation did not finish before its deadline.', 504,
  ))
  let timer = setTimeout(timeout, START_PREPARATION_TIMEOUT_MS)
  const sourcePreparationStarted = () => {
    combined.throwIfAborted()
    clearTimeout(timer)
    timer = setTimeout(timeout, SOURCE_LIMITS.preparationMs)
  }
  let abort!: () => void
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(combined.reason)
    combined.addEventListener('abort', abort, { once: true })
  })
  try {
    const result = await Promise.race([operation(combined, sourcePreparationStarted), cancelled])
    combined.throwIfAborted()
    return result
  } finally {
    clearTimeout(timer)
    combined.removeEventListener('abort', abort)
  }
}
