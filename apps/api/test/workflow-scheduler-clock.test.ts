import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  nextOccurrences, parseScheduleSaveInput, ScheduleConfigurationSchema, ScheduleSaveInputSchema,
  scheduleOccurrenceId, WorkflowScheduleSchema, type ScheduleConfiguration,
} from '@foreman-code/contracts/schedules'
import { planDueSchedule } from '../src/modules/schedules/dispatchPlan.js'
import { WorkflowScheduleDispatcher } from '../src/modules/schedules/dispatcher.js'
import { sch11ClockCases, sch11Minute, sch11Once, sch11Settings } from './helpers/sch11ClockCases.js'
import { deferred } from './helpers/deferred.js'

const scope = { workspaceId: 'sch11-workspace', workflowId: 'sch11-workflow' }
const request = (schedule: unknown) => ({ ...scope, commandId: 'sch11-clock-command', expectedRevision: 0, schedule })
const instantBefore = (instant: string) => new Date(Date.parse(instant) - 1).toISOString()
const record = (schedule: ScheduleConfiguration, nextOccurrenceAt: string | null) =>
  WorkflowScheduleSchema.parse({ ...schedule, ...scope, revision: 1, nextOccurrenceAt })

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('SCH-11 deterministic schedule clock / preview-dispatch contract', () => {
  it.each(sch11ClockCases)('$name: literal preview and dispatch instants agree', ({ schedule, from, expected }) => {
    expect(nextOccurrences(schedule, from, expected.length)).toEqual(expected)
    const saved = record(schedule, expected[0]!)
    let cursor = saved.nextOccurrenceAt
    for (const dueAt of expected) {
      const current = { ...saved, nextOccurrenceAt: cursor }
      expect(planDueSchedule(current, instantBefore(dueAt))).toEqual([])
      const steps = planDueSchedule(current, dueAt)
      expect(steps).toHaveLength(1)
      expect(steps[0]).toEqual({ dueAt, decision: { status: 'eligible' },
        nextDueAt: nextOccurrences(schedule, dueAt, 1)[0] ?? null })
      cursor = steps[0]!.nextDueAt
    }
    // The exact boundary is excluded; it must not produce the other fold instance.
    expect(nextOccurrences(schedule, expected[0]!, expected.length - 1)).toEqual(expected.slice(1))
    expect(nextOccurrences({ ...schedule, enabled: false }, from, 10)).toEqual([])
  })

  it.each(['UTC', 'America/Los_Angeles', 'Asia/Tokyo'])('ignores the host timezone %s and implicit Date.now', (timezone) => {
    const prior = process.env.TZ
    try {
      process.env.TZ = timezone
      vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Implicit clock read') })
      for (const item of sch11ClockCases) {
        expect(nextOccurrences(item.schedule, item.from, item.expected.length)).toEqual(item.expected)
      }
    } finally {
      if (prior === undefined) delete process.env.TZ
      else process.env.TZ = prior
    }
  })

  it.each([{ every: 1, unit: 'minute' as const }, { every: 7, unit: 'hour' as const }])(
    'keeps the $every-$unit anchor after JSON persistence and restart', ({ every, unit }) => {
      const configuration: ScheduleConfiguration = { ...sch11Settings, mode: 'interval', every, unit,
        anchorAt: '2024-11-02T21:00:17.250Z', timezone: 'America/New_York' }
      const duration = every * (unit === 'minute' ? 60_000 : 3_600_000)
      const due = nextOccurrences(configuration, configuration.anchorAt, 20)
      const saved = record(configuration, due[0]!)
      const restarted = WorkflowScheduleSchema.parse(JSON.parse(JSON.stringify({ ...saved, nextOccurrenceAt: due[7] })))
      const preview = nextOccurrences(restarted, due[7]!, 12)
      expect(preview).toEqual(due.slice(8))
      for (const time of preview) expect((Date.parse(time) - Date.parse(configuration.anchorAt)) % duration).toBe(0)
      expect(planDueSchedule(restarted, due[7]!)[0]?.dueAt).toBe(due[7])
      // Preview ignores even an unrelated stored cursor; it never re-anchors at restart time.
      expect(nextOccurrences({ ...restarted, nextOccurrenceAt: '2099-01-01T00:00:00.000Z' }, due[7]!, 12)).toEqual(preview)
    },
  )

  it('does not invent pre-anchor intervals, and normalizes offset identities', () => {
    const schedule = { ...sch11Minute, anchorAt: '2030-01-07T14:00:00+05:00' }
    expect(nextOccurrences(schedule, '2030-01-01T00:00:00.000Z', 2))
      .toEqual(['2030-01-07T09:00:00.000Z', '2030-01-07T09:01:00.000Z'])
    expect(scheduleOccurrenceId(scope.workflowId, '2030-01-07T14:00:00+05:00'))
      .toBe(scheduleOccurrenceId(scope.workflowId, '2030-01-07T09:00:00.000Z'))
  })

  it('exhausts Once while keeping static receipt parsing clock-free and rejecting new elapsed saves', () => {
    const input = request(sch11Once), due = '2030-01-07T10:00:00.000Z'
    expect(parseScheduleSaveInput(input, instantBefore(due))).toEqual(ScheduleSaveInputSchema.parse(input))
    expect(nextOccurrences(sch11Once, due, 3)).toEqual([])
    expect(planDueSchedule(record(sch11Once, null), due)).toEqual([])
    // Static parsing is intentionally clock-free for a historical receipt.
    expect(ScheduleSaveInputSchema.safeParse(input).success).toBe(true)
    for (const now of [due, '2030-01-08T00:00:00.000Z']) {
      expect(() => parseScheduleSaveInput(input, now)).toThrow()
      expect(() => parseScheduleSaveInput(request({ ...sch11Once, enabled: false }), now)).toThrow()
    }
  })

  it('cannot use the second fold instance to rescue a new past Once save', () => {
    const schedule = sch11ClockCases.find((item) => item.name === 'once in a fold')!.schedule
    expect(() => parseScheduleSaveInput(request(schedule), '2024-11-03T05:45:00.000Z')).toThrow()
    expect(nextOccurrences(schedule, '2024-11-03T05:45:00.000Z', 2)).toEqual([])
  })

  it('looks ahead across bounded backlog batches; there is exactly one eligible latest due', () => {
    let saved = record(sch11Minute, '2030-01-07T09:01:00.000Z')
    const decisions: ReturnType<typeof planDueSchedule> = []
    const now = '2030-01-07T13:11:30.000Z' // 251 occurrences, three bounded passes.
    for (let pass = 0; pass < 3; pass++) {
      const batch = planDueSchedule(saved, now, 100)
      expect(batch.length).toBeLessThanOrEqual(100)
      if (pass < 2) expect(batch.every((step) => step.decision.status === 'missed')).toBe(true)
      decisions.push(...batch)
      saved = { ...saved, nextOccurrenceAt: batch.at(-1)!.nextDueAt }
    }
    expect(decisions).toHaveLength(251)
    expect(decisions.filter((step) => step.decision.status === 'eligible').map((step) => step.dueAt))
      .toEqual(['2030-01-07T13:11:00.000Z'])
    expect(saved.nextOccurrenceAt).toBe('2030-01-07T13:12:00.000Z')
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_001])('rejects invalid preview count %s', (count) => {
    expect(() => nextOccurrences(sch11Once, '2030-01-07T09:00:00.000Z', count)).toThrow()
  })
  it('supports zero and the bounded maximum preview count', () => {
    expect(nextOccurrences(sch11Minute, '2030-01-07T09:00:00.000Z', 0)).toEqual([])
    const instants = nextOccurrences(sch11Minute, '2030-01-07T09:00:00.000Z', 1_000)
    expect(instants).toHaveLength(1_000)
    expect(new Set(instants).size).toBe(1_000)
    expect(instants).toEqual([...instants].sort())
  })
})

