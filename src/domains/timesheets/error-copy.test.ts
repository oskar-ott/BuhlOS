import { describe, expect, it } from "vitest";
import { hoursWriteFailureCopy } from "./error-copy";

/**
 * 2026-09-26 audit: the field read "request failed … trying again is safe"
 * for every refusal. The mapper owns the site-language sentence AND the
 * honest retry claim (P7 / P11).
 */
describe("hoursWriteFailureCopy", () => {
  it("a network / timeout failure keeps http.ts's signal copy and IS retry-safe", () => {
    const c = hoursWriteFailureCopy({
      status: 0,
      message: "Couldn’t reach the office.",
      kind: "network",
    });
    expect(c).toEqual({ message: "Couldn’t reach the office.", retrySafe: true });
  });
  it("a 5xx is retry-safe and never echoes a stack-ish server string", () => {
    const c = hoursWriteFailureCopy({ status: 500, message: "internal error" });
    expect(c.retrySafe).toBe(true);
    expect(c.message).not.toMatch(/internal/);
  });
  it("the backdate refusal names the real limit and is NOT retry-safe", () => {
    const c = hoursWriteFailureCopy({
      status: 400,
      message: "cannot log more than 14 days in the past",
    });
    expect(c.message).toMatch(/two weeks back/);
    expect(c.retrySafe).toBe(false);
  });
  it("a closed / draft job 403 says pick another job", () => {
    const c = hoursWriteFailureCopy({
      status: 403,
      message:
        "forbidden — hours can only be logged against a job that is live or finished, not archived or draft",
    });
    expect(c.message).toMatch(/pick another job/);
    expect(c.retrySafe).toBe(false);
  });
  it("approved / exported days point at the office", () => {
    expect(
      hoursWriteFailureCopy({
        status: 403,
        message: "cannot edit approved entry — ask admin to reopen it",
      }).message
    ).toMatch(/already approved/);
    expect(
      hoursWriteFailureCopy({
        status: 403,
        message: "cannot edit entry already exported to payroll",
      }).message
    ).toMatch(/gone to payroll/);
  });
  it("a duplicate-day 409 explains where to change it", () => {
    const c = hoursWriteFailureCopy({
      status: 409,
      message: "entry already exists for that date — edit it instead",
    });
    expect(c.message).toMatch(/already has hours logged/);
    expect(c.retrySafe).toBe(false);
  });
  it("a split that doesn't add up is said in site words", () => {
    expect(
      hoursWriteFailureCopy({ status: 400, message: "allocation hours must sum to totalHours" })
        .message
    ).toMatch(/doesn’t add up/);
  });
  it("an unrecognised 4xx keeps the server sentence, falling back to the caller's default", () => {
    expect(hoursWriteFailureCopy({ status: 400, message: "notes too long" }).message).toBe(
      "notes too long"
    );
    expect(hoursWriteFailureCopy({ status: 400, message: "" }, "Couldn’t save.").message).toBe(
      "Couldn’t save."
    );
  });
});
