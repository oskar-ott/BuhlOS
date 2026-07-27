import type { ExceptionItem } from "@/domains/exceptions/types";
import { sortExceptions } from "@/domains/exceptions/service";

/**
 * Pure derivations for the mobile Command Centre ("Today").
 *
 * The mobile home is a SIMPLER projection of the SAME already-loaded,
 * admin-gated sources the desktop page uses — no new read-model. These helpers
 * keep the page thin and the behaviour unit-testable (mirrors the house pattern
 * in queue-card-targets.ts).
 *
 * Truth over theatre (P7): counts come only from sources that genuinely exist.
 */

export interface MobileTodayNeedsYou {
  /** The loudest few items, ranked (severity → actionable → oldest). */
  top: ExceptionItem[];
  /** How many more beyond `top`. */
  remaining: number;
  /** The full ranked list (for "View all"). */
  all: ExceptionItem[];
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
