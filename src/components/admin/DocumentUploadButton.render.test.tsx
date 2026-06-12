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
});
