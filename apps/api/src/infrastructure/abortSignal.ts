/** Stop waiting even when an I/O provider does not observe cancellation. */
export async function withAbortSignal<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  const pending = Promise.resolve().then(() => {
    signal.throwIfAborted()
    return work()
  })
  try {
    const result = await Promise.race([pending, aborted])
    signal.throwIfAborted()
    return result
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
