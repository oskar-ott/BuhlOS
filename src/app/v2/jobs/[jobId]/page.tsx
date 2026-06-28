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
import { JobOverviewSummary } from "@/components/admin/JobOverviewSummary";
import { JobFieldViewCard } from "@/components/admin/JobFieldViewCard";
import { JobInductionCard } from "@/components/admin/JobInductionCard";
import { JobReadinessPanel } from "@/components/admin/JobReadinessPanel";
import { JobScopeCard } from "@/components/admin/JobScopeCard";
import { ClientContractCard } from "@/components/admin/ClientContractCard";
import {
  JobInductionsResponseSchema,
  type CrewInductionStatus,
} from "@/domains/jobs/induction";
import { computeReadiness, type ReadinessResult } from "@/domains/jobs/readiness";
import { ReadinessSignalsResponseSchema, signalsFrom } from "@/domains/jobs/readiness-client";
import { JobLabourSummary } from "@/components/admin/JobLabourSummary";
import { JobProfitabilitySummary } from "@/components/admin/JobProfitabilitySummary";
import { JobBudgetVarianceCard } from "@/components/admin/JobBudgetVarianceCard";
import { JobCostImportCard } from "@/components/admin/JobCostImportCard";
import { JobCloseoutCard } from "@/components/admin/JobCloseoutCard";
import {
  JobCloseoutMatrixCard,
  shouldSurfaceCloseoutMatrix,
} from "@/components/admin/JobCloseoutMatrixCard";
import { JobDlpCard } from "@/components/admin/JobDlpCard";
import { JobTagsSummary } from "@/components/admin/JobTagsSummary";
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
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { JobViewToggle } from "@/components/admin/JobViewToggle";
import { JobFieldView } from "@/components/admin/JobFieldView";
import type { PhilJobDataForCommand } from "@/domains/phil/job-command-input";
import { SnagListResponseSchema } from "@/domains/snags/schema";
import { ITPListResponseSchema } from "@/domains/itp/schema";
import { DocumentListResponseSchema } from "@/domains/documents/schema";
import { TagListResponseSchema } from "@/domains/tags/schema";
import { parseJobTaskState } from "@/domains/jobs/taskState";
import {
  blobCloseoutReadDeps,
  runCloseoutMatrixView,
  type CloseoutMatrixView,
} from "@/server/job-control/closeout-read";

export const dynamic = "force-dynamic";

/** #374: job statuses where closeout readiness is worth a spine read + the card.
 *  Mirrors `shouldSurfaceCloseoutMatrix` in the card; kept here so a draft job
 *  never pays the blob read. */
