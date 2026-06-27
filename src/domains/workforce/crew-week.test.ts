import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * #337 — weekly crew availability projection. Pure: per worker, per day → leave
 * (with type) / assigned (current-state) / free. CJS (the endpoint requires it).
 */
const requireFromHere = createRequire(import.meta.url);
const cw = requireFromHere("../../../api/_lib/crew-week.js") as {
  mondayOf: (d: string) => string;
  weekDays: (d: string) => string[];
  buildCrewWeek: (input: Record<string, unknown>) => Array<{
    id: string;
    days: Array<{ date: string; state: string; leaveType: string | null }>;
  }>;
};

describe("week helpers", () => {
  it("weekDays returns Mon→Sun of the containing week", () => {
    expect(cw.mondayOf("2026-06-24")).toBe("2026-06-22");
    expect(cw.weekDays("2026-06-24")).toEqual([
      "2026-06-22", "2026-06-23", "2026-06-24", "2026-06-25", "2026-06-26", "2026-06-27", "2026-06-28",
    ]);
  });
});

describe("buildCrewWeek — per-day state", () => {
  const days = cw.weekDays("2026-06-24"); // Mon 22 … Sun 28

  it("marks leave (with type) over the covered days, else assigned/free", () => {
    const rows = cw.buildCrewWeek({
      weekDays: days,
      workers: [
        { id: "u1", name: "Sparky", role: "electrician", assignedJobNames: ["100 Arthur"] },
        { id: "u2", name: "Mate", role: "tradie", assignedJobNames: [] },
      ],
      leaveByUser: {
        u1: [{ type: "annual", fromDate: "2026-06-24", toDate: "2026-06-25" }], // Wed–Thu
      },
    });
    const u1 = rows.find((r) => r.id === "u1")!;
    // Mon/Tue assigned, Wed/Thu leave, Fri assigned
    expect(u1.days[0]).toMatchObject({ date: "2026-06-22", state: "assigned", leaveType: null });
    expect(u1.days[2]).toMatchObject({ date: "2026-06-24", state: "leave", leaveType: "annual" });
    expect(u1.days[3]).toMatchObject({ date: "2026-06-25", state: "leave", leaveType: "annual" });
    expect(u1.days[4]).toMatchObject({ date: "2026-06-26", state: "assigned" });

    const u2 = rows.find((r) => r.id === "u2")!;
    expect(u2.days.every((d) => d.state === "free")).toBe(true); // no jobs, no leave
  });

  it("leave overrides assignment on a covered day", () => {
    const rows = cw.buildCrewWeek({
      weekDays: days,
      workers: [{ id: "u1", name: "A", role: "electrician", assignedJobNames: ["J"] }],
      leaveByUser: { u1: [{ type: "sick", fromDate: "2026-06-22", toDate: "2026-06-22" }] },
    });
    expect(rows[0]!.days[0]).toMatchObject({ state: "leave", leaveType: "sick" });
    expect(rows[0]!.days[1]!.state).toBe("assigned");
  });
});
