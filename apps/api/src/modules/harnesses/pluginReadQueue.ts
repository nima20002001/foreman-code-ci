interface Job {
  key: string | undefined
  controller: AbortController
  promise: Promise<unknown>
  execute(): Promise<void>
  users: number
}

/** One native job at a time; only in-flight reads are shared, never cached qualification. */
export class PluginReadQueue {
  private readonly waiting: Job[] = []
  private readonly shared = new Map<string, Job>()
  private active: Job | undefined
  constructor(private readonly maximum = 8) {}

  run<T>(key: string | undefined, work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    let job = key ? this.shared.get(key) : undefined
    if (job?.controller.signal.aborted) job = undefined
    if (!job) {
      if (this.waiting.length + (this.active ? 1 : 0) >= this.maximum) return Promise.reject(new Error('Native plugin read queue is full.'))
      const controller = new AbortController()
      let resolve!: (value: T) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
      void promise.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
      job = { key, controller, promise, users: 0, execute: async () => {
        try { controller.signal.throwIfAborted(); resolve(await work(controller.signal)) }
        catch (error) { reject(error) }
      } }
      if (key) this.shared.set(key, job)
      this.waiting.push(job)
    }
    const selected = job
    selected.users++
    const result = new Promise<T>((resolve, reject) => {
      let finished = false
      const release = () => {
        if (finished) return false
        finished = true
        signal.removeEventListener('abort', abort)
        if (--selected.users === 0) selected.controller.abort(new Error('No plugin read callers remain.'))
        return true
      }
      const abort = () => { if (release()) reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      void selected.promise.then((value) => { if (release()) resolve(value as T) }, (error: unknown) => { if (release()) reject(error) })
    })
    this.pump()
    return result
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...(this.active ? [this.active.promise] : []), ...this.waiting.map((job) => job.promise)])
  }
  private pump(): void {
    if (this.active) return
    const job = this.waiting.shift()
    if (!job) return
    this.active = job
    void job.execute().finally(() => {
      if (job.key && this.shared.get(job.key) === job) this.shared.delete(job.key)
      this.active = undefined
      this.pump()
    })
  }
}
