import { describe, expect, it, vi } from 'vitest'
import { WorkflowScheduleSchema } from '@foreman-code/contracts/schedules'
import { decideDueSchedule, planDueSchedule } from '../src/modules/schedules/dispatchPlan.js'
import { WorkflowScheduleDispatcher, type ScheduleDispatcherPort } from '../src/modules/schedules/dispatcher.js'
import { scheduleRejectionReason } from '../src/modules/schedules/postgresDispatcher.js'
import { DomainError } from '../src/modules/errors.js'
import { deferred, rejectableDeferred } from './helpers/deferred.js'

const settings = { workspaceId: 'schedule-workspace', workflowId: 'schedule-workflow', revision: 1,
  timezone: 'UTC', enabled: true, policy: 'latest_saved', nextOccurrenceAt: '2030-01-07T10:00:00.000Z' }
const once = WorkflowScheduleSchema.parse({ ...settings, mode: 'once', localDate: '2030-01-07', time: '10:00' })
const interval = WorkflowScheduleSchema.parse({ ...settings, mode: 'interval', every: 1,
  unit: 'minute', anchorAt: '2030-01-07T09:00:00.000Z' })
const weekly = WorkflowScheduleSchema.parse({ ...settings, mode: 'weekly', weekdays: [1], time: '10:00' })

describe('SCH-04 frozen-policy dispatch plan', () => {
  it.each([once, interval, weekly])('fires $mode at the exact due instant and never early', (schedule) => {
    expect(planDueSchedule(schedule, '2030-01-07T09:59:59.999Z')).toEqual([])
    expect(planDueSchedule(schedule, settings.nextOccurrenceAt)).toEqual([
      expect.objectContaining({ dueAt: settings.nextOccurrenceAt, decision: { status: 'eligible' } }),
    ])
  })
  it('ends Once, advances weekly and uses elapsed interval time', () => {
    expect(planDueSchedule(once, settings.nextOccurrenceAt)[0]?.nextDueAt).toBeNull()
    expect(planDueSchedule(weekly, settings.nextOccurrenceAt)[0]?.nextDueAt).toBe('2030-01-14T10:00:00.000Z')
    expect(planDueSchedule(interval, settings.nextOccurrenceAt)[0]?.nextDueAt).toBe('2030-01-07T10:01:00.000Z')
  })
  it('recovers only the latest due; earlier grace-window entries are superseded', () => {
    const items = planDueSchedule(interval, '2030-01-07T10:08:30.000Z')
    expect(items).toHaveLength(9)
    expect(items.slice(0, 4).every((item) => item.decision.status === 'missed'
      && item.decision.reason === 'outside_grace')).toBe(true)
    expect(items.slice(4, 8).every((item) => item.decision.status === 'missed'
      && item.decision.reason === 'superseded')).toBe(true)
    expect(items[8]?.decision).toEqual({ status: 'eligible' })
  })
  it('includes exactly five minutes, but not one millisecond beyond', () => {
    expect(planDueSchedule(once, '2030-01-07T10:05:00.000Z')[0]?.decision).toEqual({ status: 'eligible' })
    expect(planDueSchedule(once, '2030-01-07T10:05:00.001Z')[0]?.decision)
      .toEqual({ status: 'missed', reason: 'outside_grace' })
  })
  it('does not mistake the end of a bounded backlog batch for its latest due', () => {
    const items = planDueSchedule(interval, '2030-01-08T10:00:00.000Z', 2)
    expect(items).toHaveLength(2)
    expect(items.every((item) => item.decision.status === 'missed')).toBe(true)
    expect(items[1]?.nextDueAt).toBe('2030-01-07T10:02:00.000Z')
  })
  it('rechecks disable and overlap, with missed policy taking precedence', () => {
    expect(decideDueSchedule(once, settings.nextOccurrenceAt, settings.nextOccurrenceAt, false, true))
      .toEqual({ status: 'skipped', reason: 'disabled' })
    expect(decideDueSchedule(once, settings.nextOccurrenceAt, settings.nextOccurrenceAt, true, true))
      .toEqual({ status: 'skipped', reason: 'overlap' })
    expect(decideDueSchedule(once, settings.nextOccurrenceAt, '2030-01-07T10:06:00.000Z', false, true))
      .toEqual({ status: 'missed', reason: 'outside_grace' })
    expect(planDueSchedule({ ...once, enabled: false, nextOccurrenceAt: null }, settings.nextOccurrenceAt)).toEqual([])
  })
  it('rejects unbounded batch inputs', () => {
    for (const size of [0, 1_001, 1.5, Number.NaN]) expect(() => planDueSchedule(once, settings.nextOccurrenceAt, size)).toThrow()
  })
  it('publishes only stable application reason codes', () => {
    expect(scheduleRejectionReason(new DomainError('AUTH_REVOKED', 'private detail', 403))).toBe('schedule_authorization_denied')
    expect(scheduleRejectionReason(new Error('SQL, tokens or native output'))).toBeUndefined()
    expect(scheduleRejectionReason(new DomainError('LOCATION_REVISION_CONFLICT', 'changed', 409))).toBeUndefined()
    expect(scheduleRejectionReason(new DomainError('PLACEMENT_ADMISSION_CONFLICT', 'saved instance changed', 409)))
      .toBe('workflow_not_executable')
    expect(scheduleRejectionReason(new DomainError('PLACEMENT_INVALID_ROOT', 'invalid saved root', 409)))
      .toBe('workflow_not_executable')
    for (const code of ['HARNESS_PROFILE_UNAVAILABLE', 'PLACEMENT_ADMISSION_UNAVAILABLE', 'WORKER_CONNECTION_UNAVAILABLE']) {
      expect(scheduleRejectionReason(new DomainError(code, 'temporarily unavailable', 409))).toBeUndefined()
    }
  })
})

