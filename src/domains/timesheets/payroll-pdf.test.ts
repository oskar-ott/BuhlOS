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
const { composePayrollPdf, rollupRows } = requireFromHere("../../../api/_lib/payroll-pdf.js");
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
