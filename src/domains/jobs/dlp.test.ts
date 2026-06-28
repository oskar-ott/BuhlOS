import { describe, expect, it } from "vitest";
import { dlpStatus } from "./dlp";

describe("dlpStatus", () => {
  // Window: handover 2026-06-01, ends 2026-08-30 (90 days inclusive-ish).
  const job = { handoverDate: "2026-06-01", defectPeriodEndsAt: "2026-08-30" };

  it("returns not_set when both fields are absent", () => {
    expect(dlpStatus({}, "2026-06-15")).toEqual({ state: "not_set" });
    expect(dlpStatus(null, "2026-06-15")).toEqual({ state: "not_set" });
    expect(dlpStatus(undefined, "2026-06-15")).toEqual({ state: "not_set" });
  });

  it("returns not_set when only one field is present (never defaulted)", () => {
    expect(dlpStatus({ handoverDate: "2026-06-01" }, "2026-06-15")).toEqual({
      state: "not_set",
    });
    expect(dlpStatus({ defectPeriodEndsAt: "2026-08-30" }, "2026-06-15")).toEqual({
      state: "not_set",
    });
  });

  it("treats null / blank fields as not_set", () => {
    expect(
      dlpStatus({ handoverDate: "", defectPeriodEndsAt: "" }, "2026-06-15"),
    ).toEqual({ state: "not_set" });
    expect(
      dlpStatus({ handoverDate: null, defectPeriodEndsAt: null }, "2026-06-15"),
    ).toEqual({ state: "not_set" });
  });

  it("treats a malformed date as not_set (never crashes)", () => {
    expect(
      dlpStatus({ handoverDate: "2026/06/01", defectPeriodEndsAt: "2026-08-30" }, "2026-06-15"),
    ).toEqual({ state: "not_set" });
    expect(dlpStatus(job, "not-a-date")).toEqual({ state: "not_set" });
  });

  it("is in_dlp ON the day of handover (inclusive start)", () => {
    const r = dlpStatus(job, "2026-06-01");
    expect(r.state).toBe("in_dlp");
    if (r.state === "in_dlp") expect(r.daysRemaining).toBe(91); // 2026-06-01..2026-08-30 inclusive
  });

  it("is in_dlp mid-window with the right days remaining", () => {
    const r = dlpStatus(job, "2026-08-29");
    expect(r).toEqual({ state: "in_dlp", daysRemaining: 2 });
  });

  it("is in_dlp ON the last day with 1 day remaining (inclusive end)", () => {
    expect(dlpStatus(job, "2026-08-30")).toEqual({
      state: "in_dlp",
      daysRemaining: 1,
    });
  });

  it("is expired the day AFTER the end date", () => {
    expect(dlpStatus(job, "2026-08-31")).toEqual({
      state: "expired",
      endedAt: "2026-08-30",
    });
  });

  it("is not_set when handover is in the future (window not open yet)", () => {
    expect(dlpStatus(job, "2026-05-31")).toEqual({ state: "not_set" });
  });

  it("handles a single-day window (handover === ends)", () => {
    const oneDay = { handoverDate: "2026-07-10", defectPeriodEndsAt: "2026-07-10" };
    expect(dlpStatus(oneDay, "2026-07-10")).toEqual({
      state: "in_dlp",
      daysRemaining: 1,
    });
    expect(dlpStatus(oneDay, "2026-07-11")).toEqual({
      state: "expired",
      endedAt: "2026-07-10",
    });
  });
});
