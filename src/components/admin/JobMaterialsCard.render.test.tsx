import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobMaterialsCard, MaterialsDuplicateWarning } from "./JobMaterialsCard";

/**
 * "Possible duplicate cost" (2026-09-27) — the warning the office sees when a
 * typed docket looks like a confirmed supplier invoice on the job. Rendered
 * on its own (pure props) so the contract is asserted without a mount fetch:
 * it names the invoice, links to it, explains the double count, asks for a
 * reason, and keeps "Add anyway" disabled until there is one.
 */
const CANDIDATES = [
  {
    invoiceId: "inv-482",
    strength: "reference" as const,
    supplierName: "L & H Group Pty Ltd",
    supplierInvoiceNumber: "INV-00482",
    amountCents: 18450,
    invoiceDate: "2026-09-18",
    reasons: ["same supplier", "same invoice number", "same amount"],
  },
  {
    invoiceId: "inv-500",
    strength: "amount_date" as const,
    supplierName: null,
    supplierInvoiceNumber: null,
    amountCents: 18450,
    invoiceDate: null,
    reasons: ["same supplier", "same amount", "2 days apart"],
  },
];
const noop = () => undefined;

describe("MaterialsDuplicateWarning — render contract", () => {
  it("names the look-alike invoices, links to each, and explains the double count", () => {
    const html = renderToString(
      createElement(MaterialsDuplicateWarning, {
        candidates: CANDIDATES,
        reason: "",
        busy: false,
        onReasonChange: noop,
        onConfirm: noop,
        onCancel: noop,
      }),
    );
    expect(html).toContain("Possible duplicate cost");
    expect(html).toContain("count the cost twice");
    expect(html).toContain("INV-00482");
    expect(html).toContain('href="/invoices/inv-482"');
    expect(html).toContain('href="/invoices/inv-500"');
    expect(html).toContain("same invoice number");
    expect(html).toContain("Unknown supplier");
    expect(html).toContain("no invoice number");
    expect(html).toContain("$184.50");
    expect(html).toContain('role="alert"');
  });

  it("'Add anyway' stays disabled until a reason is typed; the reason is announced as kept on the audit trail", () => {
    const render = (reason: string) =>
      renderToString(
        createElement(MaterialsDuplicateWarning, {
          candidates: CANDIDATES,
          reason,
          busy: false,
          onReasonChange: noop,
          onConfirm: noop,
          onCancel: noop,
        }),
      );
    const addAnyway = (html: string) => /<button[^>]*data-testid="materials-duplicate-add-anyway"[^>]*>/.exec(html)?.[0] ?? "";
    // The attribute is ` disabled=""`; the class list always carries `disabled:` variants.
    const empty = render("");
    expect(addAnyway(empty)).toContain(' disabled=""');
    expect(empty).toContain("kept on the audit trail");
    const withReason = render("cash-sale docket");
    expect(addAnyway(withReason)).not.toBe("");
    expect(addAnyway(withReason)).not.toContain(' disabled=""');
  });

  it("the card itself still renders its loading state without the warning", () => {
    const html = renderToString(createElement(JobMaterialsCard, { jobId: "job-a" }));
    expect(html).not.toContain("Possible duplicate cost");
  });
});
