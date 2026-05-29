import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import {
  AlertOctagon,
  ArrowRight,
  Briefcase,
  Camera,
  ClipboardCheck,
  Clock,
  FileCheck2,
  Inbox,
  Wrench,
} from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { TimeEntryListResponseSchema } from "@/domains/timesheets/schema";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import { ObservationListResponseSchema } from "@/domains/observations/schema";
import { isOpenObservation } from "@/domains/observations/service";
import type { TimeEntry } from "@/domains/timesheets/types";
import type { Job } from "@/domains/jobs/types";
import type { ObservationItem } from "@/domains/observations/types";
import { relativeWhen } from "@/domains/jobs/format";
import { summariseItpReviewQueue } from "./itp-queue-card";

export const dynamic = "force-dynamic";

/**
 * /command-centre — BuhlOS admin home.
 *
 * Queue-shaped per doc 27 §9.1: each card is a count + oldest item age +
 * one-click drill-in. No KPI cards, no charts — those land with the
 * reports phase. The home should always answer "what needs my attention
 * first?" rather than "what happened this week?"
 *
 * Four queues today:
 *   - Hours pending approval — /api/time-entries?scope=approver&status=submitted
 *   - Evidence pending review — aggregated from /api/jobs?withStats=1
 *   - Snags needing attention — aggregated from /api/jobs?withStats=1
 *   - ITPs needing sign-off — aggregated from /api/jobs?withStats=1
 *     (statsItpsNeedsReview, witnessed-only subset of statsItpsActive)
 *
 * Followed by a thin "Live surfaces" strip linking to the four working
 * admin pages (Hours, Approvals, Gear, Jobs). Anything else is still
 * being built and lives behind the sidebar UC pills.
 */
