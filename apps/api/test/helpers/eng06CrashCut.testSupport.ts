export type CrashTaskOutcome = { status: 'fulfilled' } | { status: 'rejected'; reason: unknown }

/** Attach a rejection handler at launch, not after an asynchronous crash cut.
 * Assertions still inspect/rethrow the original outcome; no failure is hidden. */
export function observeCrashTask(task: Promise<unknown>): Promise<CrashTaskOutcome> {
  return task.then(() => ({ status: 'fulfilled' as const }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }))
}

/** Park the ORIGINAL call at an exact durability boundary. Throwing a normal
 * settlement wait here would let the live engine retry before it is replaced.
 * The test must abort the old engine with ENGINE_RESTART before the call resumes.
 * This helper has no SQL, provider, receipt or production-owner capability. */
export function holdCrashCut<T>(interrupted: Error) {
  let report!: (value: T) => void, release!: () => void
  const reached = new Promise<T>((resolve) => { report = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  let visits = 0
  return {
    get visits() { return visits },
    async hold(value: T, signal?: AbortSignal): Promise<never> {
      visits++
      if (visits !== 1) throw new Error('The old runtime retried the held crash boundary.')
      report(structuredClone(value))
      await released
      // Restart cancellation is identified by the engine's abort reason.
      signal?.throwIfAborted()
      throw interrupted
    },
    async wait(task: Promise<CrashTaskOutcome>, timeoutMs = 10_000): Promise<T> {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await Promise.race([
          reached,
          task.then((outcome): never => {
            if (outcome.status === 'rejected') throw outcome.reason
            throw new Error('The runtime finished before reaching the crash boundary.')
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('The runtime did not reach the crash boundary.')), timeoutMs)
          }),
        ])
      } finally { clearTimeout(timer) }
    },
    release,
  }
}
