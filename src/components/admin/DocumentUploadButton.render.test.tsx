import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DocumentUploadButton } from "./DocumentUploadButton";

/**
 * Static-render guards for the restored uploader (#379). The live flow
 * (dataUrl POST, auto-supersede warning, PDF page prep) is covered by the
 * server's behaviour + PR-preview verification; these pin the form shell
 * and the reusability contract (#219/#231 mount the same button with a
 * different default category instead of building second uploaders).
 */

describe("DocumentUploadButton", () => {
  it("renders just the entry button when closed", () => {
    const html = renderToString(createElement(DocumentUploadButton, { jobId: "j1" }));
    expect(html).toContain("Upload a document");
    expect(html).not.toContain("Drawing number");
  });

  it("open form: file + title + category, drawing fields for the plan category, submit disabled without a file", () => {
    const html = renderToString(
      createElement(DocumentUploadButton, { jobId: "j1", defaultOpen: true }),
    );
    expect(html).toContain("PDF or image, up to 25 MB");
    expect(html).toContain("Title");
    expect(html).toContain("Drawing number");
    expect(html).toContain("Revision");
    expect(html).toMatch(/disabled=""[^>]*data-testid="document-upload-submit"/);
  });

  it("a non-drawing default category hides the drawing fields (reusable for certificates/safety)", () => {
    const html = renderToString(
      createElement(DocumentUploadButton, {
        jobId: "j1",
        defaultOpen: true,
        defaultCategory: "certificate",
      }),
    );
    expect(html).not.toContain("Drawing number");
    expect(html).toContain("Certificate");
  });

  it("aiAutofill: renders the single-file form and does NOT leak the Fill button pre-file-pick", () => {
    const html = renderToString(
      createElement(DocumentUploadButton, {
        jobId: "j1",
        defaultOpen: true,
        aiAutofill: true,
      }),
    );
    // The form still renders unchanged…
    expect(html).toContain("Title");
    expect(html).toContain("Drawing number");
    // …and the auto-fill button only appears after a file is picked (SSR can't
    // pick one), so it must NOT be in the initial markup.
    expect(html).not.toContain("Fill from file");
    expect(html).not.toContain("document-autofill");
  });

  it("aiAutofill never leaks into batch or revise SSR states", () => {
    // Revise mode: the AI auto-fill button is off by design there.
    const revise = renderToString(
      createElement(DocumentUploadButton, {
        jobId: "j1",
        defaultOpen: true,
        aiAutofill: true,
        revises: { id: "pl_1", drawingNumber: "E-101", revision: "B" },
      }),
    );
    expect(revise).not.toContain("Fill from file");
    expect(revise).not.toContain("document-autofill");
  });

  it("accepts multiple files — except in revision mode, which names ONE predecessor", () => {
    const normal = renderToString(
      createElement(DocumentUploadButton, { jobId: "j1", defaultOpen: true }),
    );
    // React SSR renders the boolean attribute as multiple=""
    expect(normal).toMatch(/data-testid="document-upload-file"[^>]*multiple=""|multiple=""[^>]*data-testid="document-upload-file"/);
    expect(normal).toContain("25 MB each");

    const revise = renderToString(
      createElement(DocumentUploadButton, {
        jobId: "j1",
        defaultOpen: true,
        revises: { id: "pl_1", drawingNumber: "E-101", revision: "B" },
      }),
    );
    expect(revise).not.toContain('multiple=""');
    // batch UI never appears in the SSR state (no files picked yet)
    expect(revise).not.toContain("applies to all");
    expect(normal).not.toContain("applies to all");
  });
});
