import {
  nextOccurrences, scheduleAdmissionDecision,
  type ScheduleAdmissionDecision, type WorkflowSchedule,
} from '@foreman-code/contracts/schedules'

export const SCHEDULE_DISPATCH_BATCH_SIZE = 1_000
export interface DueScheduleStep {
  dueAt: string
  nextDueAt: string | null
  decision: ScheduleAdmissionDecision
}

/** Recovery batches contain immutable missed outcomes and at most one eligible
 * occurrence. Interval arithmetic avoids repeatedly parsing the same recurrence. */
export function planDueSchedule(schedule: WorkflowSchedule, nowUtc: string,
  limit = SCHEDULE_DISPATCH_BATCH_SIZE): DueScheduleStep[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > SCHEDULE_DISPATCH_BATCH_SIZE) {
    throw new RangeError(`Schedule dispatch batch size must be between 1 and ${SCHEDULE_DISPATCH_BATCH_SIZE}.`)
  }
  const due = schedule.nextOccurrenceAt
  if (!schedule.enabled || due === null || Date.parse(due) > Date.parse(nowUtc)) return []
  const result: DueScheduleStep[] = []
  const duration = schedule.mode === 'interval'
    ? schedule.every * ({ second: 1_000, minute: 60_000, hour: 3_600_000 }[schedule.unit]) : undefined
  const intervalNext = duration === undefined ? undefined : nextOccurrences(schedule, due,
    Math.min(limit, Math.floor((Date.parse(nowUtc) - Date.parse(due)) / duration) + 1))
  let dueAt: string | null = due
  for (let index = 0; index < limit && dueAt !== null; index++) {
    if (Date.parse(dueAt) > Date.parse(nowUtc)) break
    const nextDueAt: string | null = intervalNext === undefined
      ? nextOccurrences(schedule, dueAt, 1)[0] ?? null : intervalNext[index] ?? null
    result.push({ dueAt, nextDueAt, decision: scheduleAdmissionDecision({
      dueAt, nowUtc, enabled: true, hasOverlappingScheduledRun: false,
      isLatestDueOccurrence: nextDueAt === null || Date.parse(nextDueAt) > Date.parse(nowUtc),
    }) })
    dueAt = nextDueAt
  }
  return result
}

/** Re-evaluate after every lock/preflight wait. Stored nextOccurrenceAt is not a
 * recurrence input: a later due time supersedes this one even within grace. */
export function decideDueSchedule(schedule: WorkflowSchedule, dueAt: string,
  nowUtc: string, enabled: boolean, hasOverlappingScheduledRun: boolean): ScheduleAdmissionDecision {
  const next = nextOccurrences({ ...schedule, enabled: true }, dueAt, 1)[0]
  return scheduleAdmissionDecision({ dueAt, nowUtc, enabled, hasOverlappingScheduledRun,
    isLatestDueOccurrence: next === undefined || Date.parse(next) > Date.parse(nowUtc) })
}