const NEAR_COMPLETION_JOB_STATUSES = new Set(["active", "complete", "archived"]);

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

  // Office / Field view toggle (mobile-admin redesign, flagged). Resolve the
  // flag server-side and pass a boolean down; the client never reads it. The
  // selected view is URL-driven (?view=field) so the server render is
  // authoritative. Field view = an admin-side, read-only render of the Phil
  // job command model.
  const showFieldView = await isFlagEnabled("admin_job_field_view", session);
  const activeView: "office" | "field" = showFieldView && view === "field" ? "field" : "office";
  // #219: surface the Safety documents section when the flag is on.
  const safetyEnabled = await isFlagEnabled("safety_docs", session);
  // #231: surface the Certificates register section when the flag is on.
  const certificatesEnabled = await isFlagEnabled("certificates_register", session);
  // #276: surface the RFI register section when the flag is on.
  const rfiEnabled = await isFlagEnabled("rfi_register", session);
  // #217: surface the meeting-minutes register section when the flag is on.
  const minutesEnabled = await isFlagEnabled("minutes_register", session);
  // #365: surface the imported BOQ cost-basis card when the flag is on (the
  // card self-hides for jobs that weren't created from a BOQ import).
  const costImportEnabled = await isFlagEnabled("job_doc_import", session);

  const [data, inductions, readiness] = await Promise.all([
    loadJobInterface(raw, jobId),
    loadJobInductions(raw, jobId),
    loadJobReadiness(raw, jobId),
  ]);
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

  // #374: closeout matrix readiness. Read the spine ONLY when the job is near
  // completion (active/complete/archived) — a draft/on-hold job has nothing to
  // hand over, so we skip the blob read entirely (no day-one cost). The card is
  // surfaced only when the read is ready AND has ≥1 requirement (positive() gate).
  const closeoutView: CloseoutMatrixView | null = NEAR_COMPLETION_JOB_STATUSES.has(
    job.status ?? "",
  )
    ? await runCloseoutMatrixView(blobCloseoutReadDeps(), job.id)
    : null;

  // Load the Phil sub-resources ONLY when the Field view is selected (and the
  // flag is on) — Office view keeps its existing cost. Each read degrades to an
  // honest loadError flag (the command model then says "unknown", never a
  // false 0).
  const fieldData = activeView === "field" ? await loadFieldViewData(raw, job) : null;

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
        {/* #215 — record this job view in the device-local recents ring buffer
            so ⌘K can offer a one-keystroke jump back. Renders nothing. */}
        <RecentItemTracker path={`/v2/jobs/${job.id}`} title={job.name} type="job" />
        <JobHeaderCard job={job} />
        {/* Office / Field view toggle (flagged). Field view = read-only admin
            render of the Phil job command model (what the crew sees). */}
        {showFieldView ? <JobViewToggle jobId={job.id} current={activeView} /> : null}
        {activeView === "field" && fieldData ? (
          <JobFieldView data={fieldData} />
        ) : (
        <>
        <JobOverviewSummary job={job} />
        {/* #200: the agreed scope, read-only. Field/client payloads never
            carry the field (server redaction), so this renders for the
            admin/LH viewers who can see this page with data present. */}
        <JobScopeCard job={job} />
        {/* #228: client + contract commercial summary — admin-tier ONLY (the
            fields are adminTier in job-redaction.js, so an LH viewer's payload
            has no data; gate the card too so we don't show an empty shell). */}
        {canBuild ? <ClientContractCard job={job} /> : null}
        <JobBuildCard job={job} canBuild={canBuild} />
        <JobFieldViewCard job={job} />
        {/* Operational loop — what's actually happening on the job, derived
            from real time-entry / evidence / audit-log data (read-only). */}
        <JobLabourSummary entries={data.hours.entries} jobId={job.id} fetchError={data.hours.error} />
        {/* #327: per-job profitability (cost-rate based). Client-fetched so the
            expensive approved-hours walk never blocks the hub render; admin-tier
            only (hidden for an LH/non-admin viewer). */}
        <JobProfitabilitySummary jobId={job.id} />
        {/* #341: budget vs actual (labour/materials/total) — $-vs-budget view,
            complements the Labour card's pending-approval framing. */}
        <JobBudgetVarianceCard jobId={job.id} />
        {/* #365: imported BOQ cost basis — headline total + reconciliation for a
            job born from a workbook import. Flag-gated + admin-tier; the card
            self-hides for jobs with no import (the GET also 404s when dark). */}
        {costImportEnabled && canBuild ? <JobCostImportCard jobId={job.id} /> : null}
        {/* #349: closeout / "Final numbers" report card — freeze the job's final
            numbers at end-of-life; admin-tier only (hidden for an LH viewer). */}
        <JobCloseoutCard jobId={job.id} />
        {/* #374: closeout OBLIGATIONS matrix — "N of M closed out" + what's
            outstanding (test results, CES, as-builts, the job's closeout clauses).
            Distinct from the #349 numbers freeze above. Surfaced only as the job
            nears completion (the page gates the read; the helper gates the card)
            so it isn't day-one noise. Read-only — never gates completion. */}
        {closeoutView && shouldSurfaceCloseoutMatrix(job.status, closeoutView) ? (
          <JobCloseoutMatrixCard jobId={job.id} view={closeoutView} />
        ) : null}
        {/* #235: defect liability period — handover date + defect window, with
            in-DLP status / days remaining. Admin-tier dates (the PUT 403s an LH),
            so gate the whole card on canBuild like the contract card above. */}
        {canBuild ? <JobDlpCard job={job} today={sydneyTodayStr()} /> : null}
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
        {/* #371: pre-start readiness — the aggregate "can we start?" gate over
            induction + licences + safety docs + the manual checklist. Admin-tier
            data; an LH viewer's 403 resolves to null (card hidden). Sits above
            the induction card, which is the per-worker drill-down. */}
        {readiness ? (
          <JobReadinessPanel
            jobId={job.id}
            initial={readiness.result}
            fetchError={readiness.error}
          />
        ) : null}
        {/* #332: crew induction register — current crew ∩ records. Shown when
            the job requires induction, or when past records exist after the
            flag was turned off (history is never hidden). Admin-tier data;
            an LH viewer just doesn't get the card (fail-soft null). */}
        {inductions && (inductions.inductionRequired || inductions.recordCount > 0) ? (
          <JobInductionCard
            jobId={job.id}
            inductionRequired={inductions.inductionRequired}
            initialCrew={inductions.crew}
            recordCount={inductions.recordCount}
            fetchError={inductions.error}
          />
        ) : null}
        <JobTagsSummary job={job} />
        {hasSiteContext(job) ? <SiteContextCard job={job} /> : null}
        <JobInterfaceSectionNav
          job={job}
          safetyEnabled={safetyEnabled}
          certificatesEnabled={certificatesEnabled}
          rfiEnabled={rfiEnabled}
          minutesEnabled={minutesEnabled}
        />
        </>
        )}
      </div>
    </AdminShell>
  );
}

/** #235: today as a Sydney YYYY-MM-DD string (the api/site-visits.js Intl
 *  pattern). Computed server-side so the DLP status line is deterministic with
 *  the server render. */
