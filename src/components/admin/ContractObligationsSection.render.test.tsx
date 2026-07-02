import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

/**
 * #373 + the #197 shared text layer — pins the HONEST copy of the extraction
 * card after the PDF-path wiring: the description offers BOTH paths (paste
 * text, or pick a PDF whose text layer is read server-side), names the OCR
 * gap for scanned PDFs, and the run button starts disabled (no text pasted,
 * no document loaded yet). Effects don't run under renderToString, so this
 * is the initial state only — the API behaviour itself is covered by
 * src/domains/jobs/contract-extractions-api.test.ts.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { ContractObligationsSection } from "./ContractObligationsSection";

describe("ContractObligationsSection (initial render)", () => {
  const html = renderToString(createElement(ContractObligationsSection, { jobId: "job-1" }));

  it("offers both paths honestly: paste text, or a PDF read server-side; scanned PDFs named as unreadable (no OCR, #197)", () => {
    expect(html).toContain("pick a PDF from the register");
    expect(html).toContain("read its text layer server-side");
    expect(html).toContain("OCR");
    expect(html).toContain("#197");
    // The stale "isn't built yet" claim about PDF reading is gone.
    expect(html).not.toContain("built yet");
  });

  it("run button is disabled before any text is pasted or any PDF selected", () => {
    const button = html.match(/<button[^>]*data-testid="contract-extract-run"[^>]*>/)?.[0];
    expect(button).toBeTruthy();
    expect(button).toContain("disabled");
  });
});