describe('SCH-04 process loop', () => {
  function port(dispatch: ScheduleDispatcherPort['dispatch'] = vi.fn(async () => undefined)): ScheduleDispatcherPort {
    return { listDueSchedules: vi.fn(async () => ({ items: [once], pageInfo: { nextCursor: null } })), dispatch }
  }
  it('coalesces concurrent ticks and drains a pending scan before closing', async () => {
    const entered = deferred(), release = deferred()
    const work = port(vi.fn(async () => { entered.resolve(); await release.promise }))
    const loop = new WorkflowScheduleDispatcher(work, { clock: () => new Date(settings.nextOccurrenceAt), reportError: vi.fn() })
    const first = loop.tick(), second = loop.tick()
    await entered.promise
    const stopped = vi.fn()
    const closing = loop.stop().then(stopped)
    expect(stopped).not.toHaveBeenCalled()
    release.resolve()
    await Promise.all([first, second, closing])
    await loop.tick()
    expect(work.dispatch).toHaveBeenCalledTimes(1)
    expect(work.listDueSchedules).toHaveBeenCalledWith({ throughUtc: settings.nextOccurrenceAt, limit: 100 })
  })
  it('does nothing when the actual runtime is unavailable', async () => {
    const work = port()
    const loop = new WorkflowScheduleDispatcher(work, { isReady: () => false, reportError: vi.fn() })
    await loop.tick(); await loop.stop()
    expect(work.listDueSchedules).not.toHaveBeenCalled()
  })
  it('limits admission to four independent workflows and starts queued work as slots free', async () => {
    const entered = deferred()
    const release = deferred()
    const finished = deferred()
    let active = 0
    let maximum = 0
    let completed = 0
    const items = Array.from({ length: 6 }, (_, index) => ({ ...once, workflowId: `workflow-${index}` }))
    const loop = new WorkflowScheduleDispatcher({
      listDueSchedules: async () => ({ items, pageInfo: { nextCursor: null } }),
      dispatch: async (_schedule, signal) => {
        expect(signal).toBeInstanceOf(AbortSignal)
        active++
        maximum = Math.max(maximum, active)
        if (active === 4) entered.resolve()
        await release.promise
        active--
        if (++completed === 6) finished.resolve()
      },
    }, { reportError: vi.fn() })
    try {
      await loop.tick()
      await entered.promise
      expect(active).toBe(4)
      release.resolve()
      await finished.promise
      expect(maximum).toBe(4)
      expect(completed).toBe(6)
    } finally { release.resolve(); await loop.stop() }
  })
  it('does not let one failed workflow hide another candidate', async () => {
    const other = { ...once, workflowId: 'another-workflow' }
    const reportError = vi.fn(), seen: string[] = []
    const work: ScheduleDispatcherPort = {
      listDueSchedules: async () => ({ items: [once, other], pageInfo: { nextCursor: null } }),
      dispatch: async (schedule) => { seen.push(schedule.workflowId); if (schedule === once) throw new Error('synthetic') },
    }
    const loop = new WorkflowScheduleDispatcher(work, { reportError })
    await loop.tick(); await loop.stop()
    expect(seen).toEqual([once.workflowId, other.workflowId]); expect(reportError).toHaveBeenCalledOnce()
  })
  it('bounds paging, uses a single boundary, and handles repeated candidates only once per scan', async () => {
    const dispatch = vi.fn(), boundaries: string[] = []
    const work: ScheduleDispatcherPort = {
      listDueSchedules: async (input) => {
        boundaries.push(input.throughUtc)
        return { items: [once], pageInfo: { nextCursor: `more-${boundaries.length}` } }
      }, dispatch,
    }
    const loop = new WorkflowScheduleDispatcher(work, { clock: () => new Date(settings.nextOccurrenceAt), reportError: vi.fn() })
    await loop.tick(); await loop.stop()
    expect(boundaries).toHaveLength(5); expect(new Set(boundaries).size).toBe(1)
    expect(dispatch).toHaveBeenCalledOnce()
  })
  it('continues a bounded sweep so a failing prefix cannot starve later workflows', async () => {
    let calls = 0, instant = settings.nextOccurrenceAt
    const cursors: Array<string | undefined> = [], boundaries: string[] = []
    const work: ScheduleDispatcherPort = {
      listDueSchedules: async (input) => {
        calls++; cursors.push(input.cursor); boundaries.push(input.throughUtc)
        return { items: [], pageInfo: { nextCursor: calls < 7 ? `page-${calls}` : null } }
      }, dispatch: async () => {},
    }
    const loop = new WorkflowScheduleDispatcher(work, { clock: () => new Date(instant), reportError: vi.fn() })
    await loop.tick()
    instant = '2030-01-07T10:01:00.000Z'
    await loop.tick(); await loop.stop()
    expect(cursors).toEqual([undefined, 'page-1', 'page-2', 'page-3', 'page-4', 'page-5', 'page-6'])
    expect(new Set(boundaries)).toEqual(new Set([settings.nextOccurrenceAt]))
  })
  it('runs on the server timer and cancels future polling on shutdown', async () => {
    vi.useFakeTimers()
    try {
      const work = port(), loop = new WorkflowScheduleDispatcher(work, { reportError: vi.fn() })
      loop.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(work.dispatch).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(work.dispatch).toHaveBeenCalledTimes(2)
      await loop.stop()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(work.dispatch).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
  it('reports a transient scan failure and still stops cleanly while that scan is in flight', async () => {
    const scan = rejectableDeferred<never>()
    const reportError = vi.fn()
    const transient = new Error('Connection terminated due to connection timeout')
    const loop = new WorkflowScheduleDispatcher({ listDueSchedules: () => scan.promise, dispatch: vi.fn() }, { reportError })
    loop.start()
    const stopped = loop.stop()
    scan.reject(transient)
    await expect(stopped).resolves.toBeUndefined()
    expect(reportError).toHaveBeenCalledExactlyOnceWith(transient)
  })
})
