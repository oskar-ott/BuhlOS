import type { ExceptionItem } from "@/domains/exceptions/types";
import { sortExceptions } from "@/domains/exceptions/service";

/**
 * Pure derivations for the mobile Command Centre ("Today").
 *
 * The mobile home is a SIMPLER projection of the SAME already-loaded,
 * admin-gated sources the desktop page uses — no new read-model. These helpers
 * keep the page thin and the behaviour unit-testable (mirrors the house pattern
 * in itp-queue-card.ts / queue-card-targets.ts).
 *
 * Truth over theatre (P7): counts come only from sources that genuinely exist.
 * Hours are a WEEKLY payroll closeout, so they are NOT part of the daily
 * "to approve" total; that total is the day-to-day office queues that have a
 * real approve action today — expenses + ITPs + materials. (Proof to sign off
 * is added by the flagged PR6 surface; dayworks has no office-approval concept,
 * so it is deliberately excluded.)
 */

export interface MobileTodayApprovals {
  /** Submitted expense claims awaiting review (/api/expenses?status=submitted). */
  expenses: number;
  /** Witnessed ITPs awaiting sign-off (statsItpsNeedsReview rollup). */
  itps: number;
  /** Open material requests awaiting the office (/api/material-requests). */
  materials: number;
}

export interface MobileTodayNeedsYou {
  /** The loudest few items, ranked (severity → actionable → oldest). */
  top: ExceptionItem[];
  /** How many more beyond `top`. */
  remaining: number;
  /** The full ranked list (for "View all"). */
  all: ExceptionItem[];
}

/**
 * Day-to-day approvals total for the "to approve" pulse — the queues that route
 * to /hours/approvals: expenses + ITPs + materials. Hours are a weekly closeout
 * (excluded); proof-to-sign-off has its OWN surface on Today (the Command
 * Centre proof section), so it is NOT folded into this hub-bound count.
 */
export function dailyApprovalsTotal(a: MobileTodayApprovals): number {
  return a.expenses + a.itps + a.materials;
}

/**
 * Rank the exceptions and split off the loudest `limit`. buildExceptions
 * already returns sorted, but we re-sort defensively so this helper is correct
 * for any caller order.
 */
export function rankNeedsYou(
  items: ReadonlyArray<ExceptionItem>,
  limit = 4
): MobileTodayNeedsYou {
  const all = sortExceptions(items);
  const top = all.slice(0, limit);
  return { top, remaining: Math.max(0, all.length - top.length), all };
}
