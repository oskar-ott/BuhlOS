import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { portionCents as clientPortion } from "@/components/admin/customer-invoices/StageEditor";

/**
 * api/_lib/customer-invoices/amounts.js + status.js — the pure money maths
 * and the one status a person reads. Integer cents and basis points only; a
 * figure that can't be worked out is null, never 0.
 */
const requireFromHere = createRequire(import.meta.url);
const A = requireFromHere("../../../api/_lib/customer-invoices/amounts.js");
const S = requireFromHere("../../../api/_lib/customer-invoices/status.js");

const amountStage = (amountCents: number, over: Record<string, unknown> = {}) => ({
  kind: "stage", basis: "amount", amountCents, percentBp: null, extraLines: [], retentionBp: null, state: "planned", ...over,
});
const percentStage = (percentBp: number, over: Record<string, unknown> = {}) => ({
  kind: "stage", basis: "percent", amountCents: null, percentBp, extraLines: [], retentionBp: null, state: "planned", ...over,
});

describe("portionCents", () => {
  it("rounds half-up to the cent with integer arithmetic", () => {
    expect(A.portionCents(100_000_00, 2000)).toBe(20_000_00); // 20% of $100,000
    expect(A.portionCents(33_333_33, 3333)).toBe(11_110_00); // 3,333,333c × 0.3333 = 1,110,999.89 → 1,111,000c
    expect(A.portionCents(1, 5000)).toBe(1); // half a cent rounds up
    expect(A.portionCents(1, 4999)).toBe(0);
    expect(A.portionCents(0, 500)).toBe(0);
    expect(A.portionCents(12_345_67, 0)).toBe(0);
    expect(A.portionCents(12_345_67, 10000)).toBe(12_345_67);
  });

  it("refuses non-integers and out-of-range percentages rather than guessing", () => {
    expect(A.portionCents(10.5, 500)).toBeNull();
    expect(A.portionCents(1000, 10001)).toBeNull();
    expect(A.portionCents(1000, -1)).toBeNull();
    expect(A.portionCents(1000, 2.5)).toBeNull();
  });

  it("matches the rounding the stage editor previews with", () => {
    for (const [amount, bp] of [[100_000_00, 2000], [33_333_33, 3333], [1, 5000], [1, 4999], [987_654_321, 1275]]) {
      expect(clientPortion(amount!, bp!)).toBe(A.portionCents(amount, bp));
    }
  });
});

describe("contractCentsOf", () => {
  it("turns the job record's dollars into cents and treats unset / zero as unknown", () => {
    expect(A.contractCentsOf(250000)).toBe(250_000_00);
    expect(A.contractCentsOf(1234.56)).toBe(1_234_56);
    expect(A.contractCentsOf(null)).toBeNull();
    expect(A.contractCentsOf(undefined)).toBeNull();
    expect(A.contractCentsOf(0)).toBeNull();
    expect(A.contractCentsOf("abc")).toBeNull();
  });
});

describe("computeStage", () => {
  it("a dollar stage is its amount plus its extra lines", () => {
    const c = A.computeStage(
      amountStage(12_000_00, { extraLines: [{ description: "Variation 3", amountCents: 1_200_00 }] }),
      { contractCents: null, retentionBp: 0 }
    );
    expect(c).toMatchObject({ baseCents: 12_000_00, extrasCents: 1_200_00, grossCents: 13_200_00, retentionCents: 0, netCents: 13_200_00, reason: null });
  });

  it("a % stage is worked out from the job's contract value", () => {
    const c = A.computeStage(percentStage(3000), { contractCents: 250_000_00, retentionBp: 0 });
    expect(c.grossCents).toBe(75_000_00);
    expect(c.netCents).toBe(75_000_00);
  });

  it("a % stage with no contract value is unknown — named, never $0", () => {
    const c = A.computeStage(percentStage(3000), { contractCents: null, retentionBp: 500 });
    expect(c).toMatchObject({ grossCents: null, retentionCents: null, netCents: null, reason: "no_contract_value" });
  });

  it("takes the job's retention off the gross, extras included", () => {
    const c = A.computeStage(
      amountStage(10_000_00, { extraLines: [{ description: "Extra", amountCents: 2_000_00 }] }),
      { contractCents: null, retentionBp: 500 }
    );
    expect(c).toMatchObject({ grossCents: 12_000_00, retentionBp: 500, retentionCents: 600_00, netCents: 11_400_00 });
  });

  it("a stage's own retention overrides the job's — including 0 for none", () => {
    expect(A.computeStage(amountStage(10_000_00, { retentionBp: 1000 }), { contractCents: null, retentionBp: 500 }).retentionCents).toBe(1_000_00);
    expect(A.computeStage(amountStage(10_000_00, { retentionBp: 0 }), { contractCents: null, retentionBp: 500 }).retentionCents).toBe(0);
  });

  it("never takes retention from a retention release", () => {
    const c = A.computeStage(amountStage(5_000_00, { kind: "retention_release" }), { contractCents: null, retentionBp: 500 });
    expect(c).toMatchObject({ retentionBp: 0, retentionCents: 0, netCents: 5_000_00 });
  });

  it("flags unusable content as invalid instead of producing a figure", () => {
    expect(A.computeStage(amountStage(-5), { contractCents: null }).reason).toBe("invalid");
    expect(A.computeStage(percentStage(0), { contractCents: 100_00 }).reason).toBe("invalid");
    expect(A.computeStage({ basis: "amount", amountCents: null }, { contractCents: null }).reason).toBe("invalid");
  });
});

