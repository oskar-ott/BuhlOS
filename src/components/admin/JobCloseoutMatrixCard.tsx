import Link from "next/link";
import type { Route } from "next";
import { CheckCircle2, CircleDashed, ListChecks } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import type {
  CloseoutMatrixView,
  CloseoutRequirementView,
} from "@/server/job-control/closeout-read";

/**
 * Closeout matrix card (#374) on the admin job hub. DISTINCT from #349's
 * JobCloseoutCard (the "Final numbers" freeze): this is the OBLIGATIONS matrix —
 * "N of M closed out" + what's still outstanding, derived from the recon's
 * closeout clauses + the electrical defaults, each discharged by links to real
 * records and an admin confirmation.
 *
 * Read-only: it measures handover readiness; it does NOT gate the job's close-out.
 *
 * Surfaced only as the job nears completion (the page gates this with
 * `shouldSurfaceCloseoutMatrix` so it isn't day-one noise). Honest-empty: a job
 * with no requirements reads "Nothing to close out yet", never a fake 0%.
 *
 * Pure presentation — the page reads + shapes the spine server-side and passes
 * the `view` in (mirrors JobReadinessPanel's `initial`), so the card render is
 * deterministic and unit-testable without a fetch.
 */

/** Job statuses where closeout readiness is worth surfacing — a draft/on-hold
 *  job has nothing to hand over yet, so the card stays out of the way. */
const NEAR_COMPLETION_STATUSES = new Set(["active", "complete", "archived"]);

/**
 * Should the hub render the closeout matrix card? The `positive()`-style gate
 * (cf. deriveJobAttention): only when the job is near completion AND the matrix
 * has at least one requirement to measure. A missing/unreadable spine, or a job
 * still in draft, surfaces nothing — no day-one noise, no empty shell.
 */
export function shouldSurfaceCloseoutMatrix(
  jobStatus: string | null | undefined,
  view: CloseoutMatrixView,
): boolean {
  if (!jobStatus || !NEAR_COMPLETION_STATUSES.has(jobStatus)) return false;
  if (!view.ok || view.status !== "ready") return false;
  return view.counts.total > 0;
}

export function JobCloseoutMatrixCard({
  jobId,
  view,
}: {
  jobId: string;
  view: CloseoutMatrixView;
}) {
  const href = `/v2/jobs/${encodeURIComponent(jobId)}/closeout` as Route;

  // Defensive honest-empty: the page only renders this for a ready view with
  // requirements, but the card must still degrade rather than throw.
  if (!view.ok || view.status !== "ready" || view.counts.total === 0) {
    return (
      <Card role="region" aria-label="Job closeout matrix">
        <CardTitle>Closeout</CardTitle>
        <CardDescription className="mt-2">Nothing to close out yet.</CardDescription>
      </Card>
    );
  }

  const { counts, outstanding } = view;
  const allDischarged = counts.discharged === counts.total;

  return (
    <Card role="region" aria-label="Job closeout matrix">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Closeout</CardTitle>
          <CardDescription className="mt-1">
            Handover obligations — test results, certificate of electrical safety,
            as-builts and the job&rsquo;s own closeout clauses.
          </CardDescription>
        </div>
        <Pill tone={allDischarged ? "navy" : "warning"} className="shrink-0 font-semibold">
          {`${counts.discharged} of ${counts.total} closed out`}
        </Pill>
      </div>

      {allDischarged ? (
        <p className="mt-3 inline-flex items-center gap-1.5 text-sm text-emerald-700">
          <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
          Every closeout obligation is discharged.
        </p>
      ) : (
        <div className="mt-3">
          <p className="font-display text-[11px] uppercase tracking-wider text-text-muted">
            Still outstanding ({outstanding.length})
          </p>
          <ul className="mt-2 space-y-1.5">
            {outstanding.map((req) => (
              <OutstandingRow key={req.id} req={req} />
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <Link
          href={href}
          className="inline-flex items-center gap-1.5 text-sm underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          <ListChecks aria-hidden="true" className="h-4 w-4" /> Open closeout matrix
        </Link>
      </div>
    </Card>
  );
}

function OutstandingRow({ req }: { req: CloseoutRequirementView }) {
  const inProgress = req.status === "in_progress";
  return (
    <li className="flex items-start gap-2 text-sm">
      <CircleDashed
        aria-hidden="true"
        className={`mt-0.5 h-4 w-4 shrink-0 ${inProgress ? "text-amber-600" : "text-text-muted/60"}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-text">{req.title}</span>
        {inProgress ? (
          <span className="block text-xs text-amber-700">
            {req.hasDanglingLink
              ? "A linked record is missing — re-link before sign-off."
              : "In progress — awaiting confirmation."}
          </span>
        ) : null}
      </span>
    </li>
  );
}
