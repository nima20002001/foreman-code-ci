/** Observe cancellation independently of a provider honoring AbortSignal. This
 * function never retries, calls SQL, or describes a late native action as absent.
 * The caller retains the committed uncertain intent and reconciles its exact ID. */
export async function observeNativeDispatch<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const canceled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  const pending = Promise.resolve().then(() => {
    signal.throwIfAborted()
    return operation()
  })
  try {
    // Promise.race installs a rejection handler on pending even if cancellation
    // wins, so a non-cooperative provider's later rejection is still observed.
    const value = await Promise.race([pending, canceled])
    signal.throwIfAborted()
    return value
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}
