import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const lib = require_("../../../api/_lib/time-entries.js") as {
  autoSplitOT: (total: number, date?: string) => { ordinary: number; overtime: number };
  isWeekendDate: (date: string) => boolean;
  enforceWeekendSplit: <T extends object>(entry: T) => T;
};

/**
 * Server mirror of the weekend-overtime rule (owner-directed 2026-08-10).
 * The server is the pay-classification authority — the wire split is not
 * trusted — so these pins live against api/_lib/time-entries.js itself.
 */
describe("server autoSplitOT — weekend days are all overtime", () => {
  it("mirrors the client exactly (the Jonathan Borg Saturday case)", () => {
    expect(lib.autoSplitOT(4, "2026-08-08")).toEqual({ ordinary: 0, overtime: 4 });
    expect(lib.autoSplitOT(10, "2026-08-09")).toEqual({ ordinary: 0, overtime: 10 });
    expect(lib.autoSplitOT(8.6, "2026-08-07")).toEqual({ ordinary: 7.6, overtime: 1 });
    expect(lib.autoSplitOT(8.6)).toEqual({ ordinary: 7.6, overtime: 1 });
  });
});

describe("server enforceWeekendSplit — the wire is not trusted", () => {
  it("coerces a client-sent weekday-style split on a Saturday to all-OT", () => {
    const coerced = lib.enforceWeekendSplit({
      date: "2026-08-08",
      totalHours: 4,
      ordinaryHours: 4,
      overtimeHours: 0,
    });
    expect(coerced).toMatchObject({ ordinaryHours: 0, overtimeHours: 4, totalHours: 4 });
  });

  it("leaves weekday entries exactly as sent", () => {
    const entry = { date: "2026-08-07", totalHours: 8.6, ordinaryHours: 7.6, overtimeHours: 1 };
    expect(lib.enforceWeekendSplit(entry)).toEqual(entry);
  });

  it("is null-safe and date-garbage-safe", () => {
    expect(lib.enforceWeekendSplit(null as unknown as object)).toBeNull();
    const weird = { date: "garbage", totalHours: 5, ordinaryHours: 5, overtimeHours: 0 };
    expect(lib.enforceWeekendSplit(weird)).toEqual(weird);
  });
});
