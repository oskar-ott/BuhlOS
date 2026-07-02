import type {
  ProgressClaim,
  ProgressClaimLine,
  ProgressClaimStatus,
  ProgressClaimTotals,
} from "./types";

/**
 * Progress-claim money math (#372) — pure, deterministic, integer-only.
 *
 * Rules (all unit-tested; see math.test.ts):
 *   - Money is integer cents; percent is integer basis points (12.5% = 1250).
 *   - The CUMULATIVE value is the rounded figure:
 *       toDateValueCents = round(contractValueCents × toDatePctBp / 10000)
 *     and THIS claim's value is the DIFFERENCE against the prior cumulative:
 *       thisValueCents = toDateValueCents − previousValueCents
 *     so the money chain always foots exactly across claims — rounding can
 *     never drift the running total (the "cumulative footing" rule).
 *   - An unpriced line (contractValueCents = null) has null values — it is
 *     flagged, never silently treated as $0 (P7).
 *   - Over-claim guard: toDatePctBp > 10000 (past 100%) is only valid with the
 *     line's explicit `overClaimOverride`; a negative to-date position is
 *     never valid (you cannot un-claim below zero).
 *   - No derivation of percent from work: `thisPctBp` is the office's number.
 */

export const FULL_BP = 10_000;

/** Round-half-away-from-zero for integer money (symmetric for credits, so a
 *  +12.345 and −12.345 position round to ±the same cents). */
function roundHalfAwayFromZero(n: number): number {
  return n < 0 ? -Math.round(-n) : Math.round(n);
}

/** Percent (e.g. 12.5) → integer basis points (1250). Display-input helper. */
export function pctToBp(pct: number): number {
  return roundHalfAwayFromZero(pct * 100);
}

/** Basis points → display percent number (1250 → 12.5). */
export function bpToPct(bp: number): number {
  return bp / 100;
}

/** Cumulative value at a basis-point position. Integer in, integer out. */
export function valueAtBpCents(contractValueCents: number, pctBp: number): number {
  return roundHalfAwayFromZero((contractValueCents * pctBp) / FULL_BP);
}

// ── Cumulative derivation across claims ──────────────────────────────────────

export interface PreviousPosition {
  pctBp: number;
  valueCents: number;
  /** The claim the position came from (null for claim 1 / a new line). */
  claimId: string | null;
}

const COUNTED_STATUSES: ReadonlyArray<ProgressClaimStatus> = ["submitted", "certified", "paid"];

/** Claims that count toward the cumulative position (drafts never do). */
export function countedClaims(claims: ReadonlyArray<ProgressClaim>): ProgressClaim[] {
  return claims
    .filter((c) => COUNTED_STATUSES.includes(c.status))
    .sort((a, b) => a.number - b.number);
}

/**
 * The cumulative position for one piece of scope (`sourceKey`) BEFORE a new
 * claim: the latest non-draft claim carrying that sourceKey. Derivable from
 * claim records alone — never a hand-typed carry-over.
 */
export function previousPositionFor(
  sourceKey: string,
  priorClaims: ReadonlyArray<ProgressClaim>,
): PreviousPosition {
  const counted = countedClaims(priorClaims);
  for (let i = counted.length - 1; i >= 0; i--) {
    const claim = counted[i];
    if (!claim) continue;
    const line = claim.lines.find((l) => l.sourceKey === sourceKey);
    if (line) {
      return {
        pctBp: line.toDatePctBp,
        valueCents: line.toDateValueCents ?? 0,
        claimId: claim.id,
      };
    }
  }
  return { pctBp: 0, valueCents: 0, claimId: null };
}

// ── Line computation ─────────────────────────────────────────────────────────

export interface ComputedLineValues {
  toDatePctBp: number;
  toDateValueCents: number | null;
  thisValueCents: number | null;
}

/** Compute a line's stored value fields from its entered/derived fields. */
export function computeLineValues(
  line: Pick<
    ProgressClaimLine,
    "contractValueCents" | "previousPctBp" | "previousValueCents" | "thisPctBp"
  >,
): ComputedLineValues {
  const toDatePctBp = line.previousPctBp + line.thisPctBp;
  if (line.contractValueCents == null) {
    return { toDatePctBp, toDateValueCents: null, thisValueCents: null };
  }
  const toDateValueCents = valueAtBpCents(line.contractValueCents, toDatePctBp);
  return {
    toDatePctBp,
    toDateValueCents,
    thisValueCents: toDateValueCents - line.previousValueCents,
  };
}

/** A line with its computed fields refreshed (pure — input untouched). */
export function withComputedValues(line: ProgressClaimLine): ProgressClaimLine {
  return { ...line, ...computeLineValues(line) };
}

// ── Line validation (over-claim guard) ───────────────────────────────────────

export type LineValidationError =
  | { code: "over_claim"; lineId: string; toDatePctBp: number }
  | { code: "negative_to_date"; lineId: string; toDatePctBp: number };

export function validateLine(line: ProgressClaimLine): LineValidationError | null {
  const { toDatePctBp } = computeLineValues(line);
  if (toDatePctBp < 0) return { code: "negative_to_date", lineId: line.id, toDatePctBp };
  if (toDatePctBp > FULL_BP && !line.overClaimOverride) {
    return { code: "over_claim", lineId: line.id, toDatePctBp };
  }
  return null;
}

// ── Claim totals ─────────────────────────────────────────────────────────────

