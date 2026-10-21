import { optionalCommandId } from './management/commands.js'
import { z } from "zod";
import { IdSchema, TimestampSchema } from "./schemaPrimitives.js";

/** Product policy, not caller-configurable options. Admission still needs a transaction. */
export const SCHEDULE_DEFAULTS = Object.freeze({
  policy: "latest_saved",
  gracePeriodMs: 5 * 60 * 1_000,
  backfill: false,
  recovery: "latest_due_only",
  overlap: "skip",
  disabling: "future_admissions_only",
  workflowVersion: "pin_on_acceptance",
} as const);
export const MAX_SCHEDULE_PREVIEW_OCCURRENCES = 1_000;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MIN_INSTANT = Date.parse("0001-01-01T00:00:00.000Z");
const MAX_INSTANT = Date.parse("9999-12-31T23:59:59.999Z");
const Revision = z.number().int().nonnegative();
const Command = z.string().trim().min(8).max(200);
const Workflow = { workspaceId: IdSchema, workflowId: IdSchema };
const Mutation = { commandId: optionalCommandId(Command), expectedRevision: Revision };

/** Millisecond precision; normalize offsets before comparing or forming identities. */
export const ScheduleInstantSchema = TimestampSchema.refine((value) => {
  const instant = Date.parse(value);
  return !/\.\d{4}/.test(value) && instant >= MIN_INSTANT && instant <= MAX_INSTANT;
}, "Use a valid instant in years 0001–9999 with at most millisecond precision")
  // overwrite (not transform) keeps the schema JSON-Schema representable for MCP tools.
  .overwrite((value) => { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toISOString() });
export const ScheduleTimeZoneSchema = z.string().min(1).max(255).refine((value) => {
  // Require a named Area/Location (including slash-form links), UTC or GMT.
  // Intl also accepts ambiguous compatibility abbreviations and, on newer engines, numeric offsets.
  if (!/^(?:UTC|GMT|[A-Za-z_]+(?:\/[A-Za-z0-9._+-]+)+)$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}, "Use a supported IANA Area/Location identifier, UTC or GMT")
  .describe("Required source calendar timezone for weekly/local Once input. Use the caller device's IANA zone; anchorAt and occurrence instants are UTC, independent of the server timezone.");
export const ScheduleTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const ScheduleLocalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return instant >= MIN_INSTANT && instant <= MAX_INSTANT
    && new Date(instant).toISOString().slice(0, 10) === value;
}, "Use a real Gregorian date in YYYY-MM-DD form (years 0001–9999)");

/** The same calendar/DST rule used by the scheduler, independent of the device's clock. */
export function scheduleLocalTimeToUtc(localDate: string, time: string, timezone: string): string {
  const value = z.object({ localDate: ScheduleLocalDateSchema, time: ScheduleTimeSchema, timezone: ScheduleTimeZoneSchema })
    .parse({ localDate, time, timezone });
  return ScheduleInstantSchema.parse(new Date(resolveWallTime(localTimestamp(value.localDate, value.time), formatter(value.timezone))).toISOString());
}

/** Format a persisted instant for a device without changing its schedule meaning. */
export function scheduleUtcToLocalTime(instant: string, timezone: string): { localDate: string; time: string } {
  const utc = ScheduleInstantSchema.parse(instant);
  const zone = ScheduleTimeZoneSchema.parse(timezone);
  const parts = formatter(zone).formatToParts(new Date(utc));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)?.value ?? "";
  return { localDate: `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}` };
}

const Settings = {
  timezone: ScheduleTimeZoneSchema,
  enabled: z.boolean(),
  policy: z.literal("latest_saved"),
};
const Weekly = z.object({
  ...Settings, mode: z.literal("weekly"),
  /** ISO weekdays: Monday = 1, Sunday = 7. Order is immaterial; duplicates are errors. */
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7)
    .refine((days) => new Set(days).size === days.length, "Weekdays must be unique"),
  time: ScheduleTimeSchema,
}).strict();
const Interval = z.object({
  ...Settings, mode: z.literal("interval"), every: z.number().int().min(1),
  unit: z.enum(["second", "minute", "hour"]), anchorAt: ScheduleInstantSchema,
}).strict();
const Once = z.object({
  ...Settings, mode: z.literal("once"), localDate: ScheduleLocalDateSchema, time: ScheduleTimeSchema,
}).strict();

