import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextOccurrences, type ScheduleConfiguration, type WorkflowSchedule } from '@foreman-code/contracts/schedules'
import { mockDeviceTimezone } from '../../test/deviceTimezone'
import { buildScheduleCommand, createDraft, createScheduleEditorStore } from './editorStore'

const scope = { workspaceId: 'device-workspace', workflowId: 'device-workflow' }
const now = '2026-10-02T12:00:00.000Z'
function command(value: ScheduleConfiguration | WorkflowSchedule) {
  const store = createScheduleEditorStore()
  store.getState().initialize(value, 3)
  const result = buildScheduleCommand(scope, store.getState(), now)
  if (result.command?.kind !== 'save') throw new Error(JSON.stringify(result.errors))
  return { store, schedule: result.command.input.schedule }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('device-local schedule drafts', () => {
  it.each([
    ['2026-03-08T04:30:00.000Z', '2026-03-08'],
    ['2026-03-08T05:30:00.000Z', '2026-03-09'],
    ['2026-03-09T03:30:00.000Z', '2026-03-09'],
    ['2026-03-09T04:30:00.000Z', '2026-03-10'],
    ['2026-11-01T03:30:00.000Z', '2026-11-01'],
    ['2026-11-01T04:30:00.000Z', '2026-11-02'],
    ['2026-11-02T04:30:00.000Z', '2026-11-02'],
    ['2026-11-02T05:30:00.000Z', '2026-11-03'],
  ])('defaults a fresh Once to the next local calendar date at %s', (instant, localDate) => {
    mockDeviceTimezone('America/New_York')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(instant))
    const store = createScheduleEditorStore()
    store.getState().initialize(null, 0)
    store.getState().edit({ mode: 'once' })
    expect(store.getState().draft).toMatchObject({ mode: 'once', timezone: 'America/New_York', localDate })
  })

  it.each([
    ['Asia/Tokyo', '2099-08-25', '00:30'],
    ['America/Los_Angeles', '2099-08-24', '08:30'],
    ['Asia/Dushanbe', '2099-08-24', '20:30'],
  ])('reopens and unchanged-saves the same Once instant in %s', (zone, date, time) => {
    mockDeviceTimezone(zone)
    const value: ScheduleConfiguration = { mode: 'once', timezone: 'UTC', localDate: '2099-08-24', time: '15:30', enabled: true, policy: 'latest_saved' }
    const { store, schedule } = command(value)
    expect(store.getState().draft).toMatchObject({ timezone: zone, localDate: date, time })
    expect(schedule).toEqual(value)
    store.getState().edit({ time: '01:45', localDate: '2099-08-25' })
    const edited = buildScheduleCommand(scope, store.getState(), now)
    expect(edited.command?.input).toMatchObject({ schedule: { timezone: 'UTC' } })
    if (edited.command?.kind !== 'save') throw new Error('Expected save')
    const reopened = createDraft(edited.command.input.schedule)
    expect(reopened).toMatchObject({ localDate: '2099-08-25', time: '01:45', timezone: zone })
  })
  it('keeps the later DST fold instant on unchanged save', () => {
    mockDeviceTimezone('America/New_York')
    const value: ScheduleConfiguration = { mode: 'once', timezone: 'UTC', localDate: '2026-11-01', time: '06:30', enabled: true, policy: 'latest_saved' }
    const { store, schedule } = command(value)
    expect(store.getState().draft?.time).toBe('01:30')
    expect(schedule).toEqual(value)
  })
  it('resolves a newly entered gap through the shared scheduler rule', () => {
    mockDeviceTimezone('America/New_York')
    const store = createScheduleEditorStore()
    store.getState().initialize(null, 0)
    store.getState().edit({ mode: 'once', localDate: '2027-03-14', time: '02:30' })
    const result = buildScheduleCommand(scope, store.getState(), now)
    expect(result.command?.input).toMatchObject({ schedule: { mode: 'once', timezone: 'UTC', localDate: '2027-03-14', time: '07:30' } })
  })
  it('preserves an untouched foreign-zone Weekly across viewing, enabled edits and saves', () => {
    mockDeviceTimezone('Asia/Tokyo')
    const value: WorkflowSchedule = { ...scope, mode: 'weekly', weekdays: [1, 3], time: '23:30', timezone: 'America/New_York', enabled: true,
      policy: 'latest_saved', revision: 3, nextOccurrenceAt: '2026-10-06T03:30:00.000Z' }
    const { store, schedule } = command(value)
    expect(store.getState().draft).toMatchObject({ timezone: 'Asia/Tokyo', weekdays: [2, 4], time: '12:30' })
    expect(schedule).toMatchObject({ timezone: value.timezone, weekdays: value.weekdays, time: value.time })
    expect(nextOccurrences(schedule, now, 3)).toEqual(nextOccurrences(value, now, 3))
    store.getState().edit({ enabled: false })
    expect(buildScheduleCommand(scope, store.getState(), now).command?.kind).toBe('disable')
    store.getState().edit({ enabled: true, time: '13:15' })
    const edited = buildScheduleCommand(scope, store.getState(), now)
    expect(edited.command?.input).toMatchObject({ schedule: { timezone: 'Asia/Tokyo', weekdays: [2, 4], time: '13:15' } })
  })
  it('keeps source-zone DST gap intent in that device zone', () => {
    mockDeviceTimezone('America/New_York')
    const value: ScheduleConfiguration = { mode: 'weekly', weekdays: [7], time: '02:30', timezone: 'America/New_York', enabled: true, policy: 'latest_saved' }
    expect(createDraft(value).time).toBe('02:30')
  })
  it.each(['second', 'minute', 'hour'] as const)('uses exact UTC elapsed anchors for %s intervals', (unit) => {
    mockDeviceTimezone('Asia/Tokyo')
    const store = createScheduleEditorStore()
    store.getState().initialize(null, 0)
    store.getState().edit({ mode: 'interval', every: '2', unit })
    const result = buildScheduleCommand(scope, store.getState(), now)
    expect(result.command?.input).toMatchObject({ schedule: { unit, anchorAt: new Date(Date.parse(now) + 2 * (unit === 'second' ? 1_000 : unit === 'minute' ? 60_000 : 3_600_000)).toISOString() } })
  })
})
