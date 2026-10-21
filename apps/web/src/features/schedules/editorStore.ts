import { createStore } from 'zustand/vanilla'
import { ZodError } from 'zod'
import {
  nextOccurrences, parseScheduleSaveInput, scheduleLocalTimeToUtc, scheduleUtcToLocalTime, ScheduleSaveInputSchema,
  ScheduleTimeZoneSchema,
  type ScheduleConfiguration, type ScheduleGetInput, type WorkflowSchedule,
} from '@foreman-code/contracts/schedules'
import type { NewScheduleCommand } from './queries'

export type ScheduleMode = ScheduleConfiguration['mode']
/** Form strings deliberately admit incomplete/invalid input; this is not an API shape. */
export interface ScheduleDraft {
  mode: ScheduleMode
  weekdays: number[]
  time: string
  every: string
  unit: Extract<ScheduleConfiguration, { mode: 'interval' }>['unit']
  anchorAt?: string
  onceInstant?: string
  // Original calendar intent plus its displayed comparison token, not a server cache.
  weeklyOriginal?: Extract<ScheduleConfiguration, { mode: 'weekly' }>
  weeklyLocalIdentity?: string
  localDate: string
  timezone: string
  enabled: boolean
}
export type DraftErrors = Partial<Record<'weekdays' | 'time' | 'every' | 'localDate' | 'timezone' | 'form', string>>

