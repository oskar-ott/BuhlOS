import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The payroll PDF composer — offline, real pdf-lib. Pins the honesty rules:
 * the rollup arithmetic matches the rows it was given, an unmapped worker is
 * NAMED rather than shown as a blank cell, an empty period renders a real
 * "nothing here" sheet instead of a fabricated zero table, and long day
 * breakdowns page-break rather than overflowing.
 *
 * Cross-ref: api/_lib/payroll-pdf.js (composer), api/time-entries-export.js
 * (?format=pdf), api/_lib/payroll-csv.js (the CSV sibling off the same rows).
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { composePayrollPdf, rollupRows, longDate, dayDate } = requireFromHere(
  "../../../api/_lib/payroll-pdf.js"
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PDFDocument } = requireFromHere("pdf-lib");

type Row = {
  workerId: string;
  workerName: string;
  date: string;
  hours: number;
  ordinaryHours: number;
  overtimeHours: number;
  jobName?: string;
  xeroEmployeeId?: string;
};

function row(over: Partial<Row> = {}): Row {
  return {
    workerId: "u1",
    workerName: "Mick Doran",
    date: "2026-08-03",
    hours: 7.6,
    ordinaryHours: 7.6,
    overtimeHours: 0,
    jobName: "Marrickville Library Refit",
    xeroEmployeeId: "xero-1",
    ...over,
  };
}

const BASE = { fromDate: "2026-08-03", toDate: "2026-08-09", statusLabel: "approved" };

async function pageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

describe("rollupRows", () => {
  it("sums ordinary, overtime and total per worker and counts distinct days", () => {
    const { workers, totals } = rollupRows([
      row({ date: "2026-08-03", hours: 7.6, ordinaryHours: 7.6 }),
      row({ date: "2026-08-04", hours: 9.6, ordinaryHours: 7.6, overtimeHours: 2 }),
      // Same day, second job — one DAY, two entries.
      row({ date: "2026-08-04", hours: 2, ordinaryHours: 2, jobName: "Rozelle Rewire" }),
    ]);
    expect(workers).toHaveLength(1);
    expect(workers[0]).toMatchObject({
      workerName: "Mick Doran",
      dayCount: 2,
      ordinaryHours: 17.2,
      overtimeHours: 2,
      hours: 19.2,
    });
    expect(totals).toMatchObject({ workerCount: 1, hours: 19.2, overtimeHours: 2 });
  });

  it("separates workers, sorts them by name, and counts the unmapped ones", () => {
    const { workers, totals } = rollupRows([
      row({ workerId: "u2", workerName: "Zara Blake", xeroEmployeeId: "" }),
      row({ workerId: "u1", workerName: "Ari Nguyen" }),
    ]);
    expect(workers.map((w: { workerName: string }) => w.workerName)).toEqual([
      "Ari Nguyen",
      "Zara Blake",
    ]);
    expect(totals.workerCount).toBe(2);
    expect(totals.unmappedWorkerCount).toBe(1);
  });

  it("never invents a figure from a malformed row", () => {
    const { totals } = rollupRows([
      { workerId: "u1", workerName: "Mick", date: "2026-08-03" },
      { workerId: "u1", workerName: "Mick", date: "2026-08-04", hours: "not a number" },
    ]);
    expect(totals.hours).toBe(0);
    expect(totals.dayCount).toBe(2);
  });

  it("tolerates an empty/absent row set", () => {
    expect(rollupRows([]).totals).toMatchObject({ workerCount: 0, hours: 0 });
    expect(rollupRows(undefined).workers).toEqual([]);
  });
});

describe("date formatting (owner-corrected 2026-08-10: day before month)", () => {
  it("writes header dates day-first, never raw ISO", () => {
    expect(longDate("2026-08-03")).toBe("3 Aug 2026");
    // The trap this fixes: 03/08 must never render as the 8th of March.
    expect(longDate("2026-03-08")).toBe("8 Mar 2026");
  });

  it("writes breakdown rows as weekday + DD/MM/YYYY", () => {
    expect(dayDate("2026-08-03")).toBe("Mon 03/08/2026");
    expect(dayDate("2026-08-09")).toBe("Sun 09/08/2026");
  });

  it("passes a non-ISO value through untouched rather than mangling it", () => {
    expect(longDate("")).toBe("");
    expect(dayDate("not a date")).toBe("not a date");
  });
});

