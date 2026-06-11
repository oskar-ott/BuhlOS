import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { Eye, KeyRound, Lock, MapPin, PencilRuler, Phone, ShieldAlert, Squircle, User } from "lucide-react";
import type { Route } from "next";
import { AdminShell } from "@/components/admin/AdminShell";
import { DuplicateJobButton } from "@/components/admin/DuplicateJobButton";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { JobInterfaceSectionNav } from "@/components/admin/JobInterfaceSectionNav";
import { JobOverviewSummary } from "@/components/admin/JobOverviewSummary";
import { JobFieldViewCard } from "@/components/admin/JobFieldViewCard";
import { JobLabourSummary } from "@/components/admin/JobLabourSummary";
import { JobEvidenceSummary } from "@/components/admin/JobEvidenceSummary";
import { JobRecentActivity } from "@/components/admin/JobRecentActivity";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import {
  parseActivityResult,
  parseEvidenceResult,
  parseHoursResult,
  parseJobResult,
  type JobInterfaceData,
} from "@/domains/jobs/job-interface-data";
import { hasSiteContext, statusLabel, statusTone } from "@/domains/jobs/format";
import { isVisibleToField, summariseStructure } from "@/domains/jobs/builder";
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
 *   - Overview header: job name, ref, type, status pill, archived badge
 *   - Status summary (PR #87) + "What the field sees" (PR #88)
 *   - Operational loop (read-only, real data):
 *       Labour    &mdash; hours awaiting approval on this job (time-entries)
 *       Evidence  &mdash; capture summary by status (per-job evidence)
 *       Activity  &mdash; latest audit-log events (scope=job)
 *   - Site context: address / contact / access / parking / safety / induction
 *   - Section nav: Evidence / Snags / Observations / ITP / Documents / Plans /
 *     Material requests (live) + Materials legacy (UC)
 *
 * Live counts on the section nav come from /api/jobs?withStats=1
 * (statsEvidenceV2Pending, statsSnagsV2Active, statsItpsActive,
 * statsDocumentsCurrent). The operational-loop cards each load their own
 * per-job slice in parallel (see loadJobInterface) and degrade independently.
 *
 * This page does NOT replace the /v2/jobs/[jobId]/evidence and /snags
 * routes &mdash; it adds a parent hub. JobsList row chips still deep-link
 * past the hub into evidence/snags so power users keep their one-tap path.
 *
 * Cross-ref:
 *   src/app/v2/jobs/[jobId]/snags/page.tsx &mdash; per-section page precedent
 *   src/app/v2/jobs/[jobId]/evidence/page.tsx &mdash; same
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
        <div className="mx-auto max-w-4xl space-y-4">
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
        <div className="mx-auto max-w-4xl space-y-4">
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
      <div className="mx-auto max-w-4xl space-y-4">
        <JobHeaderCard job={job} />
        <JobOverviewSummary job={job} />
        <JobBuildCard job={job} canBuild={canBuild} />
        <JobFieldViewCard job={job} />
        {/* Operational loop — what's actually happening on the job, derived
            from real time-entry / evidence / audit-log data (read-only). */}
        <JobLabourSummary entries={data.hours.entries} jobId={job.id} fetchError={data.hours.error} />
        <JobEvidenceSummary
          evidence={data.evidence.evidence}
          jobId={job.id}
          fetchError={data.evidence.error}
        />
        <JobRecentActivity
          entries={data.activity.entries}
          jobId={job.id}
          fetchError={data.activity.error}
        />
        {hasSiteContext(job) ? <SiteContextCard job={job} /> : null}
        <JobInterfaceSectionNav job={job} />
      </div>
    </AdminShell>
  );
}

function JobHeaderCard({ job }: { job: Job }) {
  const subline = [job.ref && `Ref ${job.ref}`, job.typeName].filter(Boolean).join(" · ");
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <CardTitle className="break-words">{job.name}</CardTitle>
          {subline ? (
            <CardDescription className="mt-1">{subline}</CardDescription>
          ) : null}
          {job.siteAddress ? (
            <p className="mt-2 text-sm text-text-muted">{job.siteAddress}</p>
          ) : null}
        </div>
        <Pill tone={statusTone(job.status)}>{statusLabel(job.status)}</Pill>
      </div>
    </Card>
  );
}

function JobBuildCard({ job, canBuild }: { job: Job; canBuild: boolean }) {
  const s = summariseStructure(job);
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
      <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <StructureStat label="Area groups" value={s.areaGroupCount} />
        <StructureStat label="Areas" value={s.areaCount} />
        <StructureStat label="Rough-in tasks" value={s.roughInTaskCount} />
        <StructureStat label="Fit-off tasks" value={s.fitOffTaskCount} />
      </dl>
    </Card>
  );
}

function StructureStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-border bg-surface px-3 py-2">
      <div className="font-display text-lg text-text">{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </div>
    </div>
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
        <dt className="font-display text-[11px] uppercase tracking-wider text-text-muted">
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

  const [jobRes, hoursRes, evidenceRes, activityRes] = await Promise.allSettled([
    // withStats=1 so the section nav + Status/Field cards can show evidence +
    // snag + ITP + document counts on the loaded Job.
    fetch(`${base}/api/jobs?id=${enc}&withStats=1`, init),
    // scope=approver&status=submitted is exactly the /hours/approvals queue —
    // the hours awaiting office approval. The Labour card filters its
    // allocations down to this job.
    fetch(`${base}/api/time-entries?scope=approver&status=submitted`, init),
    fetch(`${base}/api/evidence?jobId=${enc}`, init),
    // months=4 mirrors the history tab's window (history/page.tsx) so the
    // Activity card's "+N more · View all" count and the full feed it links to
    // are computed over the same set.
    fetch(`${base}/api/audit-log?jobId=${enc}&scope=job&months=4`, init),
  ]);

  return {
    job: await parseJobResult(jobRes),
    hours: await parseHoursResult(hoursRes),
    evidence: await parseEvidenceResult(evidenceRes),
    activity: await parseActivityResult(activityRes),
  };
}
