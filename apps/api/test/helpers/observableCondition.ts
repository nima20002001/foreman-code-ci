import { canonicalJson } from '@foreman-code/contracts/canonical-json'

export async function readUntil<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  options: {
    timeoutMs: number
    description: string
    subscribe?: (changed: () => void) => () => void
    minimumReadIntervalMs?: number
    /** With progress, timeoutMs bounds the time without a change in this value, not the whole wait. */
    progress?: (value: T) => unknown
  },
): Promise<T> {
  let deadline = 0
  let expired!: Promise<void>
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    deadline = performance.now() + options.timeoutMs
    expired = new Promise<void>(resolve => { timer = setTimeout(resolve, options.timeoutMs) })
  }
  arm()
  let progress: string | undefined
  let pollTimer: ReturnType<typeof setTimeout> | undefined
  try {
    for (;;) {
      let changed!: () => void
      const notification = new Promise<void>(resolve => { changed = resolve })
      // Subscribe before reading so a commit during the snapshot cannot be missed.
      const unsubscribe = options.subscribe?.(changed)
      try {
        const readStarted = performance.now()
        const value = await read()
        if (accept(value)) return value
        if (options.progress) {
          const observed = canonicalJson(options.progress(value))
          if (progress !== undefined && observed !== progress) arm()
          progress = observed
        }
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${options.description}.${
          progress === undefined ? '' : ` No progress for ${options.timeoutMs} ms; last progress: ${progress}`}`)
        // Commit notifications wake the read immediately; polling covers external native progress.
        const pollIntervalMs = Math.max(25, options.minimumReadIntervalMs ?? 0)
        const polling = new Promise<void>(resolve => { pollTimer = setTimeout(resolve, pollIntervalMs) })
        await Promise.race([notification, polling, expired])
        clearTimeout(pollTimer)
        // Reconciliation reads can publish their own notifications; bound that feedback loop.
        const remainingIntervalMs = readStarted + (options.minimumReadIntervalMs ?? 0) - performance.now()
        if (remainingIntervalMs > 0) {
          const interval = new Promise<void>(resolve => {
            pollTimer = setTimeout(resolve, remainingIntervalMs)
          })
          await Promise.race([interval, expired])
        }
      } finally {
        clearTimeout(pollTimer)
        unsubscribe?.()
      }
    }
  } finally {
    clearTimeout(timer)
    clearTimeout(pollTimer)
  }
}
