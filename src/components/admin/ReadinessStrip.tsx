import Link from "next/link";
import { Check } from "lucide-react";

/**
 * Pay-period readiness strip (owner redesign 2026-08-16) — one line that says
 * whether the totals below can still move. Green when every week in the
 * period is fully decided; amber (with the way back to the weekly board)
 * while workers still have undecided days. Replaces the old AttentionBanner.
 */

export function ReadinessStrip({
  fullyClosed,
  workersNeedingAction,
  weeksTotal,
}: {
  fullyClosed: boolean;
  workersNeedingAction: number;
  weeksTotal: number;
}) {
  if (weeksTotal === 0) return null;
  if (fullyClosed) {
    return (
      <div
        className="flex items-center gap-2.5 rounded-card border border-emerald-200 bg-emerald-50 px-4 py-3"
        role="status"
        data-testid="period-readiness-closed"
      >
        <Check aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-700" />
        <p className="text-sm font-medium text-emerald-900">
          Every week in this period is approved — the totals below are final.
        </p>
      </div>
    );
  }
  const n = workersNeedingAction;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-amber-200 bg-amber-50 px-4 py-3"
      role="status"
      data-testid="period-readiness-open"
    >
      <p className="text-sm font-medium text-amber-900">
        <b className="font-semibold">{n}</b> {n === 1 ? "worker still has" : "workers still have"}{" "}
        undecided days — totals can change.
      </p>
      <Link
        href="/hours/weekly"
        className="shrink-0 text-sm font-semibold text-amber-900 underline decoration-amber-400 decoration-2 underline-offset-2"
      >
        Finish on This week →
      </Link>
    </div>
  );
}
