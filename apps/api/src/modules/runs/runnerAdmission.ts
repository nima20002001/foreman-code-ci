import { beginRuntimeTiming } from '../../infrastructure/runtimeTiming.js'
import { DomainError } from '../errors.js'
import { withExecutionQueueReason, type ExecutionQueueIdentity } from './executionQueue.js'

interface Waiter {
  enter(): void
  abort(): void
}

interface HostQueue {
  active: number
  queued: number
  waiting: Map<string, Waiter[]>
  order: string[]
}

interface StartupOptions {
  hostKey?: string
  execution?: ExecutionQueueIdentity
}

/** Bounded startup work per computer. Native model turns release their startup
 * slot when their session is ready; workflow policy bounds ongoing graph work.
 * Waiting Runs take round-robin turns on the same computer. */
export class RunnerAdmission {
  private readonly hosts = new Map<string, HostQueue>()

  constructor(readonly maximum = 4, readonly maximumWaiting = 1000, readonly maximumRuns = 32) {
    for (const value of [maximum, maximumWaiting, maximumRuns]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('INVALID_RUNNER_ADMISSION_LIMIT')
    }
  }

  async run<T>(runId: string, signal: AbortSignal, work: (release: () => void) => Promise<T>,
    options: StartupOptions = {}): Promise<T> {
    signal.throwIfAborted()
    const hostKey = options.hostKey ?? 'main'
    const host: HostQueue = this.hosts.get(hostKey) ?? { active: 0, queued: 0, waiting: new Map(), order: [] }
    this.hosts.set(hostKey, host)
    const acquired = beginRuntimeTiming('engine', 'worker.admission', {
      runId, ...(options.execution ? { executionId: options.execution.id } : {}), count: host.queued,
    })
    try {
      if (host.active < this.maximum && !host.queued) host.active++
      else await withExecutionQueueReason(options.execution,
        { kind: 'host_capacity', hostKey, limit: this.maximum }, () => this.wait(host, runId, signal))
    } finally {
      acquired()
    }
    let released = false
    const release = () => {
      if (released) return
      released = true
      this.release(hostKey, host)
    }
    try {
      signal.throwIfAborted()
      return await work(release)
    } finally {
      release()
    }
  }

  private wait(host: HostQueue, runId: string, signal: AbortSignal): Promise<void> {
    const waitingRuns = new Set([...this.hosts.values()].flatMap(queue => [...queue.waiting.keys()]))
    if (this.pending >= this.maximumWaiting || !waitingRuns.has(runId) && waitingRuns.size >= this.maximumRuns) {
      throw new DomainError('RUNNER_ADMISSION_FULL', 'Startup capacity is full. This execution was not launched.', 503)
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        enter: () => {
          signal.removeEventListener('abort', waiter.abort)
          resolve()
        },
        abort: () => {
          const queue = host.waiting.get(runId)
          const index = queue?.indexOf(waiter) ?? -1
          if (index < 0) return
          queue!.splice(index, 1)
          host.queued--
          if (!queue!.length) this.removeRun(host, runId)
          reject(signal.reason)
        },
      }
      const queue = host.waiting.get(runId)
      if (queue) queue.push(waiter)
      else {
        host.waiting.set(runId, [waiter])
        host.order.push(runId)
      }
      host.queued++
      signal.addEventListener('abort', waiter.abort, { once: true })
      if (signal.aborted) waiter.abort()
    })
  }

  private release(hostKey: string, host: HostQueue): void {
    const runId = host.order.shift()
    if (runId === undefined) {
      host.active--
      if (!host.active) this.hosts.delete(hostKey)
      return
    }
    const queue = host.waiting.get(runId)!
    const next = queue.shift()!
    host.queued--
    if (queue.length) host.order.push(runId)
    else host.waiting.delete(runId)
    // Transfer the counted slot, including cancellation just after wakeup.
    next.enter()
  }

  private removeRun(host: HostQueue, runId: string): void {
    host.waiting.delete(runId)
    const index = host.order.indexOf(runId)
    if (index >= 0) host.order.splice(index, 1)
  }

  get pending(): number { return [...this.hosts.values()].reduce((sum, host) => sum + host.queued, 0) }
  get inFlight(): number { return [...this.hosts.values()].reduce((sum, host) => sum + host.active, 0) }
}
