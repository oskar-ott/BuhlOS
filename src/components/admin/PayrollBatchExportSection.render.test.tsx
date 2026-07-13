import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { PayrollBatchExportSection } from "./PayrollBatchExportSection";

/**
 * Static-render guards for the draft-timesheet export controls (#249).
 * Initial surface only (effects don't run under renderToString): the CSV
 * download is always present; the Export/Retry/Reconcile controls appear only
 * when the write flag is on, and Retry/Reconcile only once a batch has moved
 * past 'locked'.
 */

const render = (props: { batchStatus: string; exportEnabled: boolean }) =>
  renderToString(createElement(PayrollBatchExportSection, { batchId: "b-1", ...props }));

describe("PayrollBatchExportSection", () => {
  it("flag OFF: CSV download only, an explicit off note, no write controls", () => {
    const html = render({ batchStatus: "locked", exportEnabled: false });
    expect(html).toContain("Download batch CSV");
    expect(html).toContain("format=csv");
    expect(html).toContain("export is off");
    expect(html).not.toContain("Preview export");
    expect(html).not.toContain("Export to Xero");
  });

  it("flag ON, locked batch: Preview + Export + CSV, but no Retry/Reconcile yet", () => {
    const html = render({ batchStatus: "locked", exportEnabled: true });
    expect(html).toContain("Preview export");
    expect(html).toContain("Export to Xero");
    expect(html).toContain("Download batch CSV");
    expect(html).not.toContain("Retry failed");
    expect(html).not.toContain("Reconcile");
  });

  it("flag ON, partially exported: Retry + Reconcile become available", () => {
    const html = render({ batchStatus: "partially_exported", exportEnabled: true });
    expect(html).toContain("Retry failed");
    expect(html).toContain("Reconcile");
  });

  it("the CSV link targets the export endpoint's csv format", () => {
    const html = render({ batchStatus: "exported", exportEnabled: true });
    expect(html).toContain("/api/xero/payroll-export?batchId=b-1&amp;format=csv");
  });
});
