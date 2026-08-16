import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The timesheets→accounts email renderer (owner pull 2026-08-15) — the message
 * wrapped around the emailed pay-period PDF while the Xero push is out of
 * action. Pins the honesty rules: figures come straight from the caller's
 * rollup (the PDF's own numbers), worker names are HTML-escaped, overtime is
 * named only when it exists, and the plain-text part carries the same words
 * and figures as the HTML.
 *
 * Cross-ref: api/_lib/timesheets-email.js (renderer),
 *            api/time-entries-email.js (endpoint that sends it).
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderTimesheetsEmail, periodLabel, hoursLabel } = requireFromHere(
  "../../../api/_lib/timesheets-email.js"
);

const BASE = {
  fromDate: "2026-08-10",
  toDate: "2026-08-16",
  recipientName: "Tia",
  workers: [
    { workerName: "Mick Doran", hours: 40, overtimeHours: 2 },
    { workerName: "Sam Perry", hours: 38, overtimeHours: 0 },
  ],
  totalHours: 78,
  overtimeHours: 2,
  attachmentName: "buhlos-hours-2026-08-10-to-2026-08-16.pdf",
  sentByName: "oskar",
};

describe("periodLabel", () => {
  it("same month → one month mention, day-first", () => {
    expect(periodLabel("2026-08-10", "2026-08-16")).toBe("10 – 16 Aug 2026");
  });
  it("cross month, same year", () => {
    expect(periodLabel("2026-07-28", "2026-08-03")).toBe("28 Jul – 3 Aug 2026");
  });
  it("cross year names both years", () => {
    expect(periodLabel("2025-12-29", "2026-01-04")).toBe("29 Dec 2025 – 4 Jan 2026");
  });
  it("non-ISO input passes through untouched, never mangled", () => {
    expect(periodLabel("garbage", "2026-01-04")).toBe("garbage – 2026-01-04");
  });
});

describe("hoursLabel", () => {
  it("trailing-zero-free with the unit attached", () => {
    expect(hoursLabel(7.6)).toBe("7.6h");
    expect(hoursLabel(38)).toBe("38h");
    expect(hoursLabel(7.599999)).toBe("7.6h");
  });
});

describe("renderTimesheetsEmail", () => {
  it("subject carries period, worker count and total hours", () => {
    const msg = renderTimesheetsEmail(BASE);
    expect(msg.subject).toBe("Timesheets 10 – 16 Aug 2026 · 2 workers · 78h");
  });

  it("singular worker reads 'worker', not 'workers'", () => {
    const msg = renderTimesheetsEmail({
      ...BASE,
      workers: [BASE.workers[0]!],
      totalHours: 40,
    });
    expect(msg.subject).toContain("1 worker ·");
    expect(msg.text).toContain("Total (1 worker)");
  });

  it("html lists every worker with hours; OT named only where it exists", () => {
    const msg = renderTimesheetsEmail(BASE);
    expect(msg.html).toContain("Mick Doran");
    expect(msg.html).toContain("incl. 2h OT");
    expect(msg.html).toContain("Sam Perry");
    // Sam has no OT — exactly one per-worker OT note in the whole message.
    expect(msg.html.match(/incl\. .*OT/g)?.length).toBe(1);
    expect(msg.html).toContain("40h");
    expect(msg.html).toContain("38h");
    expect(msg.html).toContain("78h");
  });

  it("total overtime line appears only when the period has overtime", () => {
    const withOt = renderTimesheetsEmail(BASE);
    expect(withOt.html).toContain("overtime across the period");
    const noOt = renderTimesheetsEmail({
      ...BASE,
      workers: BASE.workers.map((w) => ({ ...w, overtimeHours: 0 })),
      overtimeHours: 0,
    });
    expect(noOt.html).not.toContain("overtime across the period");
    expect(noOt.text).not.toContain("overtime");
  });

  it("escapes worker names in the html (never raw markup)", () => {
    const msg = renderTimesheetsEmail({
      ...BASE,
      workers: [{ workerName: 'Mick <b>"Doran"</b>', hours: 40, overtimeHours: 0 }],
    });
    expect(msg.html).not.toContain("<b>\"Doran\"</b>");
    expect(msg.html).toContain("Mick &lt;b&gt;&quot;Doran&quot;&lt;/b&gt;");
  });

  it("plain text mirrors the figures and names the attachment", () => {
    const msg = renderTimesheetsEmail(BASE);
    expect(msg.text).toContain("Hi Tia,");
    expect(msg.text).toContain("buhlos-hours-2026-08-10-to-2026-08-16.pdf");
    expect(msg.text).toContain("Mick Doran — 40h (incl. 2h OT)");
    expect(msg.text).toContain("Sam Perry — 38h");
    expect(msg.text).toContain("Total (2 workers) — 78h incl. 2h overtime");
    expect(msg.text).toContain("by oskar");
  });
});
