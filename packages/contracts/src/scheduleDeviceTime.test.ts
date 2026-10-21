import { describe, expect, it } from "vitest";
import { nextOccurrences, scheduleConfigurationToUtc, scheduleLocalTimeToUtc, scheduleUtcToLocalTime,
  type ScheduleConfiguration } from "./schedules.js";

describe("schedule calendar input and canonical instants", () => {
  it.each([
    ["Asia/Tokyo", "2099-08-25", "00:30"],
    ["America/Los_Angeles", "2099-08-24", "08:30"],
    ["Asia/Dushanbe", "2099-08-24", "20:30"],
  ])("displays and round-trips one UTC instant in %s", (timezone, localDate, time) => {
    const instant = "2099-08-24T15:30:00.000Z";
    expect(scheduleUtcToLocalTime(instant, timezone)).toEqual({ localDate, time });
    expect(scheduleLocalTimeToUtc(localDate, time, timezone)).toBe(instant);
    const value: ScheduleConfiguration = { mode: "once", localDate, time, timezone, enabled: true, policy: "latest_saved" };
    expect(scheduleConfigurationToUtc(value)).toEqual({ ...value, timezone: "UTC", localDate: "2099-08-24", time: "15:30" });
    expect(nextOccurrences(value, "2099-08-01T00:00:00Z", 1)).toEqual(nextOccurrences(scheduleConfigurationToUtc(value), "2099-08-01T00:00:00Z", 1));
  });
  it.each([
    ["2026-03-08", "02:30", "2026-03-08T07:30:00.000Z"],
    ["2026-11-01", "01:30", "2026-11-01T05:30:00.000Z"],
  ])("shares the scheduler's gap/fold rule for %s", (localDate, time, instant) => {
    expect(scheduleLocalTimeToUtc(localDate, time, "America/New_York")).toBe(instant);
  });
  it("keeps weekly source-calendar intent and DST while occurrences remain UTC", () => {
    const value: ScheduleConfiguration = { mode: "weekly", weekdays: [7], time: "09:00", timezone: "America/New_York", enabled: true, policy: "latest_saved" };
    expect(scheduleConfigurationToUtc(value)).toBe(value);
    expect(nextOccurrences(value, "2026-03-01T15:00:00Z", 2)).toEqual(["2026-03-08T13:00:00.000Z", "2026-03-15T13:00:00.000Z"]);
    expect(nextOccurrences(value, "2026-10-25T15:00:00Z", 2)).toEqual(["2026-11-01T14:00:00.000Z", "2026-11-08T14:00:00.000Z"]);
  });
  it("keeps historical source components when UTC minute fields cannot encode the exact instant", () => {
    const value: ScheduleConfiguration = { mode: "once", localDate: "1850-01-01", time: "09:00", timezone: "Asia/Kolkata", enabled: true, policy: "latest_saved" };
    expect(scheduleConfigurationToUtc(value)).toEqual(value);
    expect(nextOccurrences(value, "1849-12-31T00:00:00Z", 1)[0]).toBe("1850-01-01T03:06:32.000Z");
  });
});