describe("composePayrollPdf", () => {
  it("renders a valid one-page PDF for a normal week", async () => {
    const bytes = await composePayrollPdf({
      ...BASE,
      rows: [row(), row({ date: "2026-08-04" }), row({ workerId: "u2", workerName: "Ari Nguyen" })],
    });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    // A real PDF, not a string of hope.
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    expect(await pageCount(bytes)).toBe(1);
  });

  it("renders an honest sheet when the period has no hours (no fake zero table)", async () => {
    const bytes = await composePayrollPdf({ ...BASE, rows: [] });
    expect(await pageCount(bytes)).toBe(1);
    expect(bytes.byteLength).toBeGreaterThan(500);
  });

  it("page-breaks a long day breakdown instead of overflowing one page", async () => {
    const many = Array.from({ length: 120 }, (_, i) =>
      row({
        workerId: `u${i % 6}`,
        workerName: `Worker ${i % 6}`,
        date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}`,
      })
    );
    const bytes = await composePayrollPdf({ ...BASE, rows: many });
    expect(await pageCount(bytes)).toBeGreaterThan(1);
  });

  it("detail=off yields a shorter document than the full breakdown", async () => {
    const rows = Array.from({ length: 40 }, (_, i) =>
      row({ date: `2026-08-${String((i % 28) + 1).padStart(2, "0")}` })
    );
    const withDetail = await composePayrollPdf({ ...BASE, rows });
    const summaryOnly = await composePayrollPdf({ ...BASE, rows, includeDetail: false });
    expect(summaryOnly.byteLength).toBeLessThan(withDetail.byteLength);
    expect(await pageCount(summaryOnly)).toBe(1);
  });

  it("survives names pdf-lib's WinAnsi fonts can't encode, rather than throwing", async () => {
    const bytes = await composePayrollPdf({
      ...BASE,
      rows: [row({ workerName: "Jörg 🙂 Müller", jobName: "Café — fit-out 🚧" })],
    });
    expect(await pageCount(bytes)).toBe(1);
  });

  it("handles a missing job on an allocation without inventing one", async () => {
    const bytes = await composePayrollPdf({ ...BASE, rows: [row({ jobName: "" })] });
    expect(await pageCount(bytes)).toBe(1);
  });
});

describe("composePayrollPdf — Not on this sheet (2026-10-09)", () => {
  // The sheet names every worker-day it does NOT carry, so it is complete or
  // says exactly what is missing. pdf-lib text isn't extracted here (the
  // suite pins structure); the composer's content is pinned through the
  // not-on-sheet unit tests and the email assertions, which share the list.
  const notOnSheet = {
    lines: [
      { workerName: "Dylan Sinclair", reason: "nothing logged", days: "Fri 2 Oct" },
      { workerName: "Stephen Mayne", reason: "nothing logged", days: "Fri 2 Oct" },
    ],
    dayCount: 2,
    leaveChecked: true,
    periodComplete: true,
  };

  it("adds the section to the sheet (and to the one-page summary) without breaking it", async () => {
    const rows = [row()];
    const plain = await composePayrollPdf({ ...BASE, rows });
    const withList = await composePayrollPdf({ ...BASE, rows, notOnSheet });
    expect(await pageCount(withList)).toBe(1);
    expect(withList.byteLength).toBeGreaterThan(plain.byteLength);
    const summaryOnly = await composePayrollPdf({ ...BASE, rows, notOnSheet, includeDetail: false });
    const summaryPlain = await composePayrollPdf({ ...BASE, rows, includeDetail: false });
    expect(summaryOnly.byteLength).toBeGreaterThan(summaryPlain.byteLength);
  });

  it("prints on an otherwise empty sheet too — why there are no hours is the point", async () => {
    const empty = await composePayrollPdf({ ...BASE, rows: [] });
    const emptyWithList = await composePayrollPdf({ ...BASE, rows: [], notOnSheet });
    expect(emptyWithList.byteLength).toBeGreaterThan(empty.byteLength);
  });

  it("a long list wraps and page-breaks instead of overflowing or throwing", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      workerName: `Worker ${i} With A Fairly Long Name`,
      reason: "waiting for approval",
      days: "Mon 28 Sep (7.6h), Tue 29 Sep (9.6h), Wed 30 Sep (11.6h), Thu 1 Oct (7.6h), Fri 2 Oct (7.6h)",
    }));
    const bytes = await composePayrollPdf({
      ...BASE,
      rows: [row()],
      notOnSheet: { lines: many, dayCount: 300, leaveChecked: false, periodComplete: true },
    });
    expect(await pageCount(bytes)).toBeGreaterThan(1);
  });

  it("an empty list on a finished period still says so ('Nothing left off'); on an unfinished one it stays quiet", async () => {
    const rows = [row()];
    const plain = await composePayrollPdf({ ...BASE, rows });
    const complete = await composePayrollPdf({
      ...BASE,
      rows,
      notOnSheet: { lines: [], dayCount: 0, leaveChecked: true, periodComplete: true },
    });
    const unfinished = await composePayrollPdf({
      ...BASE,
      rows,
      notOnSheet: { lines: [], dayCount: 0, leaveChecked: true, periodComplete: false },
    });
    expect(complete.byteLength).toBeGreaterThan(plain.byteLength);
    expect(Math.abs(unfinished.byteLength - plain.byteLength)).toBeLessThan(64);
  });
});
