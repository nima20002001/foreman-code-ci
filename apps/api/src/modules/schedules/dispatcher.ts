import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { trackService } from '../diagnostics/serviceHealth.js'
import type { WorkflowSchedule } from '@foreman-code/contracts/schedules'
import { DomainError } from '../errors.js'
import type { ScheduleDispatchContext, ScheduleDispatchErrorReporter } from './dispatchErrors.js'

export interface ScheduleDispatcherPort {
  listDueSchedules(input: { throughUtc: string; limit: number; cursor?: string }): Promise<{
    items: WorkflowSchedule[]; pageInfo: { nextCursor: string | null }
  }>
  dispatch(schedule: WorkflowSchedule, signal?: AbortSignal,
    onCandidate?: (candidate: WorkflowSchedule) => void): Promise<void>
}
export interface ScheduleDispatcherOptions {
  clock?: () => Date
  isReady?: () => boolean
  reportError: ScheduleDispatchErrorReporter
  pollIntervalMs?: number
}

/** Polling and bounded admission run independently. Cross-process correctness
 * belongs to the transaction and unique occurrence in the port. */
export class WorkflowScheduleDispatcher {
  private readonly clock: () => Date
  private readonly interval: number
  private active: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false
  private closed = false
  private sweep: { throughUtc: string; cursor?: string } | undefined
  private readonly pending = new Map<string, WorkflowSchedule>()
  private readonly dispatching = new Map<string, Promise<void>>()

  constructor(private readonly port: ScheduleDispatcherPort, private readonly options: ScheduleDispatcherOptions) {
    this.clock = options.clock ?? (() => new Date())
    this.interval = options.pollIntervalMs ?? 1_000
    if (!Number.isInteger(this.interval) || this.interval < 1 || this.interval > 2_147_483_647) {
      throw new RangeError('pollIntervalMs must be a positive 32-bit integer.')
    }
  }

  tick(): Promise<void> {
    if (this.closed || this.options.isReady?.() === false) return Promise.resolve()
    if (this.active) return this.active
    this.active = this.scan().finally(() => { this.active = undefined })
    return this.active
  }

  private async scan(): Promise<void> {
    this.drain()
    if (this.pending.size) return
    // Keep the fixed-boundary keyset across bounded passes. A persistently
    // failing first page must not starve later workflows. Wrap at sweep end.
    const sweep = this.sweep ??= { throughUtc: this.clock().toISOString() }
    const { throughUtc } = sweep
    const seen = new Set<string>()
    for (let page = 0; page < 5 && !this.closed; page++) {
      const cursor = sweep.cursor
      const batch = await this.port.listDueSchedules({ throughUtc, limit: 100, ...(cursor ? { cursor } : {}) })
      for (const schedule of batch.items) {
        if (this.closed || this.options.isReady?.() === false) return
        if (seen.has(schedule.workflowId)) continue
        seen.add(schedule.workflowId)
        if (this.dispatching.has(schedule.workflowId) || this.pending.has(schedule.workflowId)) continue
        this.pending.set(schedule.workflowId, schedule)
        this.drain()
      }
      if (!batch.pageInfo.nextCursor || batch.pageInfo.nextCursor === cursor) { this.sweep = undefined; return }
      sweep.cursor = batch.pageInfo.nextCursor
      if (this.pending.size) return
    }
  }

  private drain(): void {
    while (!this.closed && this.options.isReady?.() !== false && this.dispatching.size < 4) {
      const schedule = this.pending.values().next().value
      if (!schedule) return
      this.pending.delete(schedule.workflowId)
      const controller = new AbortController()
      let context: ScheduleDispatchContext = {
        workspaceId: schedule.workspaceId, workflowId: schedule.workflowId, dueAt: schedule.nextOccurrenceAt,
      }
      const timer = setTimeout(() => controller.abort(new DomainError(
        'SCHEDULE_PREPARATION_TIMEOUT', 'Scheduled Start exceeded its preparation deadline.', 504,
      )), 30_000)
      const work = Promise.resolve().then(() => this.port.dispatch(schedule, controller.signal, (candidate) => {
        context = { workspaceId: candidate.workspaceId, workflowId: candidate.workflowId,
          dueAt: candidate.nextOccurrenceAt }
      }))
        .catch((error: unknown) => {
          logIgnoredError('engine', 'dispatch scheduled workflow', error)
          this.options.reportError(error, context)
        })
        .finally(() => {
          clearTimeout(timer)
          this.dispatching.delete(schedule.workflowId)
          this.drain()
        })
      this.dispatching.set(schedule.workflowId, work)
    }
  }

  start(): void {
    if (this.running || this.closed) return
    this.running = true
    const poll = async () => {
      try { await trackService('workflow-schedules', { cadenceMs: this.interval, deadlineMs: 2 * 60_000 }, () => this.tick()) }
      catch (error) { this.options.reportError(error) }
      if (!this.closed) {
        this.timer = setTimeout(() => { void poll() }, this.interval)
        this.timer.unref()
      }
    }
    void poll()
  }

  async stop(): Promise<void> {
    this.closed = true
    this.pending.clear()
    if (this.timer) clearTimeout(this.timer)
    await this.active?.catch(() => { /* ignore: poll() already reported a failed scan; shutdown only waits for it to end. */ })
    await Promise.all(this.dispatching.values())
  }
}