const sent = (over: Record<string, unknown>) => ({
  kind: "stage", basis: "amount", state: "sent", extraLines: [],
  grossCents: 0, retentionCents: 0, netCents: 0, xeroStatus: "DRAFT",
  xeroSubtotalCents: null, xeroTotalCents: null, xeroAmountPaidCents: null, xeroAmountDueCents: null, ...over,
});

describe("jobTotals", () => {
  it("an empty job has nothing planned and the whole contract still to invoice", () => {
    const t = A.jobTotals([], { contractCents: 100_000_00, retentionBp: 0 });
    expect(t).toMatchObject({ plannedCount: 0, plannedGrossCents: 0, claimedCents: 0, stillToInvoiceCents: 100_000_00, overContract: false, retentionHeldCents: 0 });
  });

  it("with no contract value, still-to-invoice is unknown, not zero", () => {
    const t = A.jobTotals([amountStage(5_000_00)], { contractCents: null, retentionBp: 0 });
    expect(t.stillToInvoiceCents).toBeNull();
    expect(t.plannedGrossCents).toBe(5_000_00);
    expect(t.overContract).toBe(false);
  });

  it("counts planned stages and names the ones that can't be worked out", () => {
    const t = A.jobTotals([amountStage(5_000_00), percentStage(2000)], { contractCents: null, retentionBp: 0 });
    expect(t.plannedCount).toBe(2);
    expect(t.unresolvedCount).toBe(1);
    expect(t.plannedGrossCents).toBe(5_000_00);
  });

  it("planning does not reduce still-to-invoice; only a sent stage does", () => {
    const planned = A.jobTotals([percentStage(2000), percentStage(3000)], { contractCents: 100_000_00, retentionBp: 0 });
    expect(planned.plannedGrossCents).toBe(50_000_00);
    expect(planned.stillToInvoiceCents).toBe(100_000_00);

    const withSent = A.jobTotals(
      [sent({ grossCents: 20_000_00, netCents: 20_000_00, xeroSubtotalCents: 20_000_00 }), percentStage(3000)],
      { contractCents: 100_000_00, retentionBp: 0 }
    );
    expect(withSent.claimedCents).toBe(20_000_00);
    expect(withSent.stillToInvoiceCents).toBe(80_000_00);
    expect(withSent.plannedGrossCents).toBe(30_000_00);
  });

  it("warns (does not block) when planned + claimed pass the contract", () => {
    const t = A.jobTotals([percentStage(6000), percentStage(6000)], { contractCents: 100_000_00, retentionBp: 0 });
    expect(t.overContract).toBe(true);
    expect(A.jobTotals([percentStage(5000), percentStage(5000)], { contractCents: 100_000_00, retentionBp: 0 }).overContract).toBe(false);
  });

  it("claims the gross against the contract and tracks the retention held", () => {
    const t = A.jobTotals(
      [
        sent({ grossCents: 20_000_00, retentionCents: 1_000_00, netCents: 19_000_00, xeroStatus: "AUTHORISED", xeroSubtotalCents: 19_000_00, xeroTotalCents: 20_900_00, xeroAmountPaidCents: 0, xeroAmountDueCents: 20_900_00 }),
        sent({ grossCents: 30_000_00, retentionCents: 1_500_00, netCents: 28_500_00, xeroStatus: "DRAFT", xeroSubtotalCents: 28_500_00 }),
      ],
      { contractCents: 100_000_00, retentionBp: 500 }
    );
    expect(t.claimedCents).toBe(50_000_00);
    expect(t.stillToInvoiceCents).toBe(50_000_00);
    expect(t.retentionHeldCents).toBe(2_500_00);
    expect(t.invoicedCents).toBe(19_000_00); // approved in Xero
    expect(t.draftedCents).toBe(28_500_00); // still a draft in Xero
    expect(t.dueIncGstCents).toBe(20_900_00);
  });

  it("a retention release lowers the retention held and is not a new claim on the contract", () => {
    const t = A.jobTotals(
      [
        sent({ grossCents: 100_000_00, retentionCents: 5_000_00, netCents: 95_000_00, xeroStatus: "PAID", xeroSubtotalCents: 95_000_00, xeroTotalCents: 104_500_00, xeroAmountPaidCents: 104_500_00, xeroAmountDueCents: 0 }),
        sent({ kind: "retention_release", grossCents: 2_500_00, netCents: 2_500_00, xeroStatus: "DRAFT", xeroSubtotalCents: 2_500_00 }),
      ],
      { contractCents: 100_000_00, retentionBp: 500 }
    );
    expect(t.claimedCents).toBe(100_000_00);
    expect(t.stillToInvoiceCents).toBe(0);
    expect(t.retentionHeldCents).toBe(2_500_00);
  });

  it("voided and deleted invoices drop out of every total", () => {
    const t = A.jobTotals(
      [
        sent({ grossCents: 20_000_00, retentionCents: 1_000_00, xeroStatus: "VOIDED", xeroSubtotalCents: 19_000_00 }),
        sent({ grossCents: 30_000_00, retentionCents: 1_500_00, xeroStatus: "DELETED", xeroSubtotalCents: 28_500_00 }),
      ],
      { contractCents: 100_000_00, retentionBp: 500 }
    );
    expect(t).toMatchObject({ sentCount: 0, claimedCents: 0, stillToInvoiceCents: 100_000_00, retentionHeldCents: 0, invoicedCents: 0, draftedCents: 0 });
  });

  it("turns Xero's GST-inclusive payment into its ex-GST share, pro rata on Xero's own totals", () => {
    const t = A.jobTotals(
      [sent({ grossCents: 10_000_00, netCents: 10_000_00, xeroStatus: "AUTHORISED", xeroSubtotalCents: 10_000_00, xeroTotalCents: 11_000_00, xeroAmountPaidCents: 5_500_00, xeroAmountDueCents: 5_500_00 })],
      { contractCents: 50_000_00, retentionBp: 0 }
    );
    expect(t.paidIncGstCents).toBe(5_500_00);
    expect(t.paidCents).toBe(5_000_00);
  });

  it("says 'unknown' rather than guess when a payment can't be split", () => {
    const t = A.jobTotals(
      [sent({ grossCents: 10_000_00, xeroStatus: "PAID", xeroSubtotalCents: null, xeroTotalCents: null, xeroAmountPaidCents: 11_000_00 })],
      { contractCents: 50_000_00, retentionBp: 0 }
    );
    expect(t.paidIncGstCents).toBe(11_000_00);
    expect(t.paidCents).toBeNull();
  });

  it("a stage mid-send or failed counts as planned, at its frozen figures when it has them", () => {
    const t = A.jobTotals(
      [amountStage(9_999_00, { state: "sending", grossCents: 8_000_00, netCents: 7_600_00 }), amountStage(1_000_00, { state: "failed" })],
      { contractCents: 50_000_00, retentionBp: 0 }
    );
    expect(t.plannedCount).toBe(2);
    expect(t.plannedGrossCents).toBe(9_000_00);
    expect(t.claimedCents).toBe(0);
  });
});

