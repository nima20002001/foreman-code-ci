import { reconcileBrowserProfileIntent } from './reconcile.js'
import type { BrowserProfileService } from './service.js'
import type { BrowserProfileSyncCoordinator } from './sync.js'
import type { BrowserProfileRetention } from './retention.js'
import type { BrowserProfilePendingWork } from './types.js'

export interface BrowserProfileDispatcherOptions {
  service: BrowserProfileService
  sync: Pick<BrowserProfileSyncCoordinator, 'reconcile'>
  retention: Pick<BrowserProfileRetention, 'reconcile'>
  reportFailure(error: unknown, work?: BrowserProfilePendingWork): void
  retryMs?: number
}

/** B owns recovery and scheduling; composition only starts/stops it and forwards paired-host wakeups. */
export class BrowserProfileDispatcher {
  private started = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private requested = false
  private cursor: string | undefined
  private unsubscribe: (() => void) | undefined
  constructor(readonly options: BrowserProfileDispatcherOptions) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.unsubscribe = this.options.service.onWork(() => this.wake())
    this.wake()
  }

  /** Also called after reconnect/re-pair or runtime readiness changes. It never launches a browser for a read. */
  wake(): void {
    if (!this.started) return
    this.requested = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.running) this.launch()
  }

  private launch(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.requested = false
    const task = this.pump().catch(error => {
      this.options.reportFailure(error)
      this.schedule(this.options.retryMs ?? 5_000)
    })
    this.running = task
    void task.finally(() => {
      if (this.running === task) this.running = undefined
      if (this.started && this.requested) this.launch()
    }).catch(error => this.options.reportFailure(error))
  }

  private schedule(delay: number): void {
    if (!this.started || this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; this.wake() }, delay)
    this.timer.unref?.()
  }

  private async perform(work: BrowserProfilePendingWork): Promise<void> {
    try {
      if (work.kind === 'intent') await reconcileBrowserProfileIntent(this.options.service, work.id)
      else if (work.kind === 'job') await this.options.sync.reconcile(work.id)
      else await this.options.retention.reconcile(work.id)
    } catch (error) { this.options.reportFailure(error, work) }
  }

  /** At most 64 discovered rows and four native operations in flight per turn. Cursor rotation prevents starvation. */
  private async pump(): Promise<void> {
    const page = await this.options.service.repository.read(tx => tx.pendingWork(this.cursor, 65))
    const batch = page.slice(0, 64)
    for (let start = 0; start < batch.length && this.started; start += 4) {
      await Promise.all(batch.slice(start, start + 4).map(work => this.perform(work)))
    }
    if (page.length > 64) {
      this.cursor = batch.at(-1)!.key
      this.schedule(0)
      return
    }
    const wrapped = this.cursor !== undefined
    this.cursor = undefined
    // Retry only durable pending work. An empty queue owns no recurring timer.
    const remaining = await this.options.service.repository.read(tx => tx.pendingWork(undefined, 1))
    if (remaining.length) this.schedule(wrapped && !batch.length ? 0 : this.options.retryMs ?? 5_000)
  }

  async stop(): Promise<void> {
    this.started = false; this.requested = false
    this.unsubscribe?.(); this.unsubscribe = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    await this.running
    this.cursor = undefined
  }
}
