import { Camera, CheckCircle2, Eye, Lock, Users } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { buildPhilPreview, moduleEnabled } from "@/domains/jobs/builder";
import { hasSiteContext } from "@/domains/jobs/format";
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
 * `visibleAreaGroups` the live Phil surface uses — then labels the current
 * Phil job-screen sections at a high level. This is a structure preview from
 * the saved job, not a live worker-activity feed.
 *
 * Honest about the connection's failure modes (no fabrication):
 *   - draft/archived  → "Office-only — no worker can open it in Phil yet"
 *   - published, 0 crew → "no field workers assigned — no one will see it"
 *   - no structure     → buildPhilPreview's emptyReason
 *   - runtime state    → called out as not represented here
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

function currentPhilSections(job: Job, preview: ReturnType<typeof buildPhilPreview>, features: FieldViewFeatures) {
  const sections = [
    {
      key: "next",
      label: "Quick actions",
      detail: "model-ranked shortcuts and honest limitations",
      enabled: preview.isVisibleToField,
    },
    {
      key: "work",
      label: "Work to do",
      detail: "areas, stages and worker-visible tasks",
      enabled: preview.areas.length > 0 || preview.stages.length > 0,
    },
    {
      key: "capture",
      label: "Capture evidence",
      detail: "photo or note capture attached to this job",
      enabled: moduleEnabled(job, "photos"),
    },
    {
      key: "issues",
      label: "Issues / snags",
      detail: "raise and review job issues",
      enabled: features.snags !== false && moduleEnabled(job, "snags"),
    },
    {
      key: "checks",
      label: "Checks / ITPs",
      detail: "record job checks where configured",
      enabled: features.itps !== false && moduleEnabled(job, "itps"),
    },
    {
      key: "files",
      label: "Plans & documents",
      detail: "current drawings, specs and site files",
      enabled: moduleEnabled(job, "plans"),
    },
    {
      key: "site",
      label: "Site details",
      detail: "address, access, contact and induction notes",
      enabled: hasSiteContext(job),
    },
  ];

  return sections.filter((section) => section.enabled);
}

interface FieldViewFeatures {
  snags?: boolean;
  itps?: boolean;
  materials?: boolean;
  history?: boolean;
}

export function JobFieldViewCard({
  job,
  features = {},
}: {
  job: Job;
  /** Global kill-switch state (#915): a section row must not claim Phil shows
   *  a feature the lean reset has hidden — the per-job module toggle alone
   *  can't see that. Omitted key = feature on. */
  features?: FieldViewFeatures;
}) {
  const preview = buildPhilPreview(job);
  const crew = typeof job.statsCrewCount === "number" ? job.statsCrewCount : null;
  const access = accessSummary(preview.isVisibleToField, crew);
  const AccessIcon = access.icon;
  const screenSections = currentPhilSections(job, preview, features);
  const reachesField = preview.isVisibleToField && crew !== 0;

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Camera aria-hidden="true" className="h-5 w-5 text-text-muted" />
        <CardTitle>What the field sees</CardTitle>
      </div>
      <CardDescription className="mt-1">
        Current Phil job-screen structure, derived from the saved job. This is
        not worker activity telemetry.
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
            {reachesField ? "Stages the worker sees" : "Stages configured for Phil"}
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

      {screenSections.length > 0 ? (
        <div className="mt-3">
          <p className="font-display text-[11px] uppercase tracking-wider text-text-muted">
            {reachesField ? "Phil screen includes" : "If assigned and published, Phil would include"}
          </p>
          <ul className="mt-1 grid gap-2 sm:grid-cols-2">
            {screenSections.map((s) => (
              <li
                key={s.key}
                className="rounded-card border border-border bg-surface px-3 py-2 text-xs text-text"
              >
                <span className="flex items-center gap-1.5 font-medium">
                  <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5 text-emerald-600" />
                  {s.label}
                </span>
                <span className="mt-0.5 block text-text-muted">{s.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle px-3 py-2 text-xs text-text-muted">
        Not represented here: whether a worker has viewed the job, completed
        tasks, captured evidence, fixed hours, or finished checks.
        {features.materials !== false || features.history !== false
          ? " Materials and job history are still shown in Phil as not connected yet."
          : ""}
      </p>
    </Card>
  );
}
