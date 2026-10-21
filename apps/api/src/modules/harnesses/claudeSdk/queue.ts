/** A single-reader queue. Producers wait when the retained buffer is full. */
export class ClaudeBoundedQueue<T> implements AsyncIterable<T> {
  private values: T[] = []
  private writers: { value: T; resolve(): void; reject(error: unknown): void }[] = []
  private reader: { resolve(value: IteratorResult<T>): void; reject(error: unknown): void } | undefined
  private ended = false
  private failure: unknown

  constructor(private readonly capacity: number, private readonly coalesce?: (prior: T, next: T) => T | undefined) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid Claude queue capacity')
  }

  offer(value: T, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason)
    if (this.ended) return Promise.reject(this.failure ?? new Error('Claude queue closed'))
    if (this.reader) {
      const reader = this.reader
      this.reader = undefined
      reader.resolve({ done: false, value })
      return Promise.resolve()
    }
    if (this.values.length < this.capacity && !this.writers.length) {
      this.values.push(value)
      return Promise.resolve()
    }
    const prior = this.values.at(-1)
    const merged = prior !== undefined && !this.writers.length ? this.coalesce?.(prior, value) : undefined
    if (merged !== undefined) {
      this.values[this.values.length - 1] = merged
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const writer = { value,
        resolve: () => { cleanup(); resolve() },
        reject: (error: unknown) => { cleanup(); reject(error) },
      }
      const abort = () => {
        this.writers = this.writers.filter(candidate => candidate !== writer)
        writer.reject(signal?.reason)
      }
      this.writers.push(writer)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  /** A detached observer no longer needs its buffered events. */
  discard(): void {
    this.values = []
    for (const writer of this.writers.splice(0)) writer.resolve()
  }

  close(error?: unknown, discard = false): void {
    if (this.ended) return
    this.ended = true
    this.failure = error
    if (discard) this.discard()
    for (const writer of this.writers.splice(0)) writer.reject(error ?? new Error('Claude queue closed'))
    if (this.reader) {
      const reader = this.reader
      this.reader = undefined
      if (error !== undefined) reader.reject(error)
      else reader.resolve({ done: true, value: undefined })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    let detached = false
    let ownedReader: typeof this.reader
    const detach = () => {
      detached = true
      if (ownedReader && this.reader === ownedReader) {
        this.reader = undefined
        ownedReader.resolve({ done: true, value: undefined })
      }
    }
    return {
      next: () => {
        if (detached) return Promise.resolve({ done: true, value: undefined })
        if (this.values.length) {
          const value = this.values.shift()!
          const writer = this.writers.shift()
          if (writer) {
            this.values.push(writer.value)
            writer.resolve()
          }
          return Promise.resolve({ done: false, value })
        }
        if (this.ended) return this.failure !== undefined
          ? Promise.reject(this.failure) : Promise.resolve({ done: true, value: undefined })
        if (this.reader) return Promise.reject(new Error('Claude queue already has a reader'))
        return new Promise((resolve, reject) => {
          ownedReader = { resolve, reject }
          this.reader = ownedReader
        })
      },
      return: async () => { detach(); return { done: true, value: undefined } },
      throw: async (error: unknown) => { detach(); throw error },
    }
  }
}
