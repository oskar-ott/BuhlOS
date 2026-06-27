import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { RfiRegister } from "./RfiRegister";
import type { Rfi } from "@/domains/rfi/schema";

/**
 * SSR render tests for the RFI register (#276): the raise form, the overdue
 * marker, the stored answer, and the filter chips with the overdue count.
 */

function rfi(over: Partial<Rfi> & Pick<Rfi, "id" | "ref" | "subject">): Rfi {
  return {
    jobId: "job-1",
    question: "?",
    askedOf: "",
    status: "open",
    responseDue: "",
    sentAt: null,
    answer: "",
    answeredAt: null,
    answeredBy: null,
    closedReason: "",
    observationId: null,
    convertedFromObservationId: null,
    areaId: null,
    planId: null,
    raisedById: "u",
    raisedByName: "u",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    auditLogIds: [],
    ...over,
  };
}

const strip = (h: string) => h.replace(/<!-- -->/g, "");

describe("RfiRegister — render", () => {
  const html = strip(
    renderToString(
      createElement(RfiRegister, {
        jobId: "job-1",
        initialRfis: [
          rfi({
            id: "r2",
            ref: "RFI-002",
            subject: "Meter panel location",
            status: "open",
            responseDue: "2026-01-01", // long past → overdue
          }),
          rfi({
            id: "r1",
            ref: "RFI-001",
            subject: "Cable size to plant",
            status: "answered",
            answer: "16mm² to the plant room.",
          }),
        ],
        fetchError: null,
      })
    )
  );

  it("shows the raise form", () => {
    expect(html).toContain("Raise RFI");
    expect(html).toContain("Question");
  });

  it("lists RFIs with ref + subject + status", () => {
    expect(html).toContain("RFI-002");
    expect(html).toContain("Meter panel location");
    expect(html).toContain("RFI-001");
    expect(html).toContain("Answered");
  });

  it("flags the overdue RFI and shows the stored answer", () => {
    expect(html).toContain("Overdue");
    expect(html).toContain("16mm² to the plant room.");
  });

  it("offers status filters incl. an overdue count", () => {
    expect(html).toContain("Overdue (1)");
  });
});
