import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { JobSupplierInvoicesCard } from "./JobSupplierInvoicesCard";
import { InvoiceInboxClient } from "./InvoiceInboxClient";
import { InvoiceReviewClient } from "./InvoiceReviewClient";
import { NAV_GROUPS, visibleNavGroups } from "../nav";

/**
 * Initial-render contracts (renderToString skips the mount fetch): loading
 * states are honest skeletons, no fabricated figures, and the nav item for
 * invoices disappears entirely when its href is hidden (flag off).
 */
describe("supplier-invoice surfaces — initial render", () => {
  it("the hub card renders its anchor and a skeleton, never a $ figure", () => {
    const html = renderToString(createElement(JobSupplierInvoicesCard, { jobId: "job-a" }));
    expect(html).toContain("Materials used");
    expect(html).toContain('id="supplier-invoices"');
    expect(html).toContain("supplier-invoices-skeleton");
    expect(html).not.toContain("$");
  });
  it("the inbox renders its filters, the upload action and a loading skeleton", () => {
    const html = renderToString(createElement(InvoiceInboxClient, {}));
    expect(html).toContain("Needs review");
    expect(html).toContain("Upload a PDF");
    expect(html).toContain("invoice-inbox-skeleton");
    expect(html).toContain("Search supplier, invoice number, IV reference");
    expect(html).not.toContain("$");
  });
  it("the review screen starts as a skeleton", () => {
    const html = renderToString(createElement(InvoiceReviewClient, { invoiceId: "00000000-0000-4000-8000-000000000001" }));
    expect(html).toContain("invoice-review-skeleton");
  });
});

describe("nav — the Invoices item is flag-gated", () => {
  it("exists in the Jobs group behind invoice_capture and vanishes when hidden", () => {
    const jobsGroup = NAV_GROUPS.find((g) => g.heading === "Jobs")!;
    const item = jobsGroup.items.find((i) => i.href === "/invoices");
    expect(item).toMatchObject({ label: "Invoices", flag: "invoice_capture" });
    expect(item?.countKey).toBeUndefined();
    const hidden = visibleNavGroups(["/invoices"]);
    expect(hidden.flatMap((g) => g.items).some((i) => i.href === "/invoices")).toBe(false);
    expect(hidden.find((g) => g.heading === "Jobs")?.items.map((i) => i.href)).toEqual(["/v2/jobs"]);
  });
});
