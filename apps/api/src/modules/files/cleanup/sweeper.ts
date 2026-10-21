import { setTimeout as delay } from 'node:timers/promises'

import { cleanupBatchSize, type FileCleanupBytes, type FileCleanupRepository } from './repository.js'

export interface FileCleanupBatch {
  visited: number; cleaned: number; remaining: number; stale: number; busy: number; errors: number; hasMore: boolean
}
interface Options {
  batchSize?: number
  idleMs?: number
  catchUpMs?: number
  maxBackoffMs?: number
  /** Test seam for the server timer; production always uses an unref'ed, abortable Node timer. */
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
}
type ReportError = (error: unknown, context: { operation: 'batch' | 'remove'; fileId?: string }) => void

/** Process-local pacing, cross-process guards in the repository. No browser timer, global
 * sweep lease or durable cursor: a restart immediately rediscovers overdue metadata/residue. */
export class TemporaryFileCleanupSweeper {
  private afterFileId: string | null = null
  private pending: Promise<FileCleanupBatch> | undefined
  private running: Promise<void> | undefined
  private controller: AbortController | undefined
  private stopping = false
  private readonly batchSize: number
  private readonly idleMs: number
  private readonly catchUpMs: number
  private readonly maxBackoffMs: number
  private readonly wait: (milliseconds: number, signal: AbortSignal) => Promise<void>

  constructor(private readonly repository: FileCleanupRepository, private readonly bytes: FileCleanupBytes,
    private readonly reportError: ReportError, options: Options = {}) {
    this.batchSize = cleanupBatchSize(options.batchSize ?? 32)
    this.idleMs = options.idleMs ?? 60_000
    this.catchUpMs = options.catchUpMs ?? 1_000
    this.maxBackoffMs = options.maxBackoffMs ?? 300_000
    if (![this.idleMs, this.catchUpMs, this.maxBackoffMs].every((ms) => Number.isSafeInteger(ms) && ms > 0)
      || this.catchUpMs > this.idleMs || this.idleMs > this.maxBackoffMs || this.maxBackoffMs > 2_147_483_647) {
      throw new Error('Cleanup delays must be positive, ordered and within the Node timer range.')
    }
    this.wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { ref: false, signal }))
  }

  /** Also used by tests/manual server compositions. Calls coalesce rather than overlap. */
  sweep(): Promise<FileCleanupBatch> {
    this.pending ??= this.batch().finally(() => { this.pending = undefined })
    return this.pending
  }
  private async batch(): Promise<FileCleanupBatch> {
    const result: FileCleanupBatch = { visited: 0, cleaned: 0, remaining: 0, stale: 0, busy: 0, errors: 0, hasMore: false }
    if (this.stopping) return result
    const due = await this.repository.findDue(this.afterFileId, this.batchSize)
    const disk = await this.bytes.scan(this.batchSize)
    const residue = await this.repository.findByStorageKeys(disk.keys)
    this.afterFileId = due.length === this.batchSize ? due.at(-1)!.fileId : null
    // At most 2*batchSize guarded revisions; each directory deletion is itself bounded.
    const candidates = new Map([...due, ...residue].map((value) => [value.storageKey, {
      fileId: value.fileId, remove: () => this.repository.remove(value, () => this.bytes.remove(value.storageKey)),
    }] as const))
    const artifacts = this.repository.artifacts
    if (artifacts) for (const value of await artifacts.findByStorageKeys(disk.keys)) {
      if (!candidates.has(value.storageKey)) candidates.set(value.storageKey, {
        fileId: value.artifactId, remove: () => artifacts.remove(value, () => this.bytes.remove(value.storageKey)),
      })
    }
    result.hasMore = due.length === this.batchSize || !disk.exhausted
    for (const value of candidates.values()) {
      if (this.stopping) break
      result.visited++
      try {
        const outcome = await value.remove()
        result[outcome]++
      } catch (error) {
        result.errors++
        this.reportError(error, { operation: 'remove', fileId: value.fileId })
      }
    }
    result.hasMore ||= result.remaining > 0
    return result
  }

  start(): void {
    if (this.running || this.stopping) return
    this.controller = new AbortController()
    this.running = this.loop(this.controller.signal)
  }
  private async loop(signal: AbortSignal): Promise<void> {
    let failures = 0
    while (!signal.aborted) {
      let next = this.idleMs
      try {
        const result = await this.sweep()
        failures = result.errors ? failures + 1 : 0
        next = result.hasMore ? this.catchUpMs : this.idleMs
      } catch (error) {
        failures++
        this.reportError(error, { operation: 'batch' })
      }
      if (failures) next = Math.min(this.maxBackoffMs, this.idleMs * 2 ** Math.min(failures - 1, 20))
      if (signal.aborted) break
      try { await this.wait(next, signal) } catch (error) {
        if (!signal.aborted) this.reportError(error, { operation: 'batch' })
        break
      }
    }
  }
  /** Abort sleep, drain the current guarded deletion, then close directory cursors before DB shutdown. */
  async stop(): Promise<void> {
    this.stopping = true
    this.controller?.abort()
    try { await this.running; await this.pending } finally { await this.bytes.close() }
  }
}