describe("displayStatus", () => {
  const today = "2026-11-22";
  const row = (over: Record<string, unknown>) => ({ state: "sent", xeroStatus: "AUTHORISED", xeroAmountPaidCents: 0, xeroAmountDueCents: 11_000_00, xeroDueDate: "2026-12-22", ...over });

  it("reads BuhlOS's own state until the stage is sent", () => {
    expect(S.displayStatus({ state: "planned" }, today)).toBe("planned");
    expect(S.displayStatus({ state: "sending" }, today)).toBe("sending");
    expect(S.displayStatus({ state: "failed" }, today)).toBe("failed");
    expect(S.displayStatus({ state: "cancelled" }, today)).toBe("cancelled");
  });

  it("reads Xero's status once sent", () => {
    expect(S.displayStatus(row({ xeroStatus: "DRAFT" }), today)).toBe("draft_in_xero");
    expect(S.displayStatus(row({ xeroStatus: "SUBMITTED" }), today)).toBe("draft_in_xero");
    expect(S.displayStatus(row({}), today)).toBe("awaiting_payment");
    expect(S.displayStatus(row({ xeroAmountPaidCents: 5_000_00, xeroAmountDueCents: 6_000_00 }), today)).toBe("part_paid");
    expect(S.displayStatus(row({ xeroStatus: "PAID", xeroAmountDueCents: 0 }), today)).toBe("paid");
    expect(S.displayStatus(row({ xeroStatus: "VOIDED" }), today)).toBe("voided");
    expect(S.displayStatus(row({ xeroStatus: "DELETED" }), today)).toBe("deleted_in_xero");
  });

  it("is overdue only when approved, still owing, and past Xero's due date", () => {
    expect(S.displayStatus(row({ xeroDueDate: "2026-11-21" }), today)).toBe("overdue");
    expect(S.displayStatus(row({ xeroDueDate: "2026-11-22" }), today)).toBe("awaiting_payment"); // due today is not overdue
    expect(S.displayStatus(row({ xeroDueDate: "2026-11-01", xeroAmountPaidCents: 3_000_00 }), today)).toBe("overdue");
    expect(S.displayStatus(row({ xeroStatus: "DRAFT", xeroDueDate: "2026-11-01" }), today)).toBe("draft_in_xero");
  });

  it("a sent row Xero hasn't been read for yet is named, not assumed", () => {
    expect(S.displayStatus({ state: "sent", xeroStatus: null }, today)).toBe("sent_unchecked");
  });
});
