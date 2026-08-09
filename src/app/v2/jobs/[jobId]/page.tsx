import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { Eye, KeyRound, Lock, MapPin, PencilRuler, Phone, ShieldAlert, Squircle, User } from "lucide-react";
import type { Route } from "next";
import { AdminShell } from "@/components/admin/AdminShell";
import { DuplicateJobButton } from "@/components/admin/DuplicateJobButton";
import { RecentItemTracker } from "@/components/admin/RecentItemTracker";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { JobHealthBand } from "@/components/admin/JobHealthBand";
import { JobLabourSummary } from "@/components/admin/JobLabourSummary";
import { JobMoneyCard } from "@/components/admin/JobMoneyCard";
import { JobTagsSummary } from "@/components/admin/JobTagsSummary";
import { JobEvidenceSummary } from "@/components/admin/JobEvidenceSummary";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import {
  parseEvidenceResult,
  parseHoursResult,
  parseJobResult,
  type JobInterfaceData,
} from "@/domains/jobs/job-interface-data";
import { hasSiteContext } from "@/domains/jobs/format";
import { isVisibleToField } from "@/domains/jobs/builder";
import { progressPct as canonicalProgressPct } from "@/domains/jobs/progress";
import { readEstimatedHours } from "@/domains/analytics/job-estimate";
import type { Job } from "@/domains/jobs/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
}

/**
 * /v2/jobs/[jobId] &mdash; Admin Job Interface hub.
 *
 * The job-level landing for admins. Replaces "click an evidence chip"
 * as the only way to land on a per-job admin surface; lets admins see
 * every section in one place and tap into the live ones.
 *
 * Sections rendered here (top to bottom):
 *   - Health band: IV code / ref / type / address, status control, the same
 *     At-risk/Watch/On-track read the jobs list shows, crew + task progress
 *   - Build &amp; publish
 *   - Labour &mdash; hours awaiting approval on this job (time-entries)
 *   - Money &mdash; contract / labour / materials / margin + budget variance
 *   - Evidence &mdash; capture summary by status, with the Photos link
 *   - Tag register (only when flagged) and Site context
 *
 * The health band's reasons come from /api/jobs?withStats=1 (the same stats
 * the list derives health from). The operational cards each load their own
 * per-job slice in parallel (see loadJobInterface) and degrade independently.
 *
 * This page does NOT replace the /v2/jobs/[jobId]/evidence route &mdash; it
 * adds a parent hub. JobsList row chips still deep-link past the hub into
 * evidence so power users keep their one-tap path.
 *
 * Cross-ref:
 *   src/app/v2/jobs/[jobId]/evidence/page.tsx &mdash; per-section page precedent
 *   src/components/phil/PhilJobDetail.tsx &mdash; Phil-side mirror of the
 *       same sections (with UC stubs)
 *   docs/rebuild-audit/35-current-product-state-audit.md §7.2 + §13
 */