/** Editable settings only. The client cannot pin a version or supply revision/nextOccurrenceAt. */
export const ScheduleConfigurationSchema = z.discriminatedUnion("mode", [Weekly, Interval, Once]);
export type ScheduleConfiguration = z.infer<typeof ScheduleConfigurationSchema>;

/** Normalize a newly saved one-off instant; weekly source-calendar metadata remains intact. */
export function scheduleConfigurationToUtc(value: ScheduleConfiguration): ScheduleConfiguration {
  if (value.mode !== "once") return value;
  const instant = scheduleLocalTimeToUtc(value.localDate, value.time, value.timezone);
  // Historical IANA offsets can contain seconds. Retain source components when
  // the minute-only calendar contract cannot express the exact UTC instant.
  if (!instant.endsWith(":00.000Z")) return value;
  const utc = scheduleUtcToLocalTime(instant, "UTC");
  return { ...value, ...utc, timezone: "UTC" };
}
const RecordFields = {
  ...Workflow, revision: z.number().int().positive(), nextOccurrenceAt: ScheduleInstantSchema.nullable(),
};
/** One record per (workspaceId, workflowId); revision 0 denotes absence, never a saved row. */
export const WorkflowScheduleSchema = z.discriminatedUnion("mode", [
  Weekly.extend(RecordFields).strict(), Interval.extend(RecordFields).strict(), Once.extend(RecordFields).strict(),
]).refine((value) => value.enabled || value.nextOccurrenceAt === null, {
  path: ["nextOccurrenceAt"], message: "A disabled schedule has no next occurrence",
});
export type WorkflowSchedule = z.infer<typeof WorkflowScheduleSchema>;

export const ScheduleGetInputSchema = z.object({ ...Workflow }).strict();
export const ScheduleGetResultSchema = z.object({ schedule: WorkflowScheduleSchema.nullable() }).strict();
export const ScheduleSaveInputSchema = z.object({
  ...Workflow, ...Mutation, schedule: ScheduleConfigurationSchema,
}).strict();
export const ScheduleSaveResultSchema = z.object({ value: WorkflowScheduleSchema, replayed: z.boolean() }).strict();
export const ScheduleDisableInputSchema = z.object({ ...Workflow, ...Mutation }).strict();
export const ScheduleDisableResultSchema = ScheduleSaveResultSchema.refine((result) => !result.value.enabled, {
  path: ["value", "enabled"], message: "Disable must return the disabled persisted schedule",
});
export type ScheduleGetInput = z.infer<typeof ScheduleGetInputSchema>;
export type ScheduleGetResult = z.infer<typeof ScheduleGetResultSchema>;
export type ScheduleSaveInput = z.infer<typeof ScheduleSaveInputSchema>;
export type ScheduleSaveResult = z.infer<typeof ScheduleSaveResultSchema>;
export type ScheduleDisableInput = z.infer<typeof ScheduleDisableInputSchema>;

/** Required for a NEW save, after idempotent replay lookup. Never use a caller-supplied clock.
 * Reads and replays must continue to validate after a once schedule's date has passed. */
export function parseScheduleSaveInput(input: unknown, nowUtc: string): ScheduleSaveInput {
  const now = Date.parse(ScheduleInstantSchema.parse(nowUtc));
  return ScheduleSaveInputSchema.superRefine(({ schedule }, context) => {
    if (schedule.mode !== "once" || !ScheduleConfigurationSchema.safeParse(schedule).success) return;
    const due = resolveWallTime(localTimestamp(schedule.localDate, schedule.time), formatter(schedule.timezone));
    if (due <= now || due < MIN_INSTANT || due > MAX_INSTANT) {
      context.addIssue({ code: "custom", path: ["schedule", "localDate"],
        message: "A once schedule must resolve to a future supported instant" });
    }
  }).parse(input);
}

