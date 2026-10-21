import { describe, expect, it } from "vitest";
import { z } from "zod";
import { WorkflowTriggerSchema } from "./management/extensions.js";
import {
  MAX_SCHEDULE_PREVIEW_OCCURRENCES, SCHEDULE_DEFAULTS,
  ScheduleConfigurationSchema, ScheduleDisableInputSchema, ScheduleDisableResultSchema,
  ScheduleGetInputSchema, ScheduleGetResultSchema, ScheduleInstantSchema,
  ScheduleLocalDateSchema, ScheduleOccurrenceListInputSchema, ScheduleOccurrencePageSchema, ScheduleOccurrenceSchema,
  ScheduleSaveInputSchema, ScheduleSaveResultSchema,
  ScheduleTimeSchema, ScheduleTimeZoneSchema, WorkflowScheduleSchema,
  nextOccurrences, parseScheduleSaveInput, scheduleAdmissionDecision, scheduleOccurrenceId,
  type ScheduleConfiguration,
} from "./schedules.js";

const scope = { workspaceId: "workspace-1", workflowId: "workflow-1" };
const settings = { timezone: "UTC", enabled: true, policy: "latest_saved" as const };
const weekly = { ...settings, mode: "weekly" as const, weekdays: [1, 5], time: "09:00" };
const interval = { ...settings, mode: "interval" as const, every: 30, unit: "minute" as const,
  anchorAt: "2026-01-01T00:00:00.000Z" };
const once = { ...settings, mode: "once" as const, localDate: "2026-09-29", time: "09:00" };
const clock = "2026-09-28T10:00:00.000Z";
const save = (schedule: ScheduleConfiguration) => ({ ...scope, commandId: "save-command-1", expectedRevision: 0, schedule });
const record = { ...scope, ...weekly, revision: 1, nextOccurrenceAt: "2026-10-02T09:00:00.000Z" };
const dueAt = "2026-09-28T10:00:00.000Z";
const occurrence = { ...scope, id: scheduleOccurrenceId(scope.workflowId, dueAt), dueAt, scheduleRevision: 1 };
const accepted = { ...occurrence, status: "accepted" as const, reason: null,
  workflowVersionId: "workflow-version-at-admission", runId: "run-1" };
const admission = { dueAt, nowUtc: dueAt, enabled: true, hasOverlappingScheduledRun: false, isLatestDueOccurrence: true };

function without(input: object, key: string) {
  return Object.fromEntries(Object.entries(input).filter(([name]) => name !== key));
}

