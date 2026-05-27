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
  Wrench,
} from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { TimeEntryListResponseSchema } from "@/domains/timesheets/schema";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import type { TimeEntry } from "@/domains/timesheets/types";
import type { Job } from "@/domains/jobs/types";
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

  const { hoursPending, jobs, hoursError, jobsError } = await loadSnapshot(raw);

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

          {hoursError || jobsError ? (
            <Card
              className="mt-3 border-amber-200 bg-amber-50"
              role="alert"
            >
              <CardTitle>Couldn&rsquo;t load every queue</CardTitle>
              <CardDescription className="text-amber-900">
                {hoursError ?? jobsError}. Counts shown may be incomplete —
                refresh the page once the API is back.
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
              href={"/v2/jobs" as Route}
              ctaLabel="Open jobs"
              empty="No evidence waiting for review."
            />
            <QueueCard
              icon={<AlertOctagon aria-hidden="true" className="h-5 w-5" />}
              label="Snags needing attention"
              count={snagsActive}
              jobsAffected={jobsWithSnags.length}
              href={"/v2/jobs" as Route}
              ctaLabel="Open jobs"
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
  hoursError: string | null;
  jobsError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const headersInit = cookieValue
    ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
    : undefined;

  const [hoursResult, jobsResult] = await Promise.all([
    loadHoursPending(base, headersInit),
    loadJobsWithStats(base, headersInit),
  ]);

  return {
    hoursPending: hoursResult.entries,
    jobs: jobsResult.jobs,
    hoursError: hoursResult.error,
    jobsError: jobsResult.error,
  };
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