/** Collision-free, opaque identity. Revision and workflow version deliberately do not participate. */
export function scheduleOccurrenceId(workflowId: string, dueAt: string): string {
  return occurrenceIdentity(IdSchema.parse(workflowId), ScheduleInstantSchema.parse(dueAt));
}
function occurrenceIdentity(workflowId: string, canonicalDueAt: string): string {
  return `schedule:v1:${JSON.stringify([workflowId, canonicalDueAt])}`;
}
const Occurrence = {
  ...Workflow, id: IdSchema, dueAt: ScheduleInstantSchema, scheduleRevision: z.number().int().positive(),
};
export const ScheduleOccurrenceSchema = z.discriminatedUnion("status", [
  z.object({ ...Occurrence, status: z.literal("accepted"), reason: z.null(),
    workflowVersionId: IdSchema, runId: IdSchema }).strict(),
  z.object({ ...Occurrence, status: z.literal("skipped"), reason: z.enum(["overlap", "disabled"]) }).strict(),
  z.object({ ...Occurrence, status: z.literal("missed"), reason: z.enum(["outside_grace", "superseded"]) }).strict(),
  z.object({ ...Occurrence, status: z.literal("rejected"), reason: z.string().trim().min(1).max(200) }).strict(),
]).refine((value) => value.id === occurrenceIdentity(value.workflowId, value.dueAt), {
  path: ["id"], message: "Occurrence id must identify exactly (workflowId, dueAt)",
}).readonly();
export type ScheduleOccurrence = z.infer<typeof ScheduleOccurrenceSchema>;

export const MAX_OCCURRENCE_PAGE_SIZE = 100;
export const ScheduleOccurrenceListInputSchema = ScheduleGetInputSchema.extend({
  cursor: z.string().trim().min(1).max(4096).optional(),
  limit: z.number().int().min(1).max(MAX_OCCURRENCE_PAGE_SIZE).default(50),
}).strict();
export const ScheduleOccurrencePageSchema = z.object({
  items: z.array(ScheduleOccurrenceSchema).max(MAX_OCCURRENCE_PAGE_SIZE),
  pageInfo: z.object({ nextCursor: z.string().min(1).max(4096).nullable() }).strict(),
}).strict();
export type ScheduleOccurrenceListInput = z.infer<typeof ScheduleOccurrenceListInputSchema>;
export type ScheduleOccurrencePage = z.infer<typeof ScheduleOccurrencePageSchema>;

const AdmissionInput = z.object({
  dueAt: ScheduleInstantSchema, nowUtc: ScheduleInstantSchema,
  enabled: z.boolean(), hasOverlappingScheduledRun: z.boolean(),
  /** On recovery, all earlier backlog entries are missed, even if still inside the grace window. */
  isLatestDueOccurrence: z.boolean(),
}).strict();
type ScheduleAdmissionInput = z.infer<typeof AdmissionInput>;
export type ScheduleAdmissionDecision =
  | { status: "not_due" }
  | { status: "eligible" }
  | { status: "missed"; reason: "outside_grace" | "superseded" }
  | { status: "skipped"; reason: "disabled" | "overlap" };

/** Pure eligibility only: no admission, cancellation, Run creation, or version pinning occurs here. */
export function scheduleAdmissionDecision(input: ScheduleAdmissionInput): ScheduleAdmissionDecision {
  const value = AdmissionInput.parse(input);
  const lateness = Date.parse(value.nowUtc) - Date.parse(value.dueAt);
  if (lateness < 0) return { status: "not_due" };
  if (lateness > SCHEDULE_DEFAULTS.gracePeriodMs) return { status: "missed", reason: "outside_grace" };
  if (!value.isLatestDueOccurrence) return { status: "missed", reason: "superseded" };
  if (!value.enabled) return { status: "skipped", reason: "disabled" };
  if (value.hasOverlappingScheduledRun) return { status: "skipped", reason: "overlap" };
  return { status: "eligible" };
}

const PreviewSchedule = z.union([ScheduleConfigurationSchema, WorkflowScheduleSchema]);
const PreviewCount = z.number().int().min(0).max(MAX_SCHEDULE_PREVIEW_OCCURRENCES);
/** Sorted, distinct UTC instants strictly AFTER fromUtc; disabled/exhausted schedules return [].
 * Intervals are anchorAt + k * duration (k >= 0), not wall-clock repetitions. No implicit clock.
 * nextOccurrenceAt is a service-owned cursor, not an input to the recurrence calculation. */