export default async function CommandCentrePage() {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/command-centre");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }

  const { hoursPending, jobs, observations, hoursError, jobsError, observationsError } =
    await loadSnapshot(raw);

  const evidencePending = jobs.reduce(
    (sum, j) => sum + (j.statsEvidenceV2Pending ?? 0),
    0
  );
  const snagsActive = jobs.reduce(
    (sum, j) => sum + (j.statsSnagsV2Active ?? 0),
    0
  );

  const oldestHours = oldestAge(
    hoursPending.map((e) => e.submittedAt).filter(Boolean) as string[]
  );
  const jobsWithEvidence = jobs.filter(
    (j) => (j.statsEvidenceV2Pending ?? 0) > 0
  );
  const jobsWithSnags = jobs.filter((j) => (j.statsSnagsV2Active ?? 0) > 0);
  const itpReview = summariseItpReviewQueue(jobs);

  // When a cross-job queue is concentrated on a single job, deep-link
  // straight to that job's section instead of dropping the owner on the
  // jobs index to hunt for it. Mirrors the ITP card's behaviour. The
  // cross-job inbox (many jobs) is still UC, so /v2/jobs is the honest
  // destination there.
  const evidenceTarget = singleJobTarget(jobsWithEvidence, "evidence");
  const snagsTarget = singleJobTarget(jobsWithSnags, "snags");

  // Open observations flagged as needing office action (the field-to-office
  // loop's "what came in from site" queue).
  const obsNeedingAction = observations.filter(
    (o) => isOpenObservation(o.status) && o.requiresAction
  );
  const obsCount = obsNeedingAction.length;
  const obsJobsAffected = new Set(obsNeedingAction.map((o) => o.jobId)).size;

  const allClear =
    hoursPending.length === 0 &&
    evidencePending === 0 &&
    snagsActive === 0 &&
    itpReview.count === 0 &&
    obsCount === 0 &&
    !hoursError &&
    !jobsError &&
    !observationsError;

  return (
    <AdminShell title="Command Centre">
      <div className="mx-auto max-w-5xl space-y-6">
        <section>
          <h2 className="font-display text-sm uppercase tracking-wider text-text-muted">
            Needs your attention
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            Open queues across the live loops. Each card is one click into
            the action.
          </p>

          {hoursError || jobsError || observationsError ? (
            <Card
              className="mt-3 border-amber-200 bg-amber-50"
              role="alert"
            >
              <CardTitle>Couldn&rsquo;t load every queue</CardTitle>
              <CardDescription className="text-amber-900">
                {hoursError ?? jobsError ?? observationsError}. Counts shown may
                be incomplete.
              </CardDescription>
              <div className="mt-3">
                <RefreshButton />
              </div>
            </Card>
          ) : null}

          {allClear ? (
            <Card className="mt-3 border-emerald-200 bg-emerald-50" role="status">
              <CardTitle className="text-emerald-900">All clear</CardTitle>
              <CardDescription className="text-emerald-900">
                Nothing needs you right now — no hours, evidence, snags, ITPs or
                observations waiting. New submissions land here as they come in.
              </CardDescription>
            </Card>
          ) : null}

          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <QueueCard
              icon={<ClipboardCheck aria-hidden="true" className="h-5 w-5" />}
              label="Hours pending approval"
              count={hoursPending.length}
              ageLabel={oldestHours}
              href="/hours/approvals"
              ctaLabel="Review approvals"
              empty="No timesheets waiting for you."
            />
            <QueueCard
              icon={<Camera aria-hidden="true" className="h-5 w-5" />}
              label="Evidence to review"
              count={evidencePending}
              jobsAffected={jobsWithEvidence.length}
              href={evidenceTarget.href as Route}
              ctaLabel={evidenceTarget.cta}
              empty="No evidence waiting for review."
            />
            <QueueCard
              icon={<AlertOctagon aria-hidden="true" className="h-5 w-5" />}
              label="Snags needing attention"
              count={snagsActive}
              jobsAffected={jobsWithSnags.length}
              href={snagsTarget.href as Route}
              ctaLabel={snagsTarget.cta}
              empty="Nice — no open snags right now."
            />
            <QueueCard
              icon={<FileCheck2 aria-hidden="true" className="h-5 w-5" />}
              label="ITPs needing sign-off"
              count={itpReview.count}
              jobsAffected={itpReview.jobsAffected}
              href={itpReview.href as Route}
              ctaLabel={
                itpReview.jobsAffected === 1 ? "Open ITP queue" : "Open jobs"
              }
              empty="No ITPs waiting for sign-off."
            />
            <QueueCard
              icon={<Inbox aria-hidden="true" className="h-5 w-5" />}
              label="Observations to action"
              count={obsCount}
              jobsAffected={obsJobsAffected}
              href={"/observations" as Route}
              ctaLabel="Open inbox"
              empty="No field observations need action."
            />
          </div>
        </section>

        <section>
          <h2 className="font-display text-sm uppercase tracking-wider text-text-muted">
            Live surfaces
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
            <SurfaceLink
              href="/hours"
              icon={<Clock aria-hidden="true" className="h-4 w-4" />}
              label="Hours"
              hint="Pending · approved · rejected"
            />
            <SurfaceLink
              href="/hours/approvals"
              icon={<ClipboardCheck aria-hidden="true" className="h-4 w-4" />}
              label="Approvals"
              hint="Approve or reject submissions"
            />
            <SurfaceLink
              href="/gear"
              icon={<Wrench aria-hidden="true" className="h-4 w-4" />}
              label="Gear register"
              hint="Who holds what · damage · returns"
            />
            <SurfaceLink
              href={"/v2/jobs" as Route}
              icon={<Briefcase aria-hidden="true" className="h-4 w-4" />}
              label="Jobs"
              hint="Evidence + snags per job"
            />
          </div>
        </section>

        <section>
          <Card>
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <CardTitle>Still being built</CardTitle>
                <CardDescription className="mt-1">
                  The cross-job snags inbox, reports / payroll exports and
                  full settings live behind the UC pills in the sidebar.
                  Nothing in legacy production has changed — the canonical
                  URLs (
                  <code className="text-xs">/admin/operations</code>,{" "}
                  <code className="text-xs">/admin/jobs</code>, …) keep
                  serving via rewrites.
                </CardDescription>
              </div>
              <Pill tone="neutral">UC</Pill>
            </div>
          </Card>
        </section>
      </div>
    </AdminShell>
  );
}

function QueueCard({
  icon,
  label,
  count,
  ageLabel,
  jobsAffected,
  href,
  ctaLabel,
  empty,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  /** Oldest-item age, e.g. "3d ago" — only for the hours queue. */
  ageLabel?: string | null;
  /** Number of jobs the count spans — only for cross-job aggregates. */
  jobsAffected?: number;
  href: Route;
  ctaLabel: string;
  empty: string;
}) {
  const isEmpty = count <= 0;
  return (
    <Link
      href={href}
      className="group block focus:outline-none focus:ring-2 focus:ring-brand-navy"
      aria-label={`${label}: ${count}`}
    >
      <Card
        className={
          isEmpty
            ? "h-full border-border bg-surface-raised"
            : "h-full border-brand-navy bg-brand-navy text-text-inverse"
        }
      >
        <div className="flex items-start justify-between gap-3">
          <div className={isEmpty ? "text-text-muted" : "text-text-inverse"}>
            {icon}
          </div>
          <Pill
            tone={isEmpty ? "neutral" : "yellow"}
            className={
              isEmpty
                ? "text-text-muted"
                : "font-display text-base font-semibold"
            }
          >
            {count}
          </Pill>
        </div>
        <p
          className={
            "mt-3 font-display text-base font-semibold " +
            (isEmpty ? "text-text" : "text-text-inverse")
          }
        >
          {label}
        </p>
        <p
          className={
            "mt-1 text-xs " +
            (isEmpty ? "text-text-muted" : "text-text-inverse/80")
          }
        >
          {isEmpty
            ? empty
            : ageLabel
              ? `Oldest ${ageLabel}`
              : jobsAffected != null
                ? `${jobsAffected} ${jobsAffected === 1 ? "job" : "jobs"} affected`
                : ""}
        </p>
        {!isEmpty ? (
          <p className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent-yellow">
            {ctaLabel}
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </p>
        ) : null}
      </Card>
    </Link>
  );
}

