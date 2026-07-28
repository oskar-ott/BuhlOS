import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { Eye, KeyRound, Lock, MapPin, PencilRuler, Phone, ShieldAlert, Squircle, User } from "lucide-react";
import type { Route } from "next";
import { AdminShell } from "@/components/admin/AdminShell";
import { DuplicateJobButton } from "@/components/admin/DuplicateJobButton";
import { RecentItemTracker } from "@/components/admin/RecentItemTracker";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { JobInterfaceSectionNav } from "@/components/admin/JobInterfaceSectionNav";
import {
  JobInductionsResponseSchema,
  type CrewInductionStatus,
} from "@/domains/jobs/induction";
import { JobLabourSummary } from "@/components/admin/JobLabourSummary";
import { JobProfitabilitySummary } from "@/components/admin/JobProfitabilitySummary";
import { JobBudgetVarianceCard } from "@/components/admin/JobBudgetVarianceCard";
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
import { hasSiteContext, statusLabel, statusTone } from "@/domains/jobs/format";
import { isVisibleToField } from "@/domains/jobs/builder";
import { progressPct as canonicalProgressPct } from "@/domains/jobs/progress";
import { readEstimatedHours } from "@/domains/analytics/job-estimate";
import type { Job } from "@/domains/jobs/types";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<{ view?: string }>;
}

/**
 * /v2/jobs/[jobId] &mdash; Admin Job Interface hub.
 *
 * The job-level landing for admins. Replaces "click an evidence chip"
 * as the only way to land on a per-job admin surface; lets admins see
 * every section in one place and tap into the live ones.
 *
 * Sections rendered here (top to bottom):
 *   - Overview header: job name, ref, type, status pill, archived badge
 *   - Status summary (PR #87) + "What the field sees" (PR #88)
 *   - Operational loop (read-only, real data):
 *       Labour    &mdash; hours awaiting approval on this job (time-entries)
 *       Evidence  &mdash; capture summary by status (per-job evidence)
 *       Activity  &mdash; latest audit-log events (scope=job)
 *   - Site context: address / contact / access / parking / safety / induction
 *   - Section nav: Evidence / Photos / Plans
 *
 * The live evidence count on the section nav comes from /api/jobs?withStats=1
 * (statsEvidenceV2Pending). The operational-loop cards each load their own
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
export default async function AdminJobInterfacePage({ params, searchParams }: PageParams) {
  const { jobId } = await params;
  const { view } = await searchParams;

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
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load this job</CardTitle>
            <CardDescription className="text-amber-900">
              {result.message}. Try again in a moment.
            </CardDescription>
          </Card>
        </div>
      </AdminShell>
    );
  }

  const job = result.job;


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
            toggle. Kept by owner call: Build & publish (everyone can create),
            Profitability + Budget. */}
        <JobHeaderCard job={job} />
        <JobBuildCard job={job} canBuild={canBuild} />
        <JobLabourSummary
          entries={data.hours.entries}
          jobId={job.id}
          fetchError={data.hours.error}
          estimatedHours={readEstimatedHours(job)}
          progressPct={
            typeof job.statsTasksTotal === "number" && typeof job.statsTasksComplete === "number"
              ? canonicalProgressPct({ total: job.statsTasksTotal, complete: job.statsTasksComplete })
              : typeof job.statsPct === "number"
                ? Math.round(job.statsPct)
                : null
          }
        />
        {/* #327: per-job profitability (cost-rate based). Client-fetched so the
            expensive approved-hours walk never blocks the hub render; admin-tier
            only (hidden for an LH/non-admin viewer). */}
        <JobProfitabilitySummary jobId={job.id} />
        {/* #341: budget vs actual (labour/materials/total) — $-vs-budget view,
            complements the Labour card's pending-approval framing. */}
        <JobBudgetVarianceCard jobId={job.id} />
        <JobEvidenceSummary
          evidence={data.evidence.evidence}
          jobId={job.id}
          fetchError={data.evidence.error}
        />
        <JobTagsSummary job={job} />
        {hasSiteContext(job) ? <SiteContextCard job={job} /> : null}
        <JobInterfaceSectionNav job={job} />
      </div>
    </AdminShell>
  );
}

/**
 * Ref strip (lean-reset replica 379-381). The job NAME is the shell head
 * (AdminShell title), so this card carries only the "Ref · type · address"
 * identity line + the status pill. The builder entry point lives on the
 * Build & publish card directly below — no duplicate action here.
 */
function JobHeaderCard({ job }: { job: Job }) {
  const subline = [job.ref && `Ref ${job.ref}`, job.typeName, job.siteAddress]
    .filter(Boolean)
    .join(" · ");
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Fall back to the name so the strip never renders as a bare pill on a
            job with no ref/type/address yet. */}
        <p className="min-w-0 break-words text-sm text-text-muted">
          {subline || job.name}
        </p>
        <div className="shrink-0">
          <Pill tone={statusTone(job.status)}>{statusLabel(job.status)}</Pill>
        </div>
      </div>
    </Card>
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

function SiteContextCard({ job }: { job: Job }) {
  return (
    <Card>
      <CardTitle>Site</CardTitle>
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
        <div className="mt-3 rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
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
        <dt className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          {label}
        </dt>
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