export function nextOccurrences(
  schedule: ScheduleConfiguration | WorkflowSchedule, fromUtc: string, n: number,
): string[] {
  const value = PreviewSchedule.parse(schedule);
  const from = Date.parse(ScheduleInstantSchema.parse(fromUtc));
  const count = PreviewCount.parse(n);
  return occurrenceInstants(value, from, count).map((instant) => new Date(instant).toISOString());
}

function occurrenceInstants(schedule: ScheduleConfiguration, from: number, count: number): number[] {
  if (!schedule.enabled || count === 0) return [];
  if (schedule.mode === "interval") {
    const anchor = Date.parse(schedule.anchorAt);
    const step = schedule.every * (schedule.unit === "second" ? 1_000 : schedule.unit === "minute" ? MINUTE_MS : HOUR_MS);
    const first = Math.max(0, Math.floor((from - anchor) / step) + 1);
    const result: number[] = [];
    for (let index = 0; index < count; index++) {
      const due = anchor + (first + index) * step;
      if (due > MAX_INSTANT) break;
      result.push(due);
    }
    return result;
  }
  const zone = formatter(schedule.timezone);
  if (schedule.mode === "once") {
    const due = resolveWallTime(localTimestamp(schedule.localDate, schedule.time), zone);
    return due > from && due <= MAX_INSTANT ? [due] : [];
  }
  const wallFrom = wallTimeAt(from, zone);
  // A whole local date can be skipped (e.g. Apia). Include yesterday's shifted occurrence.
  let day = Math.floor(wallFrom / DAY_MS) * DAY_MS - DAY_MS;
  day = Math.max(day, MIN_INSTANT);
  const [hour, minute] = schedule.time.split(":").map(Number);
  const timeOfDay = (hour ?? 0) * HOUR_MS + (minute ?? 0) * MINUTE_MS;
  const result: number[] = [];
  while (result.length < count && day <= MAX_INSTANT) {
    const weekday = ((new Date(day).getUTCDay() + 6) % 7) + 1;
    if (schedule.weekdays.includes(weekday)) {
      const due = resolveWallTime(day + timeOfDay, zone);
      if (due > from && due <= MAX_INSTANT && due !== result[result.length - 1]) result.push(due);
    }
    day += DAY_MS;
  }
  return result;
}

function localTimestamp(localDate: string, time: string): number {
  return Date.parse(`${localDate}T${time}:00.000Z`);
}
function formatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone, calendar: "iso8601", numberingSystem: "latn", hourCycle: "h23",
    era: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
/** Interpret displayed local components as UTC solely for wall-time arithmetic. */
function wallTimeAt(instant: number, zone: Intl.DateTimeFormat): number {
  const parts = zone.formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const displayedYear = read("year");
  const year = parts.find((part) => part.type === "era")?.value === "BC" ? 1 - displayedYear : displayedYear;
  // Date.UTC treats years 0..99 as 1900..1999; setUTCFullYear does not.
  const date = new Date(0);
  date.setUTCFullYear(year, read("month") - 1, read("day"));
  date.setUTCHours(read("hour"), read("minute"), read("second"), ((instant % 1_000) + 1_000) % 1_000);
  return date.getTime();
}
/** Compatible disambiguation: earliest exact match for a fold; shift by the gap otherwise.
 * Sample adjacent offsets, not a hardcoded one-hour DST correction. The +/-48h window
 * also covers date-line jumps and zones whose offset is far from UTC. Uses runtime IANA data. */
function resolveWallTime(wall: number, zone: Intl.DateTimeFormat): number {
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = wall + hours * HOUR_MS;
    offsets.add(wallTimeAt(sample, zone) - sample);
  }
  const candidates = [...offsets].map((offset) => wall - offset).sort((left, right) => left - right);
  const exact = candidates.find((instant) => wallTimeAt(instant, zone) === wall);
  if (exact !== undefined) return exact;
  const shifted = candidates.map((instant) => ({ instant, local: wallTimeAt(instant, zone) }))
    .filter((candidate) => candidate.local > wall)
    .sort((left, right) => left.local - right.local || left.instant - right.instant)[0];
  if (!shifted) throw new RangeError("Cannot resolve local time with this runtime's IANA data");
  return shifted.instant;
}
