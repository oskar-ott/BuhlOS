import type { Daywork, DayworkStatus } from "./types";

/**
 * Pure daywork logic (#370) — no I/O, no UI. Ref minting, unsigned-aging,
 * status transitions, immutability/amendment and the register summary. Every
 * time-dependent function takes an injected `nowMs` so it stays deterministic
 * and unit-testable (the exceptions/service.ts convention).
 */

export const UNSIGNED_AGING_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h

// ── Sequential references ────────────────────────────────────────────────────

/**
 * The next sequence number for a job's dockets: max(seq) + 1, NEVER array
 * length — a deleted docket must not let a later one reuse its ref.
 */
export function nextDayworkSeq(existing: ReadonlyArray<{ seq: number }>): number {
  let max = 0;
  for (const d of existing) if (d.seq > max) max = d.seq;
  return max + 1;
}

/** "DW-001". Pads to three digits; counts past 999 widen (DW-1000). */
export function formatDayworkRef(seq: number): string {
  return `DW-${String(seq).padStart(3, "0")}`;
}

// ── Status pipeline — unsigned → signed → invoiced (forward only) ────────────

const TRANSITIONS: ReadonlyArray<readonly [DayworkStatus | null, DayworkStatus]> = [
  [null, "unsigned"], // create
  ["unsigned", "signed"],
  ["signed", "invoiced"],
];

/** Whether a status change is allowed. There is no un-signing (immutability)
 *  and no skipping straight to invoiced. */
export function canTransition(from: DayworkStatus | null, to: DayworkStatus): boolean {
  return TRANSITIONS.some(([f, t]) => f === from && t === to);
}

export function allowedTransitions(): ReadonlyArray<readonly [DayworkStatus | null, DayworkStatus]> {
  return TRANSITIONS;
}

// ── Unsigned-aging (payment risk) ────────────────────────────────────────────

export function dayworkAgeMs(createdAt: string, nowMs: number): number {
  return nowMs - Date.parse(createdAt);
}

/** An unsigned docket older than the threshold is payment risk. A signed or
 *  invoiced docket is never "aging" regardless of age. */
export function isUnsignedAging(
  docket: Pick<Daywork, "status" | "createdAt">,
  nowMs: number,
  thresholdMs: number = UNSIGNED_AGING_THRESHOLD_MS,
): boolean {
  if (docket.status !== "unsigned") return false;
  return dayworkAgeMs(docket.createdAt, nowMs) > thresholdMs;
}

// ── Immutability / amendment ─────────────────────────────────────────────────

/** A signed or invoiced docket is byte-immutable. */
export function isImmutable(status: DayworkStatus): boolean {
  return status === "signed" || status === "invoiced";
}

/**
 * Guard for the amendment path: you only AMEND an immutable docket. An unsigned
 * docket is edited directly. Throws when the original is not immutable.
 */
export function assertAmendmentAllowed(original: Pick<Daywork, "status">): void {
  if (!isImmutable(original.status)) {
    throw new Error("only a signed or invoiced docket is amended — edit an unsigned docket directly");
  }
}

/**
 * Seed fields for an amendment docket. Carries the original's content and a
 * back-link; the server mints a fresh id/ref/seq and stamps the actor. The
 * original is never mutated (the caller flags it `amended: true` separately).
 */
export function buildAmendmentSeed(
  original: Daywork,
): Pick<
  Daywork,
  "jobId" | "jobName" | "description" | "labourLines" | "materialLines" | "amendmentOfId" | "status" | "signature"
> {
  assertAmendmentAllowed(original);
  return {
    jobId: original.jobId,
    jobName: original.jobName,
    description: original.description,
    labourLines: original.labourLines,
    materialLines: original.materialLines,
    amendmentOfId: original.id,
    status: "unsigned",
    signature: null,
  };
}

// ── Register ordering & summary ──────────────────────────────────────────────

const STATUS_RANK: Record<DayworkStatus, number> = { unsigned: 1, signed: 2, invoiced: 3 };

/** Exception-first ordering for the register: unsigned-aging at the top, then
 *  unsigned, signed, invoiced; within a bucket, newest first. */
export function compareForRegister(
  a: Pick<Daywork, "status" | "createdAt" | "seq">,
  b: Pick<Daywork, "status" | "createdAt" | "seq">,
  nowMs: number,
): number {
  const agingA = isUnsignedAging(a, nowMs) ? 0 : 1;
  const agingB = isUnsignedAging(b, nowMs) ? 0 : 1;
  if (agingA !== agingB) return agingA - agingB;
  if (STATUS_RANK[a.status] !== STATUS_RANK[b.status]) {
    return STATUS_RANK[a.status] - STATUS_RANK[b.status];
  }
  return b.seq - a.seq;
}

export interface DayworkRegisterSummary {
  total: number;
  unsigned: number;
  signed: number;
  invoiced: number;
  /** Unsigned dockets past the aging threshold — the payment-risk count. */
  unsignedAging: number;
}

export function summariseRegister(
  dockets: ReadonlyArray<Pick<Daywork, "status" | "createdAt">>,
  nowMs: number,
): DayworkRegisterSummary {
  const summary: DayworkRegisterSummary = {
    total: dockets.length,
    unsigned: 0,
    signed: 0,
    invoiced: 0,
    unsignedAging: 0,
  };
  for (const d of dockets) {
    summary[d.status] += 1;
    if (isUnsignedAging(d, nowMs)) summary.unsignedAging += 1;
  }
  return summary;
}
