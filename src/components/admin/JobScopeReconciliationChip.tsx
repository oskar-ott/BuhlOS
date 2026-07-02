import Link from "next/link";
import type { Route } from "next";
import { Card } from "@/components/ui/Card";
import type { ScopeReconciliationView } from "@/server/job-control/reconciliation-read";

/**
 * Job-hub scope-reconciliation state line (#366 AC3): the hub shows the
 * confirmed red/amber/green so scope-vs-quote conflicts are in the boss's face
 * before work starts. Pure presenter over the persisted view — it derives
 * nothing (engine status + counts, read as confirmed).
 *
 * Honesty rule: renders ONLY when a confirmed reconciliation exists. A job
 * that was never reconciled shows nothing here (no fake "not reconciled"
 * nag for every job); an unreadable artifact is surfaced on the scope page,
 * not silently summarised.
 */
export function JobScopeReconciliationChip({
  jobId,
  view,
}: {
  jobId: string;
  view: ScopeReconciliationView | null;
}) {
  if (!view || view.status !== "reconciled") return null;

  const { rag, counts } = view;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const label =
    rag === "red"
      ? `${plural(counts.redFindings, "conflict")} to resolve`
      : rag === "amber"
        ? counts.unclassified > 0
          ? `${plural(counts.unclassified, "scope line")} not yet classified`
          : `${plural(counts.openFindings, "finding")} to check`
        : "Scope reconciled";
  const chipClass =
    rag === "red"
      ? "bg-red-100 text-red-900"
      : rag === "amber"
        ? "bg-amber-100 text-amber-900"
        : "bg-emerald-100 text-emerald-900";

  return (
    <Card role="region" aria-label="Scope vs quote">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${chipClass}`}
            role="status"
          >
            {label}
          </span>
          <span className="text-xs text-text-muted">
            Scope vs quote · {counts.classified}/{counts.clauses} clauses classified
          </span>
        </div>
        <Link
          href={`/v2/jobs/${encodeURIComponent(jobId)}/builder#scope` as Route}
          className="shrink-0 text-sm underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          Review in builder →
        </Link>
      </div>
    </Card>
  );
}
