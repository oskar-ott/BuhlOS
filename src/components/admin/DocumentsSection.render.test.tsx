import { describe, expect, it, vi } from "vitest";

// The embedded DocumentUploadButton calls useRouter (refresh after upload).
// Stub it so the SSR smoke doesn't need a mounted app router — same pattern
// as DocumentUploadButton.render.test.tsx / JobBuilderClient.render.test.tsx.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { DocumentsSection } from "./DocumentsSection";

/**
 * SSR smoke for the builder's Documents step (Job Builder redesign ·
 * Wave 4b). renderToString draws the initial state — effects don't run
 * server-side, so the GET never fires and the panel shows its honest
 * loading state. The visibility PATCH + field-GET filter behaviour is
 * pinned by the API tests (src/domains/documents/plans-api.test.ts).
 */
describe("DocumentsSection (Job Builder redesign · Wave 4b)", () => {
  it("renders the header, the truth note, the upload entry and the honest loading state", () => {
    const html = renderToString(createElement(DocumentsSection, { jobId: "j1" }));
    expect(html).toContain("Documents");
    expect(html).toContain("which of them the crew can open in the field app");
    // The truth note — what hiding ACTUALLY does, and the default.
    expect(html).toContain('data-testid="documents-truth-note"');
    expect(html).toContain("Hidden files never reach the crew");
    expect(html).toContain("New uploads are visible by default.");
    // Upload rides the existing shell-neutral button, not a second uploader.
    expect(html).toContain("Upload a document");
    // Initial state before the client-side fetch resolves — no invented rows.
    expect(html).toContain("Loading documents");
    expect(html).not.toContain('data-testid="documents-row"');
  });
});
