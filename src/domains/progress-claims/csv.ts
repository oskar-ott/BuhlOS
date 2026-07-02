import { withComputedValues } from "./math";
import type { ProgressClaim } from "./types";

/**
 * Payapps-ready CSV export (#372 AC5) — a DETERMINISTIC flat file matching
 * Payapps claim keying: line ref, description, contract value, previously
 * claimed %, this claim %, this value, claimed-to-date value. No Payapps API
 * in this issue; the export is for keying in (it never claims it was
 * "uploaded"). Money is plain dollars with two decimals ("1234.50" — no $ or
 * thousands separators, so spreadsheet/import tools parse it), percent is
 * plain numbers ("12.5").
 *
 * Attached variation sections export as their own rows under a section marker
 * — by reference to the variation register, never duplicated money math.
 */

const HEADER = [
  "Line ref",
  "Section",
  "Description",
  "Contract value",
  "Previously claimed %",
  "Previously claimed value",
  "This claim %",
  "This claim value",
  "Claimed to date %",
  "Claimed to date value",
  "Evidence linked",
] as const;

function csvCell(v: string | number | null): string {
  if (v == null) return '""';
  return `"${String(v).replace(/"/g, '""')}"`;
}

/** Integer cents → "1234.50"; empty for null (unpriced — never a fake 0). */
export function centsToCsvMoney(cents: number | null): string {
  if (cents == null) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const rem = String(abs % 100).padStart(2, "0");
  return `${sign}${dollars}.${rem}`;
}

/** Basis points → "12.5" (max 2dp, trailing zeros trimmed). */
export function bpToCsvPct(bp: number): string {
  const pct = bp / 100;
  return Number.isInteger(pct) ? String(pct) : String(Math.round(pct * 100) / 100);
}

export function claimCsvFilename(jobId: string, claim: ProgressClaim): string {
  const status = claim.status === "draft" ? "-DRAFT" : "";
  return `progress-claim-${jobId}-claim-${claim.number}${status}.csv`;
}

export function claimToCsv(claim: ProgressClaim): string {
  const rows: string[][] = [[...HEADER]];
  for (const raw of [...claim.lines].sort((a, b) => a.order - b.order)) {
    const line = withComputedValues(raw);
    rows.push([
      line.lineRef,
      line.sectionLabel ?? "",
      line.description,
      centsToCsvMoney(line.contractValueCents),
      bpToCsvPct(line.previousPctBp),
      centsToCsvMoney(line.contractValueCents == null ? null : line.previousValueCents),
      bpToCsvPct(line.thisPctBp),
      centsToCsvMoney(line.thisValueCents),
      bpToCsvPct(line.toDatePctBp),
      centsToCsvMoney(line.toDateValueCents),
      String(line.evidenceRefs.length),
    ]);
  }
  for (const att of claim.attachments) {
    rows.push([
      att.ref ?? att.id,
      att.kind === "variation" ? "Variations" : "Dayworks",
      att.label,
      "",
      "",
      "",
      "",
      centsToCsvMoney(att.valueCents),
      "",
      centsToCsvMoney(att.valueCents),
      "",
    ]);
  }
  const t = claim.totals;
  rows.push([
    "TOTAL",
    "",
    claim.status === "draft" ? "DRAFT — not submitted" : `Claim ${claim.number}`,
    centsToCsvMoney(t.contractValueCents),
    "",
    centsToCsvMoney(t.previousValueCents),
    "",
    centsToCsvMoney(t.thisClaimValueCents),
    "",
    centsToCsvMoney(t.toDateValueCents + t.attachmentsValueCents),
    "",
  ]);
  return rows.map((r) => r.map(csvCell).join(",")).join("\n");
}