export default async function AdminJobInterfacePage({ params }: PageParams) {
  const { jobId } = await params;

  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}`)}`);
  }
  // Defence-in-depth &mdash; middleware also gates /v2/jobs/* to the
  // admin-or-LH surface.
  if (!canAccessSurface(session.role, "lh")) {
    redirect("/v2/login");
  }
  const canBuild = canAccessSurface(session.role, "admin");

  const data = await loadJobInterface(raw, jobId);
  const result = data.job;

  if (result.kind === "not_found" || result.kind === "forbidden") {
    return (
      <AdminShell
        title="Job"
        breadcrumb={
          <Link
            href="/v2/jobs"
            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← Jobs
          </Link>
        }
      >
        <div className="mx-auto max-w-3xl space-y-4">
          <Card>
            <CardTitle>This job isn&rsquo;t available</CardTitle>
            <CardDescription className="mt-2">
              {result.kind === "forbidden"
                ? "You don't have access to this job. If you should, ask Karen or Daniel to add you."
                : "We couldn't find that job. It may have been archived or the link is stale."}
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  if (result.kind === "error") {
    return (
      <AdminShell
        title="Job"
        breadcrumb={
          <Link
            href="/v2/jobs"
            className="underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            ← Jobs
          </Link>
        }
      >
        <div className="mx-auto max-w-3xl space-y-4">
          <Card className="border-state-warning-subtle-border bg-state-warning-subtle-bg" role="alert">
            <CardTitle>Couldn&rsquo;t load this job</CardTitle>
            <CardDescription className="text-state-warning-subtle-text">
              {result.message}. Try again in a moment.
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  const job = result.job;

  // Canonical pooled task progress, shared by the health band and the Labour
  // card's overrun classifier. Lean jobs with no structure honestly read null.
  const progressPct =
    typeof job.statsTasksTotal === "number" && typeof job.statsTasksComplete === "number"
      ? canonicalProgressPct({ total: job.statsTasksTotal, complete: job.statsTasksComplete })
      : typeof job.statsPct === "number"
        ? Math.round(job.statsPct)
        : null;

  return (
    <AdminShell
      title={job.name}
      breadcrumb={
        <Link
          href="/v2/jobs"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Jobs
        </Link>
      }
    >
      <div className="mx-auto max-w-3xl space-y-4">
        {/* #215 — record this job view in the device-local recents ring buffer
            so ⌘K can offer a one-keystroke jump back. Renders nothing. */}
        <RecentItemTracker path={`/v2/jobs/${job.id}`} title={job.name} type="job" />
        {/* Lean-reset step 5 (#916, owner-decided 2026-07-18): the hub is
            identity + money-path + capture + tags + site. Stripped from here
            (reversal is git, the underlying features/data are untouched):
            Status card, scope of work, scope-recon chip, client & contract,
            "what the field sees", AI summary, BOQ/claims/closeout/DLP cards,
            recent activity, readiness + induction, services, field-view
            toggle. 2026-08-09 job-hub audit pass: the ref strip grew into the
            health band (same At-risk/Watch read as the jobs list + status
            control), the two money cards merged into JobMoneyCard (one fetch),
            and the two-row Sections nav folded into the Evidence card. */}
        <JobHealthBand job={job} canEdit={canBuild} progressPct={progressPct} />
        <JobBuildCard job={job} canBuild={canBuild} />
        <JobLabourSummary
          entries={data.hours.entries}
          jobId={job.id}
          fetchError={data.hours.error}
          estimatedHours={readEstimatedHours(job)}
          progressPct={progressPct}
        />
        {/* One money card, one fetch: profitability + budget variance are two
            views of the same endpoint. Client-fetched so the expensive
            approved-hours walk never blocks the hub render; admin-tier only
            (hidden for an LH/non-admin viewer). */}
        <JobMoneyCard jobId={job.id} />
        <JobEvidenceSummary
          evidence={data.evidence.evidence}
          jobId={job.id}
          fetchError={data.evidence.error}
        />
        <JobTagsSummary job={job} />
        {hasSiteContext(job) ? (
          <SiteContextCard job={job} canBuild={canBuild} />
        ) : null}
      </div>
    </AdminShell>
  );
}

function JobBuildCard({ job, canBuild }: { job: Job; canBuild: boolean }) {
  // Lean reset (#916): structure stats left with the strip — lean jobs
  // deliberately have no structure; publish state is the card's whole job.
  const fieldVisible = isVisibleToField(job);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle>Build &amp; publish</CardTitle>
          <CardDescription className="mt-1">
            {fieldVisible ? (
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <Eye aria-hidden="true" className="h-3.5 w-3.5" /> Published — visible
                to assigned field workers.
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <Lock aria-hidden="true" className="h-3.5 w-3.5" /> Office-only — not
                yet published to the field.
              </span>
            )}
          </CardDescription>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canBuild ? (
            <a
              href={`/v2/jobs/${encodeURIComponent(job.id)}/builder` as Route}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-card bg-brand-navy px-3 py-2 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-ink focus:outline-none focus:ring-2 focus:ring-brand-navy"
            >
              <PencilRuler aria-hidden="true" className="h-4 w-4" /> Open builder
            </a>
          ) : null}
          {/* #190 — copy structure + site basics into a new draft. */}
          <DuplicateJobButton jobId={job.id} />
        </div>
      </div>
    </Card>
  );
}

function SiteContextCard({ job, canBuild }: { job: Job; canBuild: boolean }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <CardTitle>Site</CardTitle>
        {canBuild ? (
          <a
            href={`/v2/jobs/${encodeURIComponent(job.id)}/builder?tab=basics` as Route}
            className="text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-4 focus:outline-none focus:ring-2 focus:ring-brand-navy"
          >
            Edit
          </a>
        ) : null}
      </div>
      <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
        {job.siteAddress ? (
          <SiteField icon={<MapPin className="h-4 w-4" />} label="Address">
            {job.siteAddress}
          </SiteField>
        ) : null}
        {(job.siteContactName?.trim() || job.siteContactPhone?.trim()) ? (
          <SiteField icon={<User className="h-4 w-4" />} label="Contact">
            <span className="block">{job.siteContactName?.trim() || "—"}</span>
            {job.siteContactPhone?.trim() ? (
              <span className="mt-0.5 inline-flex items-center gap-1 text-text-muted">
                <Phone aria-hidden="true" className="h-3.5 w-3.5" />
                <a
                  href={`tel:${job.siteContactPhone.replace(/\s+/g, "")}`}
                  className="underline decoration-accent-yellow decoration-2 underline-offset-2"
                >
                  {job.siteContactPhone.trim()}
                </a>
              </span>
            ) : null}
          </SiteField>
        ) : null}
        {job.accessNotes ? (
          <SiteField icon={<KeyRound className="h-4 w-4" />} label="Access">
            {job.accessNotes}
          </SiteField>
        ) : null}
        {job.parkingNotes ? (
          <SiteField icon={<Squircle className="h-4 w-4" />} label="Parking">
            {job.parkingNotes}
          </SiteField>
        ) : null}
        {job.safetyNotes ? (
          <SiteField icon={<ShieldAlert className="h-4 w-4" />} label="Safety">
            {job.safetyNotes}
          </SiteField>
        ) : null}
      </dl>
      {job.inductionRequired ? (
        <div className="mt-3 rounded-card border border-state-warning-subtle-border bg-state-warning-subtle-bg p-3 text-sm text-state-warning-subtle-text">
          <p className="font-display font-semibold">Site induction required</p>
          <p className="mt-0.5 text-xs">
            Confirm with the leading hand before sending the crew on site.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function SiteField({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden="true" className="mt-0.5 shrink-0 text-text-muted">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <dt className="text-xs text-text-muted">{label}</dt>
        <dd className="mt-0.5 whitespace-pre-line break-words text-text">
          {children}
        </dd>
      </div>
    </div>
  );
}

/**
 * Load the job + its operational-loop data in one parallel pass.
 *
 * The job fetch (withStats=1, so the existing Status/Field/Section cards keep
 * their real counts) gates the page's not_found/forbidden/error states. The
 * three operational fetches are best-effort and independent — modelled on the
 * history page's Promise.allSettled pattern — so a slow or failed hours /
 * evidence / activity read degrades to that one card's error state rather than
 * blanking the whole hub. All reads are GETs forwarding the session cookie;
 * nothing here mutates. Response parsing (and its rejected/!ok/malformed
 * branches) lives in — and is unit-tested via — src/domains/jobs/job-interface-data.ts.
 */
async function loadJobInterface(
  cookieValue: string | undefined,
  jobId: string
): Promise<JobInterfaceData> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const enc = encodeURIComponent(jobId);
  const init = {
    cache: "no-store" as const,
    headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
  };

  // Lean reset step 5 (#916): the activity card left the hub, so the
  // audit-log fetch is gone with it; the slot stays typed as empty.
  const [jobRes, hoursRes, evidenceRes] = await Promise.allSettled([
    // withStats=1 so the section nav + Status/Field cards can show evidence +
    // snag + ITP + document counts on the loaded Job.
    fetch(`${base}/api/jobs?id=${enc}&withStats=1`, init),
    // Per-job hours (#134): this job's submitted + approved entries (recompute-
    // on-read). The Labour card buckets them into approved vs pending. Same
    // entry shape as the approver queue, so the hours parser is unchanged.
    fetch(`${base}/api/job-hours?jobId=${enc}`, init),
    fetch(`${base}/api/evidence?jobId=${enc}`, init),
  ]);

  return {
    job: await parseJobResult(jobRes),
    hours: await parseHoursResult(hoursRes),
    evidence: await parseEvidenceResult(evidenceRes),
    activity: { entries: [], error: null },
  };
}