const weekly = { ...sch11Settings, mode: 'weekly', weekdays: [1], time: '10:00' }
const invalid: Array<{ name: string; schedule: unknown }> = [
  ...[[], [0], [8], [1, 1], [1.5], ['1']].map((weekdays) => ({ name: `weekdays ${JSON.stringify(weekdays)}`, schedule: { ...weekly, weekdays } })),
  ...['24:00', '23:60', '9:00', '10:00:00', ''].map((time) => ({ name: `time ${time}`, schedule: { ...weekly, time } })),
  ...['EST', '+05:00', 'Mars/Olympus', '', ' UTC'].map((timezone) => ({ name: `zone ${timezone}`, schedule: { ...weekly, timezone } })),
  ...[0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1'].map((every) => ({ name: `interval ${every}`, schedule: { ...sch11Minute, every } })),
  ...['day', 'minutes', ''].map((unit) => ({ name: `unit ${unit}`, schedule: { ...sch11Minute, unit } })),
  ...['not-a-date', '2030-01-07', '2030-01-07T09:00:00.0001Z'].map((anchorAt) => ({ name: `anchor ${anchorAt}`, schedule: { ...sch11Minute, anchorAt } })),
  ...['2030-02-29', '2100-02-29', '2030-04-31', '2030-13-01', '0000-01-01', '2030-1-01'].map((localDate) => ({ name: `date ${localDate}`, schedule: { ...sch11Once, localDate } })),
  { name: 'caller-owned cursor', schedule: { ...weekly, nextOccurrenceAt: '2030-01-07T10:00:00.000Z' } },
  { name: 'caller-owned revision', schedule: { ...weekly, revision: 1 } },
  { name: 'pinned version policy', schedule: { ...weekly, policy: 'pinned' } },
  { name: 'mixed recurrence modes', schedule: { ...weekly, anchorAt: '2030-01-07T09:00:00.000Z' } },
]
describe('SCH-11 invalid schedule inputs', () => {
  it.each(invalid)('rejects $name before admission', ({ schedule }) => {
    expect(ScheduleConfigurationSchema.safeParse(schedule).success).toBe(false)
    expect(() => parseScheduleSaveInput(request(schedule), '2029-01-01T00:00:00.000Z')).toThrow()
  })
  it.each(['not-a-date', '2030-01-07T09:00:00.1234Z'])('rejects invalid explicit clock %s', (now) => {
    expect(() => nextOccurrences(sch11Once, now, 1)).toThrow()
    expect(() => parseScheduleSaveInput(request(sch11Once), now)).toThrow()
  })
})

describe('SCH-11 process timer shutdown and failure pacing', () => {
  it('cancels polling on stop while a page read is pending, without dispatching its late result', async () => {
    vi.useFakeTimers()
    const entered = deferred(), release = deferred()
    const dispatch = vi.fn(async () => undefined)
    const list = vi.fn(async () => {
      entered.resolve(); await release.promise
      return { items: [record(sch11Once, '2030-01-07T10:00:00.000Z')], pageInfo: { nextCursor: null } }
    })
    const loop = new WorkflowScheduleDispatcher({ listDueSchedules: list, dispatch }, { reportError: vi.fn() })
    try {
      loop.start()
      await entered.promise
      let stopped = false
      const closing = loop.stop().then(() => { stopped = true })
      expect(stopped).toBe(false)
      release.resolve(); await closing
      loop.start(); await loop.tick(); await vi.advanceTimersByTimeAsync(60_000)
      expect(dispatch).not.toHaveBeenCalled()
      expect(list).toHaveBeenCalledOnce()
      expect(vi.getTimerCount()).toBe(0)
    } finally { release.resolve(); await loop.stop() }
  })

  it('waits a full poll interval after a scan error and remains stoppable', async () => {
    vi.useFakeTimers()
    const failure = new Error('synthetic database unavailable')
    const list = vi.fn(async () => { throw failure })
    const reportError = vi.fn()
    const loop = new WorkflowScheduleDispatcher({ listDueSchedules: list, dispatch: vi.fn() }, { reportError, pollIntervalMs: 1_000 })
    try {
      loop.start(); await vi.advanceTimersByTimeAsync(0)
      expect(list).toHaveBeenCalledOnce(); expect(reportError).toHaveBeenCalledWith(failure)
      await vi.advanceTimersByTimeAsync(999); expect(list).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1); expect(list).toHaveBeenCalledTimes(2)
    } finally { await loop.stop() }
    expect(vi.getTimerCount()).toBe(0)
  })
})
