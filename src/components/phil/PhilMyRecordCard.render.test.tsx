import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PhilMyRecordCard } from "./PhilMyRecordCard";
import type { MyRecordWindow } from "@/domains/workforce/my-record";

/**
 * Server-render guards for the Phil "your work record" card (#340). Pins the
 * three states the More tab can show: a populated record, the new-starter
 * honest zero (P7 — no fabricated numbers), and the fail-soft error state.
 */

const populated: MyRecordWindow = {
  weeks: [
    { weekStart: "2026-06-15", weekEnd: "2026-06-21", totalHours: 7.6 },
    { weekStart: "2026-06-22", weekEnd: "2026-06-28", totalHours: 15.6 },
  ],
  jobs: [
    { jobId: "j1", jobName: "Riverside", hours: 15.6 },
    { jobId: "j2", jobName: "Depot", hours: 7.6 },
  ],
  totalHours: 23.2,
  weekCount: 2,
  windowStart: "2026-06-15",
  windowEnd: "2026-06-28",
};

describe("PhilMyRecordCard — populated", () => {
  it("shows the title, the total, the per-week rows and the jobs worked", () => {
    const html = renderToString(
      createElement(PhilMyRecordCard, { record: populated, fetchError: null })
    );
    expect(html).toContain("Your work record");
    expect(html).toContain("Logged in this stretch");
    expect(html).toContain("23h 12m"); // 23.2h total
    expect(html).toContain("Week of"); // per-week section present
    expect(html).toContain("Jobs you"); // "Jobs you've been on"
    expect(html).toContain("Riverside");
    expect(html).toContain("Depot");
    // Worker words, not enterprise (P11).
    expect(html).not.toContain("utilisation");
    expect(html).not.toContain("KPI");
  });
});

describe("PhilMyRecordCard — new starter (honest zero, P7)", () => {
  it("a window of all-zero weeks with no jobs shows the honest empty state", () => {
    const empty: MyRecordWindow = {
      weeks: [
        { weekStart: "2026-06-15", weekEnd: "2026-06-21", totalHours: 0 },
        { weekStart: "2026-06-22", weekEnd: "2026-06-28", totalHours: 0 },
      ],
      jobs: [],
      totalHours: 0,
      weekCount: 2,
      windowStart: "2026-06-15",
      windowEnd: "2026-06-28",
    };
    const html = renderToString(
      createElement(PhilMyRecordCard, { record: empty, fetchError: null })
    );
    expect(html).toContain("No hours logged yet");
    expect(html).not.toContain("Logged in this stretch"); // no fabricated total row
    expect(html).not.toContain("By week");
  });

  it("a null record (never loaded) also shows the honest empty state", () => {
    const html = renderToString(
      createElement(PhilMyRecordCard, { record: null, fetchError: null })
    );
    expect(html).toContain("No hours logged yet");
  });
});

describe("PhilMyRecordCard — error", () => {
  it("renders the fail-soft message, not the empty state or any numbers", () => {
    const html = renderToString(
      createElement(PhilMyRecordCard, { record: null, fetchError: "API 500" })
    );
    expect(html).toContain("Couldn");
    expect(html).toContain("API 500");
    expect(html).not.toContain("No hours logged yet");
    expect(html).not.toContain("Logged in this stretch");
  });
});