describe("SCH-02 schedule contracts", () => {
  it("shares bounded, strict occurrence paging across UI, HTTP and MCP", () => {
    expect(ScheduleOccurrenceListInputSchema.parse(scope)).toEqual({ ...scope, limit: 50 });
    expect(ScheduleOccurrenceListInputSchema.parse({ ...scope, limit: 1 })).toEqual({ ...scope, limit: 1 });
    for (const limit of [0, 101, 1.5, "1"]) {
      expect(ScheduleOccurrenceListInputSchema.safeParse({ ...scope, limit }).success).toBe(false);
    }
    const items = [accepted, { ...occurrence, status: "rejected", reason: "workflow_not_executable" }];
    const page = { items, pageInfo: { nextCursor: "workflow-bound-cursor" } };
    expect(ScheduleOccurrencePageSchema.parse(page)).toEqual(page);
    expect(ScheduleOccurrencePageSchema.safeParse({ ...page, items: Array.from({ length: 101 }, () => accepted) }).success)
      .toBe(false);
    expect(ScheduleOccurrencePageSchema.safeParse({ ...page, pageInfo: {} }).success).toBe(false);
  });

  it.each([weekly, interval, once])("accepts the $mode configuration", (configuration) => {
    expect(ScheduleConfigurationSchema.parse(configuration)).toEqual(configuration);
    expect(ScheduleSaveInputSchema.parse(save(configuration)).schedule).toEqual(configuration);
  });

  it.each([[], [0], [8], [1.5], [1, 1], [1, 2, 3, 4, 5, 6, 7, 1]].map((days) => ({ days })))("rejects invalid weekdays $days", ({ days }) => {
    expect(ScheduleConfigurationSchema.safeParse({ ...weekly, weekdays: days }).success).toBe(false);
  });
  it.each(["9:00", "24:00", "12:60", "12:00:00", " 12:00", "12:00 ", "-1:00"])("rejects time %s", (time) => {
    expect(ScheduleTimeSchema.safeParse(time).success).toBe(false);
  });
  it.each(["00:00", "09:05", "23:59"])("accepts time %s", (time) => {
    expect(ScheduleTimeSchema.parse(time)).toBe(time);
  });
  it.each(["UTC", "GMT", "Asia/Dushanbe", "America/New_York", "US/Eastern", "Australia/Lord_Howe", "Etc/GMT+5"])("accepts IANA zone %s", (timezone) => {
    expect(ScheduleTimeZoneSchema.parse(timezone)).toBe(timezone);
  });
  it.each(["", "Mars/Olympus", "CST", "PST", "+05:00", "-0330", "05:00", " UTC "])("rejects non-IANA zone %s", (timezone) => {
    expect(ScheduleTimeZoneSchema.safeParse(timezone).success).toBe(false);
  });
  it.each(["2026-02-29", "2026-02-30", "1900-02-29", "2026-04-31", "2026-13-01", "2026-00-01", "2026-01-00",
    "26-01-01", "2026-1-01", "0000-01-01", "10000-01-01"])("rejects invalid local date %s", (localDate) => {
    expect(ScheduleLocalDateSchema.safeParse(localDate).success).toBe(false);
    expect(() => parseScheduleSaveInput(save({ ...once, localDate }), clock)).toThrow(z.ZodError);
  });
  it.each(["2000-02-29", "2028-02-29", "0001-01-01", "0099-12-31", "9999-12-31"])("accepts real local date %s", (localDate) => {
    expect(ScheduleLocalDateSchema.parse(localDate)).toBe(localDate);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects interval every=%s", (every) => {
    expect(ScheduleConfigurationSchema.safeParse({ ...interval, every }).success).toBe(false);
  });
  it("requires supported units, an absolute anchor and an explicit fixed policy", () => {
    for (const change of [{ unit: "day" }, { anchorAt: "2026-01-01T00:00:00" }, { policy: "pinned" }]) {
      expect(ScheduleConfigurationSchema.safeParse({ ...interval, ...change }).success).toBe(false);
    }
    expect(ScheduleConfigurationSchema.safeParse(without(interval, "policy")).success).toBe(false);
    expect(ScheduleConfigurationSchema.safeParse(without(interval, "anchorAt")).success).toBe(false);
    expect(ScheduleInstantSchema.parse("2026-01-01T05:00:00+05:00")).toBe(interval.anchorAt);
    expect(ScheduleInstantSchema.safeParse("2026-01-01T00:00:00.0001Z").success).toBe(false);
  });

  it("gets one workflow-owned schedule or absence, with no caller-allocated schedule id", () => {
    expect(ScheduleGetInputSchema.parse(scope)).toEqual(scope);
    expect(ScheduleGetResultSchema.parse({ schedule: null })).toEqual({ schedule: null });
    expect(ScheduleGetResultSchema.parse({ schedule: record }).schedule).toEqual(record);
    expect(ScheduleGetInputSchema.safeParse({ workflowId: scope.workflowId }).success).toBe(false);
    expect(ScheduleGetInputSchema.safeParse({ ...scope, scheduleId: "second-schedule" }).success).toBe(false);
    expect(WorkflowScheduleSchema.safeParse({ ...record, revision: 0 }).success).toBe(false);
  });
  it("generates omitted command IDs and validates supplied mutation metadata", () => {
    for (const input of [save(weekly), { ...scope, commandId: "disable-command-1", expectedRevision: 1 }]) {
      const schema = "schedule" in input ? ScheduleSaveInputSchema : ScheduleDisableInputSchema;
      expect(schema.safeParse(input).success).toBe(true);
      const generated = schema.parse(without(input, "commandId"));
      expect(generated.commandId).toMatch(/^[0-9a-f-]{36}$/);
      expect(generated).toEqual({ ...input, commandId: generated.commandId });
      expect(schema.parse(input)).toEqual(input);
      for (const field of ["expectedRevision", "workspaceId", "workflowId"]) {
        expect(schema.safeParse(without(input, field)).success).toBe(false);
      }
      for (const commandId of ["short", " ", "x".repeat(201)]) {
        expect(schema.safeParse({ ...input, commandId }).success).toBe(false);
      }
      for (const expectedRevision of [-1, 0.5, "1"]) {
        expect(schema.safeParse({ ...input, expectedRevision }).success).toBe(false);
      }
      expect(schema.safeParse({ ...input, commandId: "  12345678  ", expectedRevision: 0 }).success).toBe(true);
      expect(schema.safeParse({ ...input, commandId: "x".repeat(200) }).success).toBe(true);
    }
  });
  it("forbids client-supplied versions, next occurrence, revision, or another schedule slot", () => {
    for (const extra of [{ workflowVersionId: "v1" }, { nextOccurrenceAt: clock }, { revision: 3 }, { scheduleId: "second" }]) {
      expect(ScheduleSaveInputSchema.safeParse({ ...save(weekly), ...extra }).success).toBe(false);
      expect(ScheduleSaveInputSchema.safeParse(save({ ...weekly, ...extra })).success).toBe(false);
    }
    expect(ScheduleConfigurationSchema.safeParse({ ...weekly, anchorAt: clock }).success).toBe(false);
  });
  it("uses persisted value/replayed results and a disabled schedule has no next occurrence", () => {
    for (const replayed of [true, false]) {
      expect(ScheduleSaveResultSchema.parse({ value: record, replayed }).value).toEqual(record);
      const disabled = { ...record, enabled: false, nextOccurrenceAt: null, revision: 2 };
      expect(ScheduleDisableResultSchema.parse({ value: disabled, replayed }).value).toEqual(disabled);
    }
    expect(ScheduleSaveResultSchema.safeParse({ value: record }).success).toBe(false);
    expect(ScheduleDisableResultSchema.safeParse({ value: record, replayed: false }).success).toBe(false);
    expect(WorkflowScheduleSchema.safeParse({ ...record, enabled: false }).success).toBe(false);
    expect(WorkflowScheduleSchema.safeParse({ ...scope, ...once, revision: 2, nextOccurrenceAt: null }).success).toBe(true);
  });

  it("rejects past/equal once saves with an injected clock, including disabled saves", () => {
    expect(parseScheduleSaveInput(save(once), clock)).toEqual(save(once));
    for (const enabled of [true, false]) {
      for (const time of ["09:00", "10:00"]) {
        expect(() => parseScheduleSaveInput(save({ ...once, localDate: "2026-09-28", time, enabled }), clock)).toThrow(z.ZodError);
      }
    }
    // Historical readback and an already-recorded idempotent replay do not revalidate wall-clock freshness.
    const old = { ...scope, ...once, revision: 1, nextOccurrenceAt: null };
    expect(ScheduleSaveResultSchema.parse({ value: old, replayed: true }).value).toEqual(old);
    expect(ScheduleSaveInputSchema.parse(save({ ...once, localDate: "2000-01-01" })).schedule.mode).toBe("once");
    expect(() => parseScheduleSaveInput(save(once), "not-an-instant")).toThrow(z.ZodError);
    expect(() => parseScheduleSaveInput(save({ ...once, timezone: "Invalid/Zone" }), clock)).toThrow(z.ZodError);
  });
  it("validates once freshness after gap/fold resolution, never against a second fold instance", () => {
    const gap = { ...once, timezone: "America/New_York", localDate: "2026-03-08", time: "02:30" };
    expect(parseScheduleSaveInput(save(gap), "2026-03-08T07:00:00Z").schedule).toEqual(gap);
    expect(() => parseScheduleSaveInput(save(gap), "2026-03-08T07:30:00Z")).toThrow(z.ZodError);
    const fold = { ...once, timezone: "America/New_York", localDate: "2026-11-01", time: "01:30" };
    expect(parseScheduleSaveInput(save(fold), "2026-11-01T05:00:00Z").schedule).toEqual(fold);
    expect(() => parseScheduleSaveInput(save(fold), "2026-11-01T05:45:00Z")).toThrow(z.ZodError);
  });
  it("leaves the legacy schedule trigger contract unchanged and separate", () => {
    const legacy = { kind: "schedule", startsAt: clock, intervalSeconds: 60 };
    expect(WorkflowTriggerSchema.parse(legacy)).toEqual({ ...legacy, missed: "skip", input: {} });
    expect(WorkflowTriggerSchema.safeParse({ ...legacy, intervalSeconds: 59 }).success).toBe(false);
    expect(WorkflowTriggerSchema.safeParse(weekly).success).toBe(false);
    expect(ScheduleConfigurationSchema.safeParse(legacy).success).toBe(false);
  });
});

