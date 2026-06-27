import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

import { ClientContractCard } from "./ClientContractCard";
import type { Job } from "@/domains/jobs/types";

/**
 * #228 — the read-only client & contract summary on the job hub. Admin-tier
 * only (the page gates it + the server redacts the fields), so these tests
 * just pin the render: honest empty state, populated values, AUD formatting,
 * and preserved note line breaks.
 */
const base: Job = { id: "j", name: "J" } as Job;

describe("ClientContractCard", () => {
  it("shows an honest empty state when nothing is captured", () => {
    const html = renderToString(createElement(ClientContractCard, { job: base }));
    expect(html).toContain("No client or contract details captured");
    expect(html).not.toContain("Contract value");
  });

  it("renders the reference, AUD value and notes when present", () => {
    const job = {
      ...base,
      clientReference: "PO-7788",
      contractValue: 120000,
      contractNotes: "Net 30\nExcludes after-hours",
    } as Job;
    const html = renderToString(createElement(ClientContractCard, { job }));
    expect(html).toContain("PO-7788");
    expect(html).toContain("Client reference");
    expect(html).toContain("Contract value");
    expect(html).toContain("$120,000"); // AUD grouping, whole-dollar
    expect(html).toContain("Net 30");
  });

  it("treats a negative or non-finite contract value as absent", () => {
    const job = { ...base, contractValue: -5 } as Job;
    const html = renderToString(createElement(ClientContractCard, { job }));
    expect(html).toContain("No client or contract details captured");
  });
});