export function computeClaimTotals(
  lines: ReadonlyArray<ProgressClaimLine>,
  attachments: ReadonlyArray<{ valueCents: number | null }>,
): ProgressClaimTotals {
  let contractValueCents = 0;
  let previousValueCents = 0;
  let thisLinesValueCents = 0;
  let toDateValueCents = 0;
  let unpricedLineCount = 0;
  for (const raw of lines) {
    const line = withComputedValues(raw);
    if (line.contractValueCents == null) {
      unpricedLineCount++;
      continue;
    }
    contractValueCents += line.contractValueCents;
    previousValueCents += line.previousValueCents;
    thisLinesValueCents += line.thisValueCents ?? 0;
    toDateValueCents += line.toDateValueCents ?? 0;
  }
  const attachmentsValueCents = attachments.reduce((s, a) => s + (a.valueCents ?? 0), 0);
  return {
    contractValueCents,
    previousValueCents,
    thisLinesValueCents,
    attachmentsValueCents,
    thisClaimValueCents: thisLinesValueCents + attachmentsValueCents,
    toDateValueCents,
    unpricedLineCount,
  };
}

// ── Submit validation ────────────────────────────────────────────────────────

export type SubmitBlocker =
  | { code: "no_lines" }
  | { code: "nothing_claimed" }
  | LineValidationError;

/**
 * Everything that must hold before a claim freezes. Unsupported lines (no
 * evidence) and unpriced lines do NOT block — they are visible flags, the
 * office's call (P7 honesty: flagged, never hidden, never blocked on).
 */
export function validateForSubmit(claim: ProgressClaim): SubmitBlocker[] {
  const blockers: SubmitBlocker[] = [];
  if (claim.lines.length === 0 && claim.attachments.length === 0) {
    blockers.push({ code: "no_lines" });
    return blockers;
  }
  for (const line of claim.lines) {
    const err = validateLine(line);
    if (err) blockers.push(err);
  }
  const totals = computeClaimTotals(claim.lines, claim.attachments);
  const anyMovement =
    claim.lines.some((l) => l.thisPctBp !== 0) || totals.attachmentsValueCents !== 0;
  if (!anyMovement) blockers.push({ code: "nothing_claimed" });
  return blockers;
}

// ── Register derivations ─────────────────────────────────────────────────────

/**
 * The job's claimed-to-date, DERIVED from claim records (the AC: the scalar on
 * the job stops being hand-typed): the latest non-draft claim's cumulative
 * base-contract position, plus every non-draft claim's attached variation
 * sections (a variation attaches to at most one claim — store-enforced).
 */
export function deriveClaimedToDateCents(claims: ReadonlyArray<ProgressClaim>): number {
  const counted = countedClaims(claims);
  const latest = counted[counted.length - 1];
  if (!latest) return 0;
  const attachments = counted.reduce(
    (s, c) => s + c.attachments.reduce((t, a) => t + (a.valueCents ?? 0), 0),
    0,
  );
  return latest.totals.toDateValueCents + attachments;
}

/** Whole days between two ISO instants, floored at 0. */
export function daysBetween(fromIso: string, nowIso: string): number {
  const from = Date.parse(fromIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(from) || !Number.isFinite(now) || now <= from) return 0;
  return Math.floor((now - from) / 86_400_000);
}

/** Aging on unpaid claims: days since the OLDEST submitted-but-unpaid claim
 *  went in; null when nothing is awaiting payment (honest absence, not 0). */
export function oldestUnpaidClaimDays(
  claims: ReadonlyArray<ProgressClaim>,
  nowIso: string,
): number | null {
  const unpaid = claims.filter(
    (c) => (c.status === "submitted" || c.status === "certified") && c.submittedAt,
  );
  if (unpaid.length === 0) return null;
  return Math.max(...unpaid.map((c) => daysBetween(c.submittedAt as string, nowIso)));
}

/** Certified-vs-claimed variance for one claim: certified − claimed-this-claim.
 *  Null until a certified value is recorded (never a fake 0). */
export function certifiedVarianceCents(claim: ProgressClaim): number | null {
  if (claim.certifiedValueCents == null) return null;
  return claim.certifiedValueCents - claim.totals.thisClaimValueCents;
}

// ── Status transitions ───────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: ReadonlyArray<`${ProgressClaimStatus}→${ProgressClaimStatus}`> = [
  "submitted→certified",
  "certified→paid",
  // A builder can pay an uncertified claim — allowed, the variance simply
  // stays unknown (null), never invented.
  "submitted→paid",
];

export function canTransition(from: ProgressClaimStatus, to: ProgressClaimStatus): boolean {
  return ALLOWED_TRANSITIONS.includes(`${from}→${to}`);
}

/** A claim is immutable once it has left draft (amendments = a new claim). */
export function isImmutable(claim: Pick<ProgressClaim, "status">): boolean {
  return claim.status !== "draft";
}

// ── Display helpers ──────────────────────────────────────────────────────────

/** Integer cents → "$12,345.67" (en-AU; U+2212 minus, the quoting convention). */
export function formatCentsAud(cents: number | null): string {
  if (cents == null) return "—";
  const abs = Math.abs(cents);
  const s = (abs / 100).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${cents < 0 ? "−" : ""}$${s}`;
}

/** Basis points → "12.5%" (trailing zeros trimmed). */
export function formatBpPct(bp: number): string {
  const pct = bp / 100;
  return `${Number.isInteger(pct) ? pct : pct.toFixed(2).replace(/0$/, "")}%`;
}
