import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { SiteInstructionsRegister } from "./SiteInstructionsRegister";
import type { SiteInstruction } from "@/domains/site-instructions/schema";

/**
 * SSR render tests for the site-instructions register (#283): the
 * flagged-but-unlinked row surfaces as the top attention state and sorts first,
 * status labels render, the record form + row actions are admin-only (no dead
 * controls for a read-only LH), and the honest "none yet" empty state.
 */

function si(over: Partial<SiteInstruction> & Pick<SiteInstruction, "id" | "ref">): SiteInstruction {
  return {
    jobId: "job-1",
    instructedBy: { name: "Bob Builder", contactId: null, email: null },
    channel: "phone",
    instructionText: "Move the GPO.",
    dateReceived: "2026-06-01",
    status: "recorded",
    costTimeImplication: false,
    linkedRfiId: null,
    linkedVariationId: null,
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgementChannel: null,
    emailSentAt: null,
    closedAt: null,
    closedBy: null,
    closeReason: null,
    recordedBy: "boss",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    auditLogIds: [],
    ...over,
  };
}

const strip = (h: string) => h.replace(/<!-- -->/g, "");

describe("SiteInstructionsRegister — render", () => {
  const instructions = [
    si({ id: "a", ref: "SI-001", dateReceived: "2026-06-10", instructionText: "Plain one." }),
    si({
      id: "b",
      ref: "SI-002",
      dateReceived: "2026-05-01",
      costTimeImplication: true,
      instructionText: "Costed one.",
    }),
    si({ id: "c", ref: "SI-003", status: "closed", closedBy: "boss", closeReason: "verbal only" }),
  ];

  it("flags the cost/time-unlinked row and sorts it first", () => {
    const html = strip(
      renderToString(
        createElement(SiteInstructionsRegister, {
          jobId: "job-1",
          initialInstructions: instructions,
          fetchError: null,
          canWrite: true,
        })
      )
    );
    expect(html).toContain("Cost/time flagged — nothing spawned");
    // SI-002 (flagged) sorts before SI-001 (newer but unflagged).
    expect(html.indexOf("SI-002")).toBeLessThan(html.indexOf("SI-001"));
    // Status labels render.
    expect(html).toContain("Recorded");
    expect(html).toContain("Closed");
  });

  it("admin sees the record form and row actions", () => {
    const html = strip(
      renderToString(
        createElement(SiteInstructionsRegister, {
          jobId: "job-1",
          initialInstructions: instructions,
          fetchError: null,
          canWrite: true,
        })
      )
    );
    expect(html).toContain("Record an instruction");
    expect(html).toContain("Confirm back"); // acknowledge control on a recorded row
    expect(html).toContain("Close");
  });

  it("a read-only LH sees no write controls (no dead controls)", () => {
    const html = strip(
      renderToString(
        createElement(SiteInstructionsRegister, {
          jobId: "job-1",
          initialInstructions: instructions,
          fetchError: null,
          canWrite: false,
        })
      )
    );
    expect(html).not.toContain("Record an instruction");
    expect(html).not.toContain("Confirm back");
    expect(html).not.toContain("Flag cost/time");
    // …but the register still reads.
    expect(html).toContain("SI-002");
  });

  it("honest empty state when nothing is recorded", () => {
    const html = strip(
      renderToString(
        createElement(SiteInstructionsRegister, {
          jobId: "job-1",
          initialInstructions: [],
          fetchError: null,
          canWrite: true,
        })
      )
    );
    expect(html).toContain("No site instructions recorded yet.");
  });
});