function SurfaceLink({
  href,
  icon,
  label,
  hint,
}: {
  href: Route;
  icon: React.ReactNode;
  label: string;
  hint: string;
}) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-card border border-border bg-surface-raised px-4 py-3 transition-colors hover:border-brand-navy hover:bg-surface focus:outline-none focus:ring-2 focus:ring-brand-navy"
    >
      <span className="flex items-center gap-2 font-display text-sm font-semibold text-text">
        <span aria-hidden="true" className="text-text-muted">
          {icon}
        </span>
        {label}
      </span>
      <span className="text-xs text-text-muted">{hint}</span>
    </Link>
  );
}

/**
 * Where a cross-job queue card should point. When exactly one job carries
 * the whole count, deep-link to that job's section so the owner is one
 * click from the work; otherwise fall back to the jobs index (the
 * cross-job inbox is still UC).
 */
function singleJobTarget(
  jobsAffected: ReadonlyArray<Job>,
  section: "evidence" | "snags",
): { href: string; cta: string } {
  if (jobsAffected.length === 1) {
    return {
      href: `/v2/jobs/${jobsAffected[0]!.id}/${section}`,
      cta: section === "evidence" ? "Open evidence" : "Open snags",
    };
  }
  return { href: "/v2/jobs", cta: "Open jobs" };
}

function oldestAge(timestamps: ReadonlyArray<string>): string | null {
  if (timestamps.length === 0) return null;
  // Find the smallest (earliest) ISO timestamp string. ISO 8601 sorts
  // lexicographically the same as chronologically, which is enough for
  // a queue with submittedAt timestamps written by the same API.
  let oldest: string | null = null;
  for (const t of timestamps) {
    if (!t) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  if (!oldest) return null;
  return relativeWhen(oldest);
}

async function loadSnapshot(cookieValue: string | undefined): Promise<{
  hoursPending: ReadonlyArray<TimeEntry>;
  jobs: ReadonlyArray<Job>;
  observations: ReadonlyArray<ObservationItem>;
  hoursError: string | null;
  jobsError: string | null;
  observationsError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const headersInit = cookieValue
    ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
    : undefined;

  const [hoursResult, jobsResult, obsResult] = await Promise.all([
    loadHoursPending(base, headersInit),
    loadJobsWithStats(base, headersInit),
    loadObservations(base, headersInit),
  ]);

  return {
    hoursPending: hoursResult.entries,
    jobs: jobsResult.jobs,
    observations: obsResult.observations,
    hoursError: hoursResult.error,
    jobsError: jobsResult.error,
    observationsError: obsResult.error,
  };
}

async function loadObservations(
  base: string,
  headersInit: { cookie: string } | undefined
): Promise<{ observations: ReadonlyArray<ObservationItem>; error: string | null }> {
  try {
    const res = await fetch(`${base}/api/observations`, {
      cache: "no-store",
      headers: headersInit,
    });
    if (!res.ok) {
      return { observations: [], error: `Observations API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = ObservationListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { observations: [], error: "Unexpected observations response shape" };
    }
    return { observations: parsed.data.observations, error: null };
  } catch (err) {
    return {
      observations: [],
      error: err instanceof Error ? err.message : "Observations network error",
    };
  }
}

async function loadHoursPending(
  base: string,
  headersInit: { cookie: string } | undefined
): Promise<{ entries: ReadonlyArray<TimeEntry>; error: string | null }> {
  try {
    const res = await fetch(
      `${base}/api/time-entries?scope=approver&status=submitted`,
      { cache: "no-store", headers: headersInit }
    );
    if (!res.ok) {
      return { entries: [], error: `Hours API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = TimeEntryListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { entries: [], error: "Unexpected hours response shape" };
    }
    return { entries: parsed.data.entries, error: null };
  } catch (err) {
    return {
      entries: [],
      error: err instanceof Error ? err.message : "Hours network error",
    };
  }
}

async function loadJobsWithStats(
  base: string,
  headersInit: { cookie: string } | undefined
): Promise<{ jobs: ReadonlyArray<Job>; error: string | null }> {
  try {
    const res = await fetch(`${base}/api/jobs?withStats=1`, {
      cache: "no-store",
      headers: headersInit,
    });
    if (!res.ok) {
      return { jobs: [], error: `Jobs API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = JobListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { jobs: [], error: "Unexpected jobs response shape" };
    }
    // Drop archived from the aggregates — archived jobs aren't on the
    // admin radar.
    const live = parsed.data.jobs.filter((j) => j.status !== "archived");
    return { jobs: live, error: null };
  } catch (err) {
    return {
      jobs: [],
      error: err instanceof Error ? err.message : "Jobs network error",
    };
  }
}
