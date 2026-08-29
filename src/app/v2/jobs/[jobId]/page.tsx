import { Suspense } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import {
  Eye,
  KeyRound,
  Lock,
  MapPin,
  PencilRuler,
  Phone,
  ShieldAlert,
  Squircle,
  User,
} from "lucide-react";
import type { Route } from "next";
import { z } from "zod";
import { AdminShell } from "@/components/admin/AdminShell";
import { DuplicateJobButton } from "@/components/admin/DuplicateJobButton";
import { RecentItemTracker } from "@/components/admin/RecentItemTracker";
import { Card, CardDescription, CardKicker, CardTitle } from "@/components/ui/Card";
import { JobHealthBand } from "@/components/admin/JobHealthBand";
import { JobLabourSummary } from "@/components/admin/JobLabourSummary";
import { JobMaterialsCard } from "@/components/admin/JobMaterialsCard";
import { JobMoneyCard } from "@/components/admin/JobMoneyCard";
import { JobTagsSummary } from "@/components/admin/JobTagsSummary";
import { JobEvidenceSummary } from "@/components/admin/JobEvidenceSummary";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import {
  parseEvidenceResult,
  parseHoursResult,
  parseJobResult,
} from "@/domains/jobs/job-interface-data";
import { hoursOnJob } from "@/domains/jobs/job-hours";
import { hasSiteContext } from "@/domains/jobs/format";
import { isVisibleToField } from "@/domains/jobs/builder";
import { progressPct as canonicalProgressPct } from "@/domains/jobs/progress";
import { readEstimatedHours } from "@/domains/analytics/job-estimate";
import { CostRateHistoryResponseSchema, type CostRateEntry } from "@/domains/cost-rates/schema";
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
 *     At-risk/Watch/On-track read the jobs list shows, crew + task progress,
 *     and (admin) the Edit link beside the name into the builder Basics tab
 *   - Money &mdash; contract / labour / materials / margin, completeness notes,
 *     inline contract + estimate entry, budget variance (admin only)
 *   - Labour &mdash; hours AND cost per worker, day by day (admin only: the
 *     per-job hours read and the cost rates are office data)
 *   - Materials &mdash; the per-job spend ledger (admin only, behind the
 *     job_materials_spend flag)
 *   - Evidence &mdash; capture summary by status, with the Photos link
 *   - Build &amp; publish, Tag register (only when flagged) and Site context
 *
 * The health band's reasons come from /api/jobs?withStats=1 (the same stats
 * the list derives health from). Only that job fetch blocks the first paint:
 * the Labour and Evidence cards are Suspense-streamed async sections doing
 * their own fetch (the hours read recomputes from a full users/ scan and the
 * blob reads run 1&ndash;2s, so blocking on them made the whole page feel
 * broken &mdash; 2026-08-09 audit follow-up). Each still degrades to its own
 * error state via the unit-tested parsers; the Money and Materials cards are
 * client fetches with skeletons.
 *
 * 2026-08-23 audit (owner pull: "labour spent + its value, materials used +
 * their value, on one job"): the Labour card gained cost per worker off the
 * same effective-dated rates the Money card uses; the Money card's captions
 * and completeness notes tell the truth in every state; estimates are set
 * inline; the Materials ledger replaces a figure that read a file nothing
 * could write. A leading hand no longer gets a 403 error card for office
 * data &mdash; those cards are simply not rendered below the admin tier.
 *
 * This page does NOT replace the /v2/jobs/[jobId]/evidence route &mdash; it
 * adds a parent hub. JobsList row chips still deep-link past the hub into
 * evidence so power users keep their one-tap path.
 *
 * Cross-ref:
 *   src/app/v2/jobs/[jobId]/evidence/page.tsx &mdash; per-section page precedent
 *   src/components/phil/PhilJobDetail.tsx &mdash; Phil-side mirror of the
 *       same sections (with UC stubs)
 *   docs/job-materials-spend.md &mdash; the materials ledger
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
  // The materials spend ledger is an admin-tier launch-gate (dark by default).
  const materialsEnabled = canBuild && (await isFlagEnabled("job_materials_spend", session));

  const base = await requestBase();
  const result = await loadJob(base, raw, jobId);

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
          <Card
            className="border-state-warning-subtle-border bg-state-warning-subtle-bg"
            role="alert"
          >
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
    <AdminShell title={job.name} hideHead>
      <div className="mx-auto w-full max-w-[1200px]">
        {/* #215 — record this job view in the device-local recents ring buffer
            so ⌘K can offer a one-keystroke jump back. Renders nothing. */}
        <RecentItemTracker path={`/v2/jobs/${job.id}`} title={job.name} type="job" />

        <Link
          href="/v2/jobs"
          className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted underline decoration-accent-yellow decoration-2 underline-offset-4 hover:text-text focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          ← Jobs
        </Link>

        {/* Lean-reset step 5 (#916, owner-decided 2026-07-18): the hub is
            identity + money-path + capture + tags + site. Job Detail Variants
            (2026-08-10): the hero leads with the verdict, Money runs full
            width, then "doing left, knowing right" — the daily-decision cards
            (Labour, Materials, Evidence) in the wide column, reference &
            controls (Build & publish, Tag register, Site) in the narrow one. */}
        <div className="mt-3">
          <JobHealthBand job={job} canEdit={canBuild} progressPct={progressPct} />
        </div>

        {/* One money card, one fetch: profitability + budget variance are two
            views of the same endpoint. Client-fetched so the expensive
            approved-hours walk never blocks the hub render; admin-tier only
            (hidden for an LH/non-admin viewer). */}
        {canBuild ? (
          <div className="mt-5">
            <JobMoneyCard jobId={job.id} materialsLedgerEnabled={materialsEnabled} />
          </div>
        ) : null}

        <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="grid gap-5">
            {/* Suspense-streamed: the per-job hours walk is the slowest read on
                the page; the shell paints first and these cards fill in at
                their exact final footprint (2c). Office data — admin only. */}
            {canBuild ? (
              <Suspense fallback={<LabourSkeleton />}>
                <LabourSection base={base} cookieValue={raw} job={job} progressPct={progressPct} />
              </Suspense>
            ) : null}
            {materialsEnabled ? <JobMaterialsCard jobId={job.id} /> : null}
            <Suspense fallback={<EvidenceSkeleton />}>
              <EvidenceSection base={base} cookieValue={raw} jobId={job.id} />
            </Suspense>
          </div>
          <div className="grid gap-5">
            <JobBuildCard job={job} canBuild={canBuild} />
            <JobTagsSummary job={job} />
            {hasSiteContext(job) ? <SiteContextCard job={job} canBuild={canBuild} /> : null}
          </div>
        </div>
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
      <CardKicker>Build &amp; publish</CardKicker>
      {fieldVisible ? (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-state-success-subtle-text">
          <Eye aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> Published — visible to
          assigned field workers.
        </p>
      ) : (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-text-muted">
          <Lock aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> Not published — the field
          can&rsquo;t see this job yet. Publish from the builder.
        </p>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {canBuild ? (
          <a
            href={`/v2/jobs/${encodeURIComponent(job.id)}/builder` as Route}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-[4px] bg-brand-navy px-3.5 py-2 text-sm font-semibold text-text-inverse transition-colors hover:bg-accent-ink focus:outline-none focus:ring-2 focus:ring-brand-navy"
          >
            <PencilRuler aria-hidden="true" className="h-4 w-4" /> Open builder
          </a>
        ) : null}
        {/* #190 — copy structure + site basics into a new draft. */}
        <DuplicateJobButton jobId={job.id} />
      </div>
    </Card>
  );
}

function SiteContextCard({ job, canBuild }: { job: Job; canBuild: boolean }) {
  // 2d: when the reference fields are still blank, offer the one add link
  // rather than rendering invented rows or empty labels.
  const missingSome =
    !job.siteContactName?.trim() || !job.accessNotes || !job.parkingNotes || !job.safetyNotes;
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <CardKicker>Site</CardKicker>
        {canBuild ? (
          <a
            href={`/v2/jobs/${encodeURIComponent(job.id)}/builder?tab=basics` as Route}
            className="text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-4 focus:outline-none focus:ring-2 focus:ring-brand-navy"
          >
            Edit
          </a>
        ) : null}
      </div>
      <dl className="mt-4 grid gap-4 text-sm">
        {job.siteAddress ? (
          <SiteField icon={<MapPin className="h-4 w-4" />} label="Address">
            {job.siteAddress}
          </SiteField>
        ) : null}
        {job.siteContactName?.trim() || job.siteContactPhone?.trim() ? (
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
      {missingSome && canBuild ? (
        <a
          href={`/v2/jobs/${encodeURIComponent(job.id)}/builder?tab=basics` as Route}
          className="mt-4 inline-block text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-4 focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          Add contact, access, parking &amp; safety notes →
        </a>
      ) : null}
      {job.inductionRequired ? (
        <div className="mt-4 rounded-[4px] border border-state-warning-subtle-border bg-state-warning-subtle-bg px-4 py-3 text-state-warning-subtle-text">
          <p className="font-display text-sm font-bold">Site induction required</p>
          <p className="mt-0.5 text-xs leading-relaxed">
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
        <dt className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
          {label}
        </dt>
        <dd className="mt-0.5 whitespace-pre-line break-words text-text">{children}</dd>
      </div>
    </div>
  );
}

/**
 * Streaming load (2026-08-09 audit follow-up). Only the JOB fetch blocks the
 * page — it gates not_found/forbidden/error and feeds the band/build/site
 * cards. The hours and evidence reads (the slow ones: recompute-on-read over
 * a full users/ scan, 1–2s blob reads) each live in their own async section
 * below, Suspense-streamed so the shell paints first. All reads are GETs
 * forwarding the session cookie; nothing here mutates. Response parsing (and
 * its rejected/!ok/malformed branches) lives in — and is unit-tested via —
 * src/domains/jobs/job-interface-data.ts; the parsers take a settled result,
 * so each loader wraps its single fetch in Promise.allSettled.
 */
async function requestBase(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  return host ? `${proto}://${host}` : "http://localhost:3000";
}

function authInit(cookieValue: string | undefined) {
  return {
    cache: "no-store" as const,
    headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
  };
}

async function loadJob(base: string, cookieValue: string | undefined, jobId: string) {
  // withStats=1 so the band + tags card can show health / evidence / crew
  // counts on the loaded Job.
  const [jobRes] = await Promise.allSettled([
    fetch(`${base}/api/jobs?id=${encodeURIComponent(jobId)}&withStats=1`, authInit(cookieValue)),
  ]);
  return parseJobResult(jobRes);
}

/**
 * Per-job hours (#134): submitted + approved entries, then — for the workers
 * with hours on this job — each one's effective-dated cost-rate history
 * (api/cost-rates.js, admin-only) so the card can cost the hours with the
 * SAME resolution the Money card's server read uses. A worker whose rate read
 * fails is simply absent from the map and shows as unrated with a "Set rate"
 * link; if EVERY read fails the map is null and the card says "office only"
 * rather than mislabelling the whole crew as unrated.
 */
async function LabourSection({
  base,
  cookieValue,
  job,
  progressPct,
}: {
  base: string;
  cookieValue: string | undefined;
  job: Job;
  progressPct: number | null;
}) {
  const [hoursRes] = await Promise.allSettled([
    fetch(`${base}/api/job-hours?jobId=${encodeURIComponent(job.id)}`, authInit(cookieValue)),
  ]);
  const hours = await parseHoursResult(hoursRes);
  const workerIds = [
    ...new Set(
      hours.entries.filter((e) => e.userId && hoursOnJob(e, job.id) > 0).map((e) => e.userId)
    ),
  ];
  const [ratesByUser, employeeIdByUserId] = await Promise.all([
    loadRateHistories(base, cookieValue, workerIds),
    workerIds.length > 0 ? loadEmployeeIds(base, cookieValue) : Promise.resolve({}),
  ]);
  return (
    <JobLabourSummary
      entries={hours.entries}
      jobId={job.id}
      fetchError={hours.error}
      estimatedHours={readEstimatedHours(job)}
      progressPct={progressPct}
      ratesByUser={ratesByUser}
      employeeIdByUserId={employeeIdByUserId}
    />
  );
}

async function loadRateHistories(
  base: string,
  cookieValue: string | undefined,
  workerIds: string[]
): Promise<Record<string, CostRateEntry[]> | null> {
  if (workerIds.length === 0) return {};
  let failures = 0;
  const pairs = await Promise.all(
    workerIds.map(async (userId): Promise<[string, CostRateEntry[]] | null> => {
      try {
        const res = await fetch(
          `${base}/api/cost-rates?userId=${encodeURIComponent(userId)}`,
          authInit(cookieValue)
        );
        if (!res.ok) {
          failures += 1;
          return null;
        }
        const parsed = CostRateHistoryResponseSchema.safeParse(await res.json());
        if (!parsed.success) {
          failures += 1;
          return null;
        }
        return [userId, parsed.data.history];
      } catch {
        failures += 1;
        return null;
      }
    })
  );
  if (failures === workerIds.length) return null;
  const out: Record<string, CostRateEntry[]> = {};
  for (const p of pairs) if (p) out[p[0]] = p[1];
  return out;
}

const EmployeeIdsSchema = z
  .object({
    employees: z.array(
      z.object({ id: z.string(), userId: z.string().nullable().optional() }).passthrough()
    ),
  })
  .passthrough();

/** users.json id → employees.json id, so an unrated worker links straight to
 *  the employee record the cost rate is set on. Fail-soft: {} on any error. */
async function loadEmployeeIds(
  base: string,
  cookieValue: string | undefined
): Promise<Record<string, string>> {
  try {
    const res = await fetch(`${base}/api/employees`, authInit(cookieValue));
    if (!res.ok) return {};
    const parsed = EmployeeIdsSchema.safeParse(await res.json());
    if (!parsed.success) return {};
    const out: Record<string, string> = {};
    for (const e of parsed.data.employees) if (e.userId) out[e.userId] = e.id;
    return out;
  } catch {
    return {};
  }
}

async function EvidenceSection({
  base,
  cookieValue,
  jobId,
}: {
  base: string;
  cookieValue: string | undefined;
  jobId: string;
}) {
  const [evidenceRes] = await Promise.allSettled([
    fetch(`${base}/api/evidence?jobId=${encodeURIComponent(jobId)}`, authInit(cookieValue)),
  ]);
  const evidence = await parseEvidenceResult(evidenceRes);
  return (
    <JobEvidenceSummary evidence={evidence.evidence} jobId={jobId} fetchError={evidence.error} />
  );
}

/** Streaming fallbacks (2c) — same Card chrome AND the exact footprint of the
 *  section each stands in for, so nothing jumps when the data lands. */
function LabourSkeleton() {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <CardKicker>Labour</CardKicker>
        <div className="sk h-4 w-28" />
      </div>
      <div
        className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"
        data-testid="section-skeleton"
        aria-hidden="true"
      >
        {["Approved", "Awaiting approval", "Labour cost", "If approved"].map((label) => (
          <div
            key={label}
            className="rounded-[4px] border border-border bg-surface-subtle px-4 py-3"
          >
            <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
              {label}
            </p>
            <div className="sk mt-1 h-[22px] w-14" />
          </div>
        ))}
      </div>
      <div className="mt-4 grid gap-2" aria-hidden="true">
        <div className="sk h-4 w-full" />
        <div className="sk h-4 w-full" />
        <div className="sk h-4 w-[72%]" />
      </div>
      <div className="sk mt-4 h-9 w-full rounded-[4px]" aria-hidden="true" />
      <div className="sk mt-3 h-3.5 w-72 max-w-full" aria-hidden="true" />
    </Card>
  );
}

function EvidenceSkeleton() {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <CardKicker>Evidence</CardKicker>
        <div className="flex items-center gap-2" aria-hidden="true">
          <div className="sk h-8 w-24 rounded-[4px]" />
          <div className="sk h-8 w-24 rounded-[4px]" />
        </div>
      </div>
      <div
        className="mt-4 grid grid-cols-4 gap-1.5 sm:grid-cols-6"
        data-testid="section-skeleton"
        aria-hidden="true"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className={i >= 4 ? "sk hidden aspect-square sm:block" : "sk aspect-square"}
          />
        ))}
      </div>
      <div className="mt-3.5 flex items-center gap-2" aria-hidden="true">
        <div className="sk h-5 w-20 rounded-pill" />
        <div className="sk h-5 w-24 rounded-pill" />
      </div>
      <div className="sk mt-3 h-4 w-64 max-w-full" aria-hidden="true" />
    </Card>
  );
}
