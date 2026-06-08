import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobDocumentsPanel } from "./JobDocumentsPanel";
import type { Document } from "@/domains/documents/types";

/**
 * JobDocumentsPanel — quiet when genuinely empty.
 *
 * The panel owns its own `#phil-job-documents` section and renders NOTHING when
 * the job has no documents and no fetch error, so an empty job doesn't show a
 * "No documents" card padding the screen. Two cases must still render: a
 * superseded-only job ("don't use stale drawings, ask your PM" — real field
 * safety) and any fetch error. Real documents always render. Node-env SSR.
 */

function doc(over: Partial<Document> = {}): Document {
  return {
    id: "d1",
    title: "Switchboard Layout",
    url: "https://blob.example/switchboard.pdf",
    mimeType: "application/pdf",
    category: "drawing",
    status: "current",
    ...over,
  } as unknown as Document;
}

function render(props: {
  initialDocuments?: ReadonlyArray<Document>;
  fetchError?: string | null;
}) {
  return renderToString(createElement(JobDocumentsPanel, props));
}

describe("JobDocumentsPanel — quiet empty state", () => {
  it("renders nothing when there are no documents and no fetch error", () => {
    expect(render({ initialDocuments: [], fetchError: null })).toBe("");
    // …and with defaults (no docs, no error) too.
    expect(renderToString(createElement(JobDocumentsPanel, {}))).toBe("");
  });

  it("renders the section + a row when current documents exist", () => {
    const html = render({ initialDocuments: [doc()] });
    expect(html).toContain('id="phil-job-documents"');
    expect(html).toContain("Documents"); // "Documents &amp; specs"
    expect(html).toContain("Switchboard Layout");
    expect(html).toContain("https://blob.example/switchboard.pdf");
  });

  it("still renders (not hidden) for a superseded-only job — a real safety message", () => {
    const html = render({ initialDocuments: [doc({ status: "superseded" })] });
    expect(html).not.toBe("");
    expect(html).toContain('id="phil-job-documents"');
    expect(html).toContain("has been superseded");
    expect(html).toContain("Ask your PM which one to use");
  });

  it("still renders the fetch-error notice even with zero documents", () => {
    const html = render({ initialDocuments: [], fetchError: "boom" });
    expect(html).not.toBe("");
    expect(html).toContain('id="phil-job-documents"');
    expect(html).toContain("load every document"); // the warning notice
  });

  it("uses plain field language — no admin/payroll/Xero jargon", () => {
    const html = render({ initialDocuments: [doc()] }).toLowerCase();
    for (const banned of ["payroll", "xero", "dashboard", "admin", "registry"]) {
      expect(html).not.toContain(banned);
    }
  });
});
