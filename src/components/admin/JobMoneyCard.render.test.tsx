import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

import { JobMoneyCard, JobMoneyFigures } from "./JobMoneyCard";
import {
  formatMoneyCents,
  type BudgetLine,
  type JobProfitabilityResponse,
} from "@/domains/jobs/profitability-client";

/**
 * The hub's ONE money card (2026-08-09 job-hub audit). renderToString skips
 * the mount fetch, so the shell test pins the initial contract: title, ex-GST
 * framing, and a skeleton — no "Loading…" text, no fabricated figures.
 *
 * JobMoneyFigures is the loaded body as a pure function of the payload, so the
 * states the 2026-08-23 audit found misreported (L2/U2/U4) are pinned here.
 */
describe("JobMoneyCard — initial render", () => {
  it("renders the Money title, ex-GST note, and a loading skeleton", () => {
    const html = renderToString(createElement(JobMoneyCard, { jobId: "job-a" }));
    expect(html).toContain("Money");
    expect(html).toContain("ex GST");
    expect(html).toContain("money-skeleton");
    expect(html).not.toContain("$");
  });
});

function line(actualCents: number, budgetCents: number | null): BudgetLine {
  const varianceCents = budgetCents == null ? null : actualCents - budgetCents;
  return {
    actualCents,
    budgetCents,
    varianceCents,
    variancePct: budgetCents ? Math.round(((varianceCents ?? 0) / budgetCents) * 100) : null,
  };
}

/** The production state the audit measured on Birdwood (2026-08-23): 252.2
 *  approved hours, no cost rates, no contract value, no estimates, no materials. */
function prodState(over: Partial<JobProfitabilityResponse> = {}): JobProfitabilityResponse {
  return {
    jobId: "birdwood",
    contractValueCents: null,
    labourCostCents: 0,
    materialCostCents: 0,
    marginCents: null,
    marginPct: null,
    completeness: { labour: "understated", material: "none", unratedWorkers: ["Jake Preston"] },
    unratedWorkerRefs: [{ userId: "u1", name: "Jake Preston", employeeId: "emp_1" }],
    labourChargeOutCents: null,
    chargeOutHours: 0,
    badges: ["1 worker unrated", "no material data", "no contract value set"],
    budget: { labourEstimateCents: null, materialEstimateCents: null },
    variance: { labour: line(0, null), material: line(0, null), total: line(0, null) },
    hoursTotal: 252.2,
    asOf: "2026-08-23T00:00:00.000Z",
    ...over,
  };
}

function figures(data: JobProfitabilityResponse, materialsLedgerEnabled = false): string {
  return renderToString(
    createElement(JobMoneyFigures, {
      jobId: data.jobId,
      data,
      materialsLedgerEnabled,
      onSaved: async () => true,
    })
  );
}

describe("JobMoneyFigures — the audit's production state (L2)", () => {
  it("says '252h 12m approved · no cost rates set' — never 'no hours yet' over real hours", () => {
    const html = figures(prodState());
    expect(html).toContain("252h 12m approved · no cost rates set");
    expect(html).not.toContain("no hours yet");
  });

  it("ALWAYS shows the understated note, linking the unrated worker to their employee record", () => {
    const html = figures(prodState());
    expect(html).toContain('data-testid="money-notes"');
    expect(html).toContain("Labour is understated");
    expect(html).toContain("Jake Preston");
    expect(html).toContain("/employees/emp_1");
  });

  it("offers inline estimates instead of a dead 'Add an estimate' link (U2)", () => {
    const html = figures(prodState());
    expect(html).toContain("Set labour and materials estimates");
    expect(html).not.toContain("/builder");
  });

  it("materials caption is true to the flag: 'not tracked yet' off, 'nothing recorded yet' on", () => {
    expect(figures(prodState(), false)).toContain("not tracked yet");
    expect(figures(prodState(), true)).toContain("nothing recorded yet");
    expect(figures(prodState(), true)).not.toContain("no orders yet");
  });

  it("with no approved hours at all the labour caption says so", () => {
    const html = figures(
      prodState({
        hoursTotal: 0,
        completeness: { labour: "complete", material: "none", unratedWorkers: [] },
        unratedWorkerRefs: [],
      })
    );
    expect(html).toContain("no approved hours yet");
    expect(html).not.toContain("Labour is understated");
  });
});

describe("JobMoneyFigures — real figures", () => {
  it("shows costed labour with its hours, the ledger-sourced materials, and margin", () => {
    const html = figures(
      prodState({
        contractValueCents: 12_000_000,
        labourCostCents: 1_261_000,
        materialCostCents: 18_450,
        marginCents: 12_000_000 - 1_261_000 - 18_450,
        marginPct: 89,
        completeness: { labour: "complete", material: "ledger", unratedWorkers: [] },
        unratedWorkerRefs: [],
        variance: {
          labour: line(1_261_000, null),
          material: line(18_450, null),
          total: line(1_279_450, 12_000_000),
        },
      }),
      true
    );
    expect(html).toContain(formatMoneyCents(1_261_000)); // $12,610
    expect(html).toContain("252h 12m approved");
    expect(html).toContain("$184.50");
    expect(html).toContain("from the spend ledger");
    expect(html).toContain("Margin · 89%");
    expect(html).not.toContain("before uncosted labour");
  });

  it("a margin over uncosted labour is captioned 'before uncosted labour'", () => {
    const html = figures(
      prodState({ contractValueCents: 12_000_000, marginCents: 12_000_000, marginPct: 100 })
    );
    expect(html).toContain("before uncosted labour");
  });

  it("renders the variance table with an 'Edit estimates' affordance once an estimate exists", () => {
    const html = figures(
      prodState({
        budget: { labourEstimateCents: 5_000_000, materialEstimateCents: null },
        variance: { labour: line(0, 5_000_000), material: line(0, null), total: line(0, null) },
      })
    );
    expect(html).toContain("Against estimate");
    expect(html).toContain("Edit estimates");
    expect(html).toContain("No estimate"); // the unset material line, never a fake 0
    expect(html).not.toContain("Set labour and materials estimates");
  });

  it("states the charge-out value, and how many of the hours carried a charge-out rate", () => {
    const html = figures(
      prodState({ labourChargeOutCents: 1_000_000, chargeOutHours: 100, hoursTotal: 120 })
    );
    expect(html).toContain("worth $10,000");
    expect(html).toContain("100h of 120h");
  });

  it("labels the legacy received-materials rollup a proxy", () => {
    const html = figures(
      prodState({
        materialCostCents: 3_000_000,
        completeness: {
          labour: "understated",
          material: "received_proxy",
          unratedWorkers: ["Jake Preston"],
        },
      })
    );
    expect(html).toContain("$30,000");
    expect(html).toContain("proxy");
    expect(html).toContain("actual usage isn");
  });
});

/** Kept from the deleted JobProfitabilitySummary test — the formatter contract. */
describe("formatMoneyCents", () => {
  it("formats whole dollars and cents, handles negatives and null", () => {
    expect(formatMoneyCents(12_000_000)).toBe("$120,000");
    expect(formatMoneyCents(4_537_550)).toBe("$45,375.50");
    expect(formatMoneyCents(-30_000)).toBe("-$300");
    expect(formatMoneyCents(null)).toBe("—");
  });
});