describe("pure fixed-clock recurrence previews", () => {
  it("uses Monday=1/Sunday=7, sorted instants, unsorted weekday input and an exclusive boundary", () => {
    const schedule = { ...weekly, weekdays: [7, 1, 5] };
    expect(nextOccurrences(schedule, "2026-09-25T00:00:00Z", 4)).toEqual([
      "2026-09-25T09:00:00.000Z", "2026-09-27T09:00:00.000Z", "2026-09-28T09:00:00.000Z", "2026-10-02T09:00:00.000Z",
    ]);
    expect(nextOccurrences(schedule, "2026-09-25T14:00:00+05:00", 1)).toEqual(["2026-09-27T09:00:00.000Z"]);
    expect(nextOccurrences({ ...weekly, weekdays: [1] }, "2026-12-29T00:00:00Z", 1)).toEqual(["2027-01-04T09:00:00.000Z"]);
  });
  it("uses anchor + nonnegative multiples, including the anchor only when it is future", () => {
    expect(nextOccurrences(interval, "2025-12-31T23:59:59Z", 3)).toEqual([
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:30:00.000Z", "2026-01-01T01:00:00.000Z",
    ]);
    expect(nextOccurrences(interval, interval.anchorAt, 2)).toEqual(["2026-01-01T00:30:00.000Z", "2026-01-01T01:00:00.000Z"]);
    expect(nextOccurrences(interval, "2026-09-28T10:05:00Z", 2)).toEqual(["2026-09-28T10:30:00.000Z", "2026-09-28T11:00:00.000Z"]);
    expect(nextOccurrences({ ...interval, anchorAt: "2026-01-01T00:00:00.125Z" }, "2026-01-01T00:30:00.124Z", 1))
      .toEqual(["2026-01-01T00:30:00.125Z"]);
  });
  it("keeps interval durations in elapsed UTC time through both DST transitions", () => {
    for (const anchorAt of ["2026-03-08T06:30:00.000Z", "2026-11-01T05:30:00.000Z"]) {
      const value = { ...interval, timezone: "America/New_York", every: 1, unit: "hour" as const, anchorAt };
      const expected = [1, 2, 3].map((step) => new Date(Date.parse(anchorAt) + step * 3_600_000).toISOString());
      expect(nextOccurrences(value, anchorAt, 3)).toEqual(expected);
      expect(nextOccurrences({ ...value, timezone: "UTC" }, anchorAt, 3)).toEqual(expected);
    }
  });
  it.each([
    ["America/New_York", "2026-03-08", "02:30", "2026-03-08T07:30:00.000Z"],
    ["America/New_York", "2026-11-01", "01:30", "2026-11-01T05:30:00.000Z"],
    ["Europe/Berlin", "2026-03-29", "02:30", "2026-03-29T01:30:00.000Z"],
    ["Europe/Berlin", "2026-10-25", "02:30", "2026-10-25T00:30:00.000Z"],
    ["Australia/Lord_Howe", "2026-10-04", "02:15", "2026-10-03T15:45:00.000Z"],
    ["Australia/Lord_Howe", "2026-04-05", "01:45", "2026-04-04T14:45:00.000Z"],
    ["Asia/Kathmandu", "2026-09-28", "10:00", "2026-09-28T04:15:00.000Z"],
    ["Pacific/Apia", "2011-12-30", "12:00", "2011-12-30T22:00:00.000Z"],
    ["UTC", "0099-01-02", "00:00", "0099-01-02T00:00:00.000Z"],
  ])("resolves %s %s %s without changing the process timezone", (timezone, localDate, time, expected) => {
    const from = new Date(Date.parse(expected) - 3 * 86_400_000).toISOString();
    const schedule = { ...once, timezone, localDate, time };
    expect(nextOccurrences(schedule, from, 10)).toEqual([expected]);
    expect(nextOccurrences(schedule, expected, 10)).toEqual([]);
  });
  it("shifts a weekly gap forward by its duration and returns to the saved wall time next week", () => {
    expect(nextOccurrences({ ...weekly, timezone: "America/New_York", weekdays: [7], time: "02:30" }, "2026-03-01T08:00:00Z", 3))
      .toEqual(["2026-03-08T07:30:00.000Z", "2026-03-15T06:30:00.000Z", "2026-03-22T06:30:00.000Z"]);
  });
  it("never reintroduces the second fold instance once the first one has passed", () => {
    const schedule = { ...weekly, timezone: "America/New_York", weekdays: [7], time: "01:30" };
    expect(nextOccurrences(schedule, "2026-11-01T05:00:00Z", 2)).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-08T06:30:00.000Z"]);
    expect(nextOccurrences(schedule, "2026-11-01T05:45:00Z", 1)).toEqual(["2026-11-08T06:30:00.000Z"]);
    expect(nextOccurrences({ ...once, timezone: schedule.timezone, localDate: "2026-11-01", time: schedule.time }, "2026-11-01T05:45:00Z", 1)).toEqual([]);
  });
  it("deduplicates instants when a skipped date and its successor share a due time", () => {
    const schedule = { ...weekly, timezone: "Pacific/Apia", weekdays: [5, 6], time: "12:00" };
    expect(nextOccurrences(schedule, "2011-12-29T00:00:00Z", 3)).toEqual([
      "2011-12-30T22:00:00.000Z", "2012-01-05T22:00:00.000Z", "2012-01-06T22:00:00.000Z",
    ]);
    // At this instant local Saturday has begun; the skipped Friday must still be considered.
    expect(nextOccurrences({ ...schedule, weekdays: [5] }, "2011-12-30T19:00:00Z", 1)).toEqual(["2011-12-30T22:00:00.000Z"]);
  });
  it("does not mutate input or trust a stale stored nextOccurrenceAt", () => {
    const stale = { ...record, nextOccurrenceAt: "2000-01-01T00:00:00Z" };
    const original = structuredClone(stale);
    expect(nextOccurrences(stale, clock, 2)).toEqual(nextOccurrences(weekly, clock, 2));
    expect(stale).toEqual(original);
    for (const schedule of [weekly, once, interval]) expect(nextOccurrences({ ...schedule, enabled: false }, clock, 5)).toEqual([]);
    expect(nextOccurrences(weekly, clock, 0)).toEqual([]);
  });
  it("bounds counts, validates all clocks and stops at the supported date range", () => {
    expect(MAX_SCHEDULE_PREVIEW_OCCURRENCES).toBe(1_000);
    for (const count of [-1, 1.5, NaN, Infinity, 1_001]) expect(() => nextOccurrences(weekly, clock, count)).toThrow(z.ZodError);
    expect(() => nextOccurrences(weekly, "2026-09-28T10:00:00", 1)).toThrow(z.ZodError);
    expect(nextOccurrences(interval, clock, 1_000)).toHaveLength(1_000);
    expect(nextOccurrences({ ...interval, every: Number.MAX_SAFE_INTEGER }, clock, 1)).toEqual([]);
    expect(nextOccurrences(weekly, "9999-12-31T23:59:59.999Z", 2)).toEqual([]);
    expect(nextOccurrences({ ...once, localDate: "0001-01-02", time: "00:00" }, "0001-01-01T00:00:00Z", 1))
      .toEqual(["0001-01-02T00:00:00.000Z"]);
  });
});

