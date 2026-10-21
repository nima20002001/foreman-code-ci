import { logger } from '../diagnostics/logger.js'

interface Entry<T> {
  expiresAt: number
  pending: boolean
  fulfilled: boolean
  invalidated: boolean
  value: Promise<T>
  stale?: Promise<T> | undefined
  controller: AbortController
  readers: number
  background: boolean
  checkedAt: string | null
  refreshCount: number
  failureCount: number
  staleReadCount: number
  lastError: string | null
}
interface ReadOptions {
  signal?: AbortSignal | undefined
  refresh?: boolean | undefined
  allowStale?: boolean | undefined
}
/** Bounded single-flight cache. Invalidating a running probe never duplicates its process. */
export class QualificationCache<T> {
  private readonly values = new Map<string, Entry<T>>()
  private closing = false
  constructor(private readonly ttlMs = 300_000, private readonly maximum = 128, private readonly now = Date.now,
    // Serve an expired success while one refresh runs and keep it after a failed refresh; invalidation never serves stale values.
    private readonly staleWhileRevalidate = false) {
    if (ttlMs < 0 || maximum < 1) throw new Error('Invalid qualification cache limits.')
  }
  get(key: string, load: (signal: AbortSignal) => Promise<T>, options: ReadOptions = {}): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Native checks are shutting down.'))
    if (options.signal?.aborted) return Promise.reject(options.signal.reason)
    let entry = this.values.get(key)
    const previous = entry
    let stale: Promise<T> | undefined
    if (entry && !entry.pending && (options.refresh || entry.expiresAt <= this.now())) {
      if (!options.refresh && options.allowStale !== false && this.staleWhileRevalidate && entry.fulfilled) {
        stale = entry.value
      }
      this.values.delete(key)
      entry = undefined
    }
    if (!entry) {
      if (this.values.size >= this.maximum) {
        const settled = [...this.values].find(([, candidate]) => !candidate.pending)
        if (!settled) return Promise.reject(new Error('Native checks are busy.'))
        this.values.delete(settled[0])
      }
      const controller = new AbortController()
      entry = {
        expiresAt: Infinity, pending: true, fulfilled: false, invalidated: false,
        value: Promise.resolve().then(() => {
          controller.signal.throwIfAborted()
          return load(controller.signal)
        }),
        stale, controller, readers: 0, background: Boolean(stale),
        checkedAt: previous?.checkedAt ?? null,
        refreshCount: (previous?.refreshCount ?? 0) + Number(Boolean(previous)),
        failureCount: previous?.failureCount ?? 0,
        staleReadCount: previous?.staleReadCount ?? 0,
        lastError: previous?.lastError ?? null,
      }
      this.values.set(key, entry)
      const loaded = entry
      if (stale) logger.warn({ component: 'harness', checkedAt: loaded.checkedAt,
        status: 'refreshing', refreshCount: loaded.refreshCount }, 'Native readiness is stale; refresh pending')
      const settle = (ttl: number, fulfilled: boolean) => {
        loaded.pending = false
        loaded.fulfilled = fulfilled
        loaded.stale = undefined
        loaded.expiresAt = this.now() + ttl
        if (loaded.invalidated && this.values.get(key) === loaded) this.values.delete(key)
      }
      void loaded.value.then(() => {
        loaded.checkedAt = new Date(this.now()).toISOString()
        loaded.lastError = null
        settle(this.ttlMs, true)
      }, () => {
        loaded.failureCount++
        loaded.lastError = 'The native readiness check could not complete.'
        if (previous) logger.warn({ component: 'harness', failureCount: loaded.failureCount,
          refreshCount: loaded.refreshCount, lastError: loaded.lastError }, 'Native readiness refresh failed')
        // A failed background refresh keeps the last success and retries soon; other failures are cached as rejections.
        if (stale && !loaded.invalidated) loaded.value = stale
        settle(Math.min(this.ttlMs, 15_000), Boolean(stale) && !loaded.invalidated)
      })
    }
    const selected = entry
    if (options.refresh || options.allowStale === false) selected.background = false
    if (!options.refresh && options.allowStale !== false && selected.pending && selected.stale) {
      selected.staleReadCount++
      return selected.stale.then((value) => structuredClone(value))
    }
    return this.read(key, selected, options.signal).then(
      (value) => selected.invalidated ? this.get(key, load, options) : structuredClone(value),
      (error: unknown) => {
        if (selected.invalidated && !options.signal?.aborted) return this.get(key, load, options)
        throw error
      },
    )
  }
  observation(key: string) {
    const entry = this.values.get(key)
    return {
      checkedAt: entry?.checkedAt ?? null,
      stale: Boolean(entry?.pending && entry.stale),
      refreshing: entry?.pending ?? false,
      refreshCount: entry?.refreshCount ?? 0,
      failureCount: entry?.failureCount ?? 0,
      staleReadCount: entry?.staleReadCount ?? 0,
      lastError: entry?.lastError ?? null,
    }
  }
  private read(key: string, entry: Entry<T>, signal?: AbortSignal): Promise<T> {
    entry.readers++
    return new Promise<T>((resolve, reject) => {
      let finished = false
      const release = () => {
        if (finished) return false
        finished = true
        signal?.removeEventListener('abort', abort)
        entry.readers--
        if (entry.pending && entry.readers === 0 && !entry.background) {
          entry.controller.abort(new Error('No native check readers remain.'))
          if (this.values.get(key) === entry) this.values.delete(key)
        }
        return true
      }
      const abort = () => { if (release()) reject(signal!.reason) }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      void entry.value.then(
        (value) => { if (release()) resolve(value) },
        (error: unknown) => { if (release()) reject(error) },
      )
    })
  }
  /** Drop one settled result so the next read loads again; a running load keeps its ownership. */
  forget(key: string): void {
    if (this.values.get(key)?.pending === false) this.values.delete(key)
  }
  clear(): void {
    for (const [key, entry] of this.values) {
      entry.stale = undefined
      if (entry.pending) entry.invalidated = true
      else this.values.delete(key)
    }
  }
  async close(): Promise<void> {
    this.closing = true
    for (const entry of this.values.values()) entry.controller.abort(new Error('Native checks are shutting down.'))
    await Promise.allSettled([...this.values.values()].map((entry) => entry.value))
    this.values.clear()
  }
}