function sydneyTodayStr(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
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
    // Per-job hours (#134): this job's submitted + approved entries (recompute-
    // on-read). The Labour card buckets them into approved vs pending. Same
    // entry shape as the approver queue, so the hours parser is unchanged.
    fetch(`${base}/api/job-hours?jobId=${enc}`, init),
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

/**
 * #332: per-job induction register for the hub card. Admin-tier endpoint —
 * an LH viewer's 403 resolves to null (card hidden), any other failure
 * resolves to an empty-but-flagged result so the card can say so.
 */
async function loadJobInductions(
  cookieValue: string | undefined,
  jobId: string
): Promise<{
  crew: CrewInductionStatus[];
  recordCount: number;
  inductionRequired: boolean;
  error: string | null;
} | null> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/job-inductions?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (res.status === 403) return null; // LH viewer — admin-only data, v1
    if (!res.ok) {
      return { crew: [], recordCount: 0, inductionRequired: false, error: `Induction register: API ${res.status}` };
    }
    const parsed = JobInductionsResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      return { crew: [], recordCount: 0, inductionRequired: false, error: "Induction register: bad shape" };
    }
    return {
      crew: [...parsed.data.crew],
      recordCount: parsed.data.records.length,
      inductionRequired: parsed.data.inductionRequired,
      error: null,
    };
  } catch (err) {
    return {
      crew: [],
      recordCount: 0,
      inductionRequired: false,
      error: err instanceof Error ? err.message : "network error",
    };
  }
}

/**
 * #371: pre-start readiness. Admin-tier endpoint — an LH viewer's 403 resolves
 * to null (panel hidden); any other failure resolves to an empty-but-flagged
 * result so the panel can say so. The API serves SIGNALS; we run the pure
 * computeReadiness() engine here so the hub holds the single computed result.
 */
async function loadJobReadiness(
  cookieValue: string | undefined,
  jobId: string
): Promise<{ result: ReadinessResult; error: string | null } | null> {
  const empty = (): ReadinessResult =>
    computeReadiness({
      crew: [],
      inductions: null,
      licences: null,
      safetyDocs: null,
      manualItems: [],
      override: null,
    });
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/job-readiness?jobId=${encodeURIComponent(jobId)}`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (res.status === 403) return null; // LH / non-admin viewer — admin-only, v1
    if (!res.ok) return { result: empty(), error: `Readiness: API ${res.status}` };
    const parsed = ReadinessSignalsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { result: empty(), error: "Readiness: bad shape" };
    return { result: computeReadiness(signalsFrom(parsed.data)), error: null };
  } catch (err) {
    return { result: empty(), error: err instanceof Error ? err.message : "network error" };
  }
}

/**
 * Load the Phil sub-resources the Field view's command model reads (the same
 * GETs the /phil/jobs/[jobId] page uses). Each is best-effort: a failed list
 * sets the matching loadError flag so the command model reports "unknown"
 * rather than a misleading 0 (P7). Only called when the Field view is selected.
 */
async function loadFieldViewData(
  cookieValue: string | undefined,
  job: Job
): Promise<PhilJobDataForCommand> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const enc = encodeURIComponent(job.id);
  const init = {
    cache: "no-store" as const,
    headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
  };

  const [snagsRes, itpsRes, plansRes, tagsRes, dataRes] = await Promise.allSettled([
    fetch(`${base}/api/snags?jobId=${enc}`, init),
    fetch(`${base}/api/job-itps?jobId=${enc}`, init),
    fetch(`${base}/api/plans?jobId=${enc}`, init),
    fetch(`${base}/api/tags?jobId=${enc}`, init),
    fetch(`${base}/api/data?jobId=${enc}`, init),
  ]);

  async function parseList<T>(
    settled: PromiseSettledResult<Response>,
    extract: (body: unknown) => T[] | null
  ): Promise<{ items: T[]; error: boolean }> {
    if (settled.status !== "fulfilled" || !settled.value.ok) return { items: [], error: true };
    try {
      const items = extract(await settled.value.json());
      return items ? { items, error: false } : { items: [], error: true };
    } catch {
      return { items: [], error: true };
    }
  }

  const snags = await parseList(snagsRes, (b) => {
    const p = SnagListResponseSchema.safeParse(b);
    return p.success ? [...p.data.snags] : null;
  });
  const itps = await parseList(itpsRes, (b) => {
    const p = ITPListResponseSchema.safeParse(b);
    return p.success ? [...p.data.instances] : null;
  });
  const documents = await parseList(plansRes, (b) => {
    const p = DocumentListResponseSchema.safeParse(b);
    return p.success ? [...p.data.plans] : null;
  });
  const tags = await parseList(tagsRes, (b) => {
    const p = TagListResponseSchema.safeParse(b);
    return p.success ? [...p.data.tags] : null;
  });

  // Task state is best-effort; on failure omit it so the model reports tasks as
  // list-only (no fabricated completion), not "tracked: 0 done".
  let taskState: PhilJobDataForCommand["taskState"];
  try {
    if (dataRes.status === "fulfilled" && dataRes.value.ok) {
      taskState = parseJobTaskState(await dataRes.value.json());
    }
  } catch {
    taskState = undefined;
  }

  return {
    job,
    snags: snags.items,
    itps: itps.items,
    documents: documents.items,
    tags: tags.items,
    taskState,
    loadErrors: {
      snags: snags.error,
      itps: itps.error,
      documents: documents.error,
      tags: tags.error,
    },
  };
}
