import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DayworkRegister } from "./DayworkRegister";
import type { Daywork } from "@/domains/dayworks/types";
import type { DayworkRegisterSummary } from "@/domains/dayworks/service";

const NOW = Date.parse("2026-06-21T00:00:00.000Z");
const dayAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

function docket(over: Partial<Daywork>): Daywork {
  return {
    id: "dw_1",
    jobId: "job-1",
    ref: "DW-001",
    seq: 1,
    date: "2026-06-20T00:00:00.000Z",
    description: "Make-safe to East Gym board",
    labourLines: [{ id: "l1", workerName: "Sam", hours: 4 }],
    materialLines: [],
    photoIds: [],
    status: "unsigned",
    signature: null,
    linkedTimeEntryIds: [],
    createdById: "u1",
    createdByName: "Sam",
    createdAt: dayAgo(0),
    auditLogIds: [],
    ...over,
  } as Daywork;
}

const SUMMARY: DayworkRegisterSummary = {
  total: 3,
  unsigned: 1,
  signed: 1,
  invoiced: 1,
  unsignedAging: 1,
};

function render(dockets: Daywork[], summary: DayworkRegisterSummary): string {
  return renderToString(createElement(DayworkRegister, { dockets, summary, nowMs: NOW })).replace(
    /<!-- -->/g,
    "",
  );
}

describe("DayworkRegister", () => {
  it("renders the summary bar with the payment-risk count", () => {
    const html = render([], { total: 0, unsigned: 0, signed: 0, invoiced: 0, unsignedAging: 0 });
    expect(html).toContain("Dockets");
    expect(html).toContain("Unsigned");
    expect(html).toContain("Invoiced");
  });

  it("surfaces the unsigned-aging payment-risk badge when any docket is aging", () => {
    const html = render([], SUMMARY);
    expect(html).toContain("aging");
    expect(html).toContain("payment risk");
  });

  it("shows an honest empty state when there are no dockets", () => {
    const html = render([], { total: 0, unsigned: 0, signed: 0, invoiced: 0, unsignedAging: 0 });
    expect(html).toContain("No daywork dockets on this job yet");
  });

  it("marks an unsigned docket older than 24h as aging, but not a fresh one", () => {
    const aging = docket({ id: "dw_old", ref: "DW-010", status: "unsigned", createdAt: dayAgo(2) });
    const fresh = docket({ id: "dw_new", ref: "DW-011", status: "unsigned", createdAt: dayAgo(0) });
    const html = render([aging, fresh], SUMMARY);
    expect(html).toContain("DW-010");
    expect(html).toContain("DW-011");
    expect(html).toContain("Aging — chase the signature");
  });

  it("renders the supervisor + invoice details for signed / invoiced dockets", () => {
    const signed = docket({
      id: "dw_s",
      ref: "DW-020",
      status: "signed",
      signature: {
        supervisorName: "Jane Builder",
        imageUrl: null,
        imageSha256: null,
        signedAt: "2026-06-20T01:00:00.000Z",
        capturedById: "u1",
        capturedByName: "Sam",
      },
    });
    const invoiced = docket({
      id: "dw_i",
      ref: "DW-021",
      status: "invoiced",
      invoiceRef: "INV-42",
    });
    const html = render([signed, invoiced], SUMMARY);
    expect(html).toContain("Signed by Jane Builder");
    expect(html).toContain("Invoice INV-42");
    expect(html).toContain("Signed");
    expect(html).toContain("Invoiced");
  });
});