export function browserTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return ScheduleTimeZoneSchema.safeParse(zone).success ? zone : 'UTC'
  } catch { return 'UTC' }
}
function tomorrow(timeZone: string): string {
  const { localDate } = scheduleUtcToLocalTime(new Date().toISOString(), timeZone)
  const date = new Date(`${localDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + 1)
  return date.toISOString().slice(0, 10)
}
export function createDraft(value: ScheduleConfiguration | WorkflowSchedule | null): ScheduleDraft {
  const timezone = browserTimezone()
  const onceInstant = value?.mode === 'once' ? scheduleLocalTimeToUtc(value.localDate, value.time, value.timezone) : undefined
  const onceLocal = onceInstant ? scheduleUtcToLocalTime(onceInstant, timezone) : undefined
  let weeklyLocal: { time: string; weekdays: number[] } | undefined
  if (value?.mode === 'weekly' && value.timezone !== timezone) {
    const instant = ('nextOccurrenceAt' in value ? value.nextOccurrenceAt : null)
      ?? nextOccurrences({ ...value, enabled: true }, new Date().toISOString(), 1)[0]
    if (instant) {
      const source = scheduleUtcToLocalTime(instant, value.timezone)
      const local = scheduleUtcToLocalTime(instant, timezone)
      const dayShift = Math.round((Date.parse(`${local.localDate}T00:00:00Z`) - Date.parse(`${source.localDate}T00:00:00Z`)) / 86_400_000)
      weeklyLocal = { time: local.time, weekdays: value.weekdays.map((day) => ((day - 1 + dayShift + 7) % 7) + 1).sort((a, b) => a - b) }
    }
  }
  const days = weeklyLocal?.weekdays ?? (value?.mode === 'weekly' ? [...value.weekdays].sort((a, b) => a - b) : [1, 2, 3, 4, 5])
  const time = weeklyLocal?.time ?? (value?.mode === 'weekly' ? value.time : onceLocal?.time ?? '09:00')
  return {
    mode: value?.mode ?? 'weekly', timezone, enabled: value?.enabled ?? true,
    weekdays: days, time,
    every: value?.mode === 'interval' ? String(value.every) : '1',
    unit: value?.mode === 'interval' ? value.unit : 'hour',
    anchorAt: value?.mode === 'interval' ? value.anchorAt : undefined,
    onceInstant,
    weeklyOriginal: value?.mode === 'weekly' ? { mode: value.mode, timezone: value.timezone, weekdays: [...value.weekdays], time: value.time,
      enabled: value.enabled, policy: value.policy } : undefined,
    weeklyLocalIdentity: value?.mode === 'weekly' ? weeklySettingsIdentity(days, time) : undefined,
    localDate: onceLocal?.localDate ?? tomorrow(timezone),
  }
}

function weeklySettingsIdentity(days: number[], time: string): string {
  return JSON.stringify({ weekdays: [...days].sort((a, b) => a - b), time })
}

export function weeklyCalendarChanged(draft: ScheduleDraft): boolean {
  return draft.weeklyLocalIdentity !== weeklySettingsIdentity(draft.weekdays, draft.time)
}

/** Ignore inactive tab fields; changing tabs back does not manufacture a settings edit. */
export function draftIdentity(draft: ScheduleDraft, includeEnabled = true): string {
  const common = { mode: draft.mode, timezone: draft.timezone, ...(includeEnabled ? { enabled: draft.enabled } : {}) }
  return JSON.stringify(draft.mode === 'weekly' ? { ...common, weekdays: [...draft.weekdays].sort((a, b) => a - b), time: draft.time }
    : draft.mode === 'once' ? { ...common, localDate: draft.localDate, time: draft.time }
      : { ...common, every: draft.every, unit: draft.unit, anchorAt: draft.anchorAt })
}

interface EditorState {
  open: boolean
  draft: ScheduleDraft | null
  // These are draft comparison/optimistic-concurrency tokens, not another server cache.
  initialIdentity: string
  initialSettings: string
  expectedRevision: number
  errors: DraftErrors
  show(): void
  hide(): void
  initialize(value: ScheduleConfiguration | null, revision: number): void
  edit(patch: Partial<ScheduleDraft>): void
  setErrors(errors: DraftErrors): void
  resetDraft(): void
}
export function createScheduleEditorStore() {
  return createStore<EditorState>((set) => ({
    open: false, draft: null, initialIdentity: '', initialSettings: '', expectedRevision: 0, errors: {},
    show: () => set({ open: true, draft: null, errors: {} }),
    hide: () => set({ open: false, draft: null, errors: {} }),
    initialize: (value, revision) => {
      const draft = createDraft(value)
      set({ draft, expectedRevision: revision, initialIdentity: draftIdentity(draft), initialSettings: draftIdentity(draft, false), errors: {} })
    },
    edit: (patch) => set((state) => ({ draft: state.draft ? { ...state.draft, ...patch } : null, errors: {} })),
    setErrors: (errors) => set({ errors }),
    resetDraft: () => set({ draft: null, errors: {} }),
  }))
}
export type ScheduleEditorStore = ReturnType<typeof createScheduleEditorStore>

export function buildScheduleCommand(
  scope: ScheduleGetInput, state: Pick<EditorState, 'draft' | 'initialIdentity' | 'initialSettings' | 'expectedRevision'>,
  nowUtc = new Date().toISOString(),
): { command: NewScheduleCommand; errors?: never } | { errors: DraftErrors; command?: never } {
  const { draft, expectedRevision } = state
  if (!draft) return { errors: { form: 'Load schedule first.' } }
  // Disabling the unchanged record must also work for an exhausted/past Once.
  if (expectedRevision > 0 && !draft.enabled && draftIdentity(draft, false) === state.initialSettings) {
    return { command: { kind: 'disable', input: { ...scope, expectedRevision } } }
  }
  const common = { timezone: draft.timezone, enabled: draft.enabled, policy: 'latest_saved' as const }
  const every = /^\d+$/.test(draft.every) ? Number(draft.every) : NaN
  if (draft.mode === 'interval' && (!Number.isSafeInteger(every) || every < 1)) {
    return { errors: { every: 'Use a whole number ≥ 1.' } }
  }
  const newAnchor = Date.parse(nowUtc) + every * (draft.unit === 'second' ? 1_000 : draft.unit === 'minute' ? 60_000 : 3_600_000)
  if (draft.mode === 'interval' && !draft.anchorAt && (!Number.isFinite(newAnchor) || newAnchor > Date.parse('9999-12-31T23:59:59.999Z'))) {
    return { errors: { every: 'Interval is too large.' } }
  }
  try {
    // A saved instant can be the later side of a DST overlap. An unchanged local
    // display must retain that exact instant rather than resolve the earlier fold.
    const originalOnce = draft.onceInstant ? scheduleUtcToLocalTime(draft.onceInstant, draft.timezone) : null
    const onceAt = draft.mode === 'once' ? originalOnce?.localDate === draft.localDate && originalOnce.time === draft.time
      ? draft.onceInstant! : scheduleLocalTimeToUtc(draft.localDate, draft.time, draft.timezone) : null
    const onceUtc = onceAt ? scheduleUtcToLocalTime(onceAt, 'UTC') : null
    const schedule = draft.mode === 'weekly' ? draft.weeklyOriginal && !weeklyCalendarChanged(draft)
      ? { ...draft.weeklyOriginal, enabled: draft.enabled }
      : { ...common, mode: draft.mode, weekdays: draft.weekdays, time: draft.time }
      : draft.mode === 'once' ? { ...common, mode: draft.mode, timezone: 'UTC', localDate: onceUtc!.localDate, time: onceUtc!.time }
        : { ...common, mode: draft.mode, every, unit: draft.unit, anchorAt: draft.anchorAt ?? new Date(newAnchor).toISOString() }
    // This browser clock is only an early validation hint. The service validates its
    // own clock, after replay lookup. No occurrence preview is presented as server truth.
    const input = {
      ...scope, expectedRevision, commandId: 'schedule-validation', schedule,
    }
    const unchangedOnce = expectedRevision > 0 && draft.mode === 'once'
      && draftIdentity(draft, false) === state.initialSettings
    const parsed = unchangedOnce ? ScheduleSaveInputSchema.parse(input) : parseScheduleSaveInput(input, nowUtc)
    return { command: { kind: 'save', input: { ...scope, expectedRevision, schedule: parsed.schedule } } }
  } catch (error) {
    if (!(error instanceof ZodError)) return { errors: { form: 'Check schedule.' } }
    const errors: DraftErrors = {}
    for (const issue of error.issues) {
      const field = issue.path[0] === 'schedule' ? issue.path[1] : issue.path[0]
      switch (field) {
        case 'weekdays': errors.weekdays = 'Choose a day.'; break
        case 'time': errors.time = 'Choose a time.'; break
        case 'every': errors.every = 'Use a whole number ≥ 1.'; break
        case 'localDate': errors.localDate = 'Choose a future date and time.'; break
        case 'timezone': errors.timezone = 'Could not read the device timezone.'; break
        default: errors.form = 'Check schedule.'
      }
    }
    return { errors }
  }
}
