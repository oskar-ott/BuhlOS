import { Camera, CheckCircle2, Eye, Lock, Users } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { buildPhilPreview } from "@/domains/jobs/builder";
import type { Job } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";

/**
 * Admin Job hub — "What the field sees".
 *
 * Closes the BuhlOS → Phil loop on the job landing: a read-only summary of the
 * Phil worker view for this job, so an admin/LH can answer "what will the crew
 * actually see?" without opening the builder (LHs can't reach the builder at
 * all).
 *
 * It reuses the existing pure derivation `buildPhilPreview(job)` — the SAME
 * helper the Builder's preview tab uses and the same `effectiveTasks` /
 * `visibleAreaGroups` the live Phil surface uses — so it is a faithful
 * derivation, never a mock. The crew line uses the real `statsCrewCount` from
 * the hub's existing `withStats=1` fetch.
 *
 * Honest about the connection's failure modes (no fabrication):
 *   - draft/archived  → "Office-only — no worker can open it in Phil yet"
 *   - published, 0 crew → "no field workers assigned — no one will see it"
 *   - no structure     → buildPhilPreview's emptyReason
 *
 * Strictly read-only: no impersonation, no field mutation, no admin controls
 * exposed to the field. This is the admin looking AT the worker view, not
 * acting as the worker.
 *
 * Cross-ref:
 *   src/domains/jobs/builder.ts — buildPhilPreview (pure, unit-tested)
 *   src/components/admin/JobBuilderClient.tsx — the fuller builder preview tab
 *   src/app/phil/jobs/[jobId]/page.tsx — the live worker surface this mirrors
 */

type AccessTone = "success" | "warning" | "neutral";

function accessSummary(
  isVisibleToField: boolean,
  crew: number | null,
): { tone: AccessTone; icon: typeof Eye; text: string } {
  if (!isVisibleToField) {
    return {
      tone: "neutral",
      icon: Lock,
      text: "Office-only — not published, so no worker can open this job in Phil yet.",
    };
  }
  if (crew === 0) {
    return {
      tone: "warning",
      icon: Users,
      text: "Published, but no field workers are assigned — no one will see it in Phil yet.",
    };
  }
  if (typeof crew === "number" && crew > 0) {
    return {
      tone: "success",
      icon: Eye,
      text: `Visible in Phil to ${crew} assigned field worker${crew === 1 ? "" : "s"}.`,
    };
  }
  return {
    tone: "success",
    icon: Eye,
    text: "Published — visible to assigned field workers in Phil.",
  };
}

const ACCESS_BOX: Record<AccessTone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-900",
  warning: "border-amber-200 bg-amber-50 text-amber-900",
  neutral: "border-border bg-surface-subtle text-text-muted",
};

export function JobFieldViewCard({ job }: { job: Job }) {
  const preview = buildPhilPreview(job);
  const crew = typeof job.statsCrewCount === "number" ? job.statsCrewCount : null;
  const access = accessSummary(preview.isVisibleToField, crew);
  const AccessIcon = access.icon;
  const enabledTools = preview.sections.filter((s) => s.enabled);

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Camera aria-hidden="true" className="h-5 w-5 text-text-muted" />
        <CardTitle>What the field sees</CardTitle>
      </div>
      <CardDescription className="mt-1">
        The Phil worker view for this job — read-only, derived from the saved job (the same
        data the Phil app renders).
      </CardDescription>

      <div
        className={cn(
          "mt-3 flex items-start gap-2 rounded-card border p-3 text-sm",
          ACCESS_BOX[access.tone],
        )}
      >
        <AccessIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{access.text}</span>
      </div>

      {preview.inductionRequired ? (
        <div className="mt-2">
          <Pill tone="warning">Induction required before site</Pill>
        </div>
      ) : null}

      {preview.emptyReason ? (
        <p className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle px-3 py-4 text-sm text-text-muted">
          {preview.emptyReason}
        </p>
      ) : preview.stages.length > 0 ? (
        <div className="mt-3">
          <p className="font-display text-[11px] uppercase tracking-wider text-text-muted">
            Stages the worker sees
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            {preview.stages.map((s) => (
              <Pill key={s.stage} tone="navy">
                {s.label} · {s.jobLevelTaskCount} task{s.jobLevelTaskCount === 1 ? "" : "s"}
              </Pill>
            ))}
          </div>
        </div>
      ) : null}

      {enabledTools.length > 0 ? (
        <div className="mt-3">
          <p className="font-display text-[11px] uppercase tracking-wider text-text-muted">
            Worker can
          </p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {enabledTools.map((s) => (
              <li
                key={s.key}
                className="inline-flex items-center gap-1.5 rounded-card border border-border bg-surface px-2.5 py-1 text-xs text-text"
              >
                <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-emerald-600" />
                {s.label}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
