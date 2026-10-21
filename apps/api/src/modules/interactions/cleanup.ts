/** Cleanup has a fresh signal: an already-aborted execution signal must not skip cancellation. */
export const cleanupTimeoutMs = 5_000

export async function withCleanupDeadline<T>(operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = cleanupTimeoutMs): Promise<T> {
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error('Execution cleanup timed out.')
          controller.abort(error)
          reject(error)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function attemptCleanup<T>(
  failures: Error[],
  label: string,
  operation: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T | undefined> {
  try {
    return await withCleanupDeadline(operation, options.timeoutMs)
  } catch (error) {
    failures.push(new Error(label, { cause: error }))
    return undefined
  }
}