describe("occurrence identity and frozen admission defaults", () => {
  it("has explicit immutable defaults", () => {
    expect(Object.isFrozen(SCHEDULE_DEFAULTS)).toBe(true);
    expect(SCHEDULE_DEFAULTS).toEqual({ policy: "latest_saved", gracePeriodMs: 300_000, backfill: false,
      recovery: "latest_due_only", overlap: "skip", disabling: "future_admissions_only", workflowVersion: "pin_on_acceptance" });
  });
  it("keys occurrences only by workflow and canonical due instant", () => {
    expect(occurrence.id).toBe('schedule:v1:["workflow-1","2026-09-28T10:00:00.000Z"]');
    expect(scheduleOccurrenceId(scope.workflowId, "2026-09-28T15:00:00+05:00")).toBe(occurrence.id);
    expect(scheduleOccurrenceId("workflow-2", dueAt)).not.toBe(occurrence.id);
    expect(scheduleOccurrenceId(scope.workflowId, "2026-09-28T10:00:00.001Z")).not.toBe(occurrence.id);
    const unusualIds = ["a:b", "a\"b", "a,b", "a[b]", "😀", "\ud800"];
    expect(new Set(unusualIds.map((id) => scheduleOccurrenceId(id, dueAt))).size).toBe(unusualIds.length);
    expect(ScheduleOccurrenceSchema.parse({ ...accepted, scheduleRevision: 2 }).id).toBe(occurrence.id);
    expect(ScheduleOccurrenceSchema.parse({ ...accepted, dueAt: "2026-09-28T15:00:00+05:00" }).dueAt).toBe(dueAt);
    for (const change of [{ id: "random" }, { workflowId: "other" }, { dueAt: "2026-09-28T10:01:00Z" }]) {
      expect(ScheduleOccurrenceSchema.safeParse({ ...accepted, ...change }).success).toBe(false);
    }
  });
  it("requires acceptance's version and Run, forbids either on nonacceptance, and requires a reason", () => {
    expect(ScheduleOccurrenceSchema.parse(accepted)).toEqual(accepted);
    for (const key of ["workflowVersionId", "runId", "reason"]) expect(ScheduleOccurrenceSchema.safeParse(without(accepted, key)).success).toBe(false);
    for (const outcome of [{ status: "skipped", reason: "overlap" }, { status: "missed", reason: "outside_grace" },
      { status: "rejected", reason: "workflow_invalid" }]) {
      const value = { ...occurrence, ...outcome };
      expect(ScheduleOccurrenceSchema.safeParse(value).success).toBe(true);
      expect(ScheduleOccurrenceSchema.safeParse(without(value, "reason")).success).toBe(false);
      expect(ScheduleOccurrenceSchema.safeParse({ ...value, workflowVersionId: "v1" }).success).toBe(false);
      expect(ScheduleOccurrenceSchema.safeParse({ ...value, runId: null }).success).toBe(false);
    }
    expect(ScheduleOccurrenceSchema.safeParse({ ...accepted, reason: "overlap" }).success).toBe(false);
    expect(ScheduleOccurrenceSchema.safeParse({ ...occurrence, status: "rejected", reason: " " }).success).toBe(false);
  });
  it.each([
    ["2026-09-28T09:59:59.999Z", { status: "not_due" }],
    ["2026-09-28T10:00:00.000Z", { status: "eligible" }],
    ["2026-09-28T10:04:59.999Z", { status: "eligible" }],
    ["2026-09-28T10:05:00.000Z", { status: "eligible" }],
    ["2026-09-28T10:05:00.001Z", { status: "missed", reason: "outside_grace" }],
    ["2026-10-01T00:00:00.000Z", { status: "missed", reason: "outside_grace" }],
  ] as const)("classifies the exact grace boundary at %s", (nowUtc, expected) => {
    expect(scheduleAdmissionDecision({ ...admission, nowUtc })).toEqual(expected);
  });
  it("does not backfill a downtime backlog, even when several entries are younger than five minutes", () => {
    const nowUtc = "2026-09-28T10:03:30.000Z";
    const decisions = ["10:00", "10:01", "10:02", "10:03"].map((time) => scheduleAdmissionDecision({
      ...admission, nowUtc, dueAt: `2026-09-28T${time}:00.000Z`, isLatestDueOccurrence: time === "10:03",
    }));
    expect(decisions).toEqual([{ status: "missed", reason: "superseded" }, { status: "missed", reason: "superseded" },
      { status: "missed", reason: "superseded" }, { status: "eligible" }]);
  });
  it("skips same-workflow scheduled overlap, and disabling prevents only future admission", () => {
    expect(scheduleAdmissionDecision({ ...admission, hasOverlappingScheduledRun: true })).toEqual({ status: "skipped", reason: "overlap" });
    expect(scheduleAdmissionDecision({ ...admission, enabled: false })).toEqual({ status: "skipped", reason: "disabled" });
    expect(scheduleAdmissionDecision({ ...admission, enabled: false, nowUtc: "2026-09-28T09:59:59Z" })).toEqual({ status: "not_due" });
    expect(scheduleAdmissionDecision({ ...admission, enabled: false, hasOverlappingScheduledRun: true, nowUtc: "2026-09-28T10:06:00Z" }))
      .toEqual({ status: "missed", reason: "outside_grace" });
    const pinned = ScheduleOccurrenceSchema.parse(accepted);
    ScheduleDisableResultSchema.parse({ value: { ...record, revision: 2, enabled: false, nextOccurrenceAt: null }, replayed: false });
    expect(pinned).toEqual(accepted);
    expect(Object.isFrozen(pinned)).toBe(true);
    if (pinned.status !== "accepted") throw new Error("Expected accepted fixture");
    expect(() => {
      // @ts-expect-error An accepted workflow version cannot be rewritten by a later save.
      pinned.workflowVersionId = "newer-workflow-version";
    }).toThrow(TypeError);
  });
});
