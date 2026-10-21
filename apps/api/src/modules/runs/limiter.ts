import { withExecutionQueueReason, type ExecutionQueueIdentity } from './executionQueue.js'

/** FIFO, run-local capacity. Waiting nodes cannot launch after cancellation. */
export class ExecutionLimiter {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly maximum: number, private readonly maximumWaiting = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error('maxParallelism must be a positive integer.')
    if (!Number.isSafeInteger(maximumWaiting) || maximumWaiting < 0) throw new Error('The waiting capacity must be a nonnegative integer.')
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>, execution?: ExecutionQueueIdentity): Promise<T> {
    signal.throwIfAborted()
    if (this.active >= this.maximum) {
      if (this.waiting.length >= this.maximumWaiting) throw new Error('RUNNER_ADMISSION_FULL')
      await withExecutionQueueReason(execution, { kind: 'workflow_parallelism', limit: this.maximum },
        () => new Promise<void>((resolve, reject) => {
          const enter = () => {
            signal.removeEventListener('abort', abort)
            resolve()
          }
          const abort = () => {
            const index = this.waiting.indexOf(enter)
            if (index !== -1) this.waiting.splice(index, 1)
            reject(signal.reason)
          }
          this.waiting.push(enter)
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
        }))
      // The releasing worker transfers its existing slot to this waiter.
    } else {
      this.active += 1
    }
    try {
      signal.throwIfAborted()
      return await work()
    } finally {
      const next = this.waiting.shift()
      if (next) next()
      else this.active -= 1
    }
  }
}
