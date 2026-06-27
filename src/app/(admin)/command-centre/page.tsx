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
  Layers,
  Package,
  RotateCcw,
  UserX,
  Wrench,
} from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { PushNotificationsCard } from "@/components/pwa/PushNotificationsCard";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SESSION_COOKIE, decodeSessionCookie, verifyViaApi } from "@/lib/auth/session";
import { isFlagEnabled, listFlags, isFlagOn } from "../../../../api/_lib/feature-flags.js";
import { partOfDayForHour, firstNameFrom, hourInTimeZone } from "@/domains/phil/greeting";
import { ExpenseListResponseSchema } from "@/domains/expenses/schema";
import { MobileToday } from "./MobileToday";
import { ProofReviewQueue } from "@/components/admin/ProofReviewQueue";
import {
  runProofQueue,
  blobProofQueueDeps,
  type ProofQueueItem,
} from "@/server/job-control/proof-queue";
import { canAccessSurface } from "@/lib/auth/permissions";
import {
  TimeEntryListResponseSchema,
  TimeEntryOverviewResponseSchema,
  TodayPulseResponseSchema,
} from "@/domains/timesheets/schema";
import { summariseTodayStrip } from "@/domains/timesheets/today-strip";
import { TodayStrip } from "@/components/admin/TodayStrip";
import {
  BUSINESS_TIMEZONE,
  localDateString,
  summariseMissing,
} from "@/domains/timesheets/service";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import { ObservationListResponseSchema } from "@/domains/observations/schema";
import { isOpenObservation } from "@/domains/observations/service";
import { MaterialRequestListResponseSchema } from "@/domains/material-requests/schema";
import { isOpenRequest } from "@/domains/material-requests/service";
import type {
  MissingLog,
  TimeEntry,
  TodayPulseResponse,
} from "@/domains/timesheets/types";
import type { Job } from "@/domains/jobs/types";
import type { ObservationItem } from "@/domains/observations/types";
import type { MaterialRequestItem } from "@/domains/material-requests/types";
import { relativeWhen } from "@/domains/jobs/format";
import { buildExceptions, decorateAges } from "@/domains/exceptions/service";
import { ExceptionsInbox } from "@/components/admin/ExceptionsInbox";
import { summariseItpReviewQueue } from "./itp-queue-card";
import { singleJobTarget } from "./queue-card-targets";

export const dynamic = "force-dynamic";

/**
 * /command-centre — BuhlOS admin home.
 *
 * Queue-shaped per doc 27 §9.1: each card is a count + oldest item age +
 * one-click drill-in. No KPI cards, no charts — those land with the
 * reports phase. The home should always answer "what needs my attention
 * first?" rather than "what happened this week?"
 *
 * Nine queues today (real data only — no fake metrics):
 *   - Hours pending approval — /api/time-entries?scope=approver&status=submitted
 *   - Evidence pending review — aggregated from /api/jobs?withStats=1
 *   - Snags needing attention — aggregated from /api/jobs?withStats=1
 *   - ITPs needing sign-off — aggregated from /api/jobs?withStats=1
 *     (statsItpsNeedsReview, witnessed-only subset of statsItpsActive)
 *   - Observations to action — open + requiresAction from /api/observations (PR 3)
 *   - Rejected hours — /api/time-entries?scope=approver&status=rejected (PR 7)
 *   - Missing hours — assigned crew with no entry on a past weekday, from
 *     /api/time-entries-overview (rolling 7-day window, weekdays only)
 *   - Plan mismatches — type='plan_mismatch' subset of the observations fetch (PR 7)
 *   - Material requests — open subset of /api/material-requests (PR 11; status
 *     in {requested, approved} = "office action needed before procurement")
 *
 * Followed by a thin "Live surfaces" strip linking to the four working
 * admin pages (Hours, Approvals, Gear, Jobs). Anything else is still
 * being built and lives behind the sidebar UC pills.
 *
 * #185: the page LEADS with a compact "Today" strip (api/today-pulse via
 * the same loadSnapshot pass — who's on the clock, hours logged today, and
 * the SAME pending-approvals count the Hours queue card shows). That strip
 * is the operational morning view; analytics tiles / the six-numbers board
 * are #316's separate surface and must not creep in here.
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

  const {
    hoursPending,
    hoursRejected,
    hoursMissing,
    jobs,
    observations,
    materialRequests,
    todayPulse,
    expensesSubmitted,
    displayName,
    hoursError,
    hoursRejectedError,
    hoursMissingError,
    jobsError,
    observationsError,
    materialRequestsError,
    todayPulseError,
  } = await loadSnapshot(raw);

  // #185 Today strip — pure derivation from the pulse payload. Null model
  // (failed fetch) renders the strip's own error chip; the queues are
  // untouched either way.
  const todayStrip = summariseTodayStrip(todayPulse);

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

  // #155 pilot: the flags readout is itself flag-gated + admin-tier targeted
  // — dark for everyone (incl. this page) until FLAG_ADMIN_FLAGS_READOUT or
  // the flags.json override turns it on, and never rendered to non-admin
  // tiers even then. The first consumer of the flag system is the flag
  // system's own ops surface.
  // #503 — Proof to sign off (mobile-admin redesign, flagged admin-tier). When
  // on, the cross-job submitted-proof queue is scanned server-side and shown as
  // a Command Centre surface; dark (zero render, zero scan) when off.
  const showProofReview = await isFlagEnabled("admin_proof_review", session);
  let proofItems: ProofQueueItem[] = [];
  if (showProofReview) {
    const res = await runProofQueue(blobProofQueueDeps());
    proofItems = res.ok ? res.items : [];
  }

  const showFlagsReadout = await isFlagEnabled("admin_flags_readout", session);
  const flagStates = showFlagsReadout
    ? await Promise.all(
        listFlags().map(async (f) => ({ key: f.key, on: await isFlagOn(f.key), target: f.target }))
      )
    : [];

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

  // PR 7: real exception sub-queue derived from the same observations fetch
  // (no extra round-trip). Plan mismatches are the observation type the owner
  // most often actions personally — the inbox already filters them, but the
  // count belongs on the morning view too.
  const obsPlanMismatch = obsNeedingAction.filter((o) => o.type === "plan_mismatch");
  const planMismatchCount = obsPlanMismatch.length;
  const planMismatchJobs = new Set(obsPlanMismatch.map((o) => o.jobId)).size;

  // PR 11: the Material requests queue is now real — count open ones
  // (status='requested' or 'approved' = "office action needed before
  // procurement places the order"). Observations of type='material_request'
  // that haven't yet been converted still surface in the main Observations
  // card; this card represents the procurement-side queue only.
  const openMaterialRequests = materialRequests.filter((m) =>
    isOpenRequest(m.status)
  );
  const materialRequestCount = openMaterialRequests.length;
  const materialRequestJobs = new Set(
    openMaterialRequests.map((m) => m.jobId)
  ).size;

  // PR 7: rejected hours that the worker hasn't yet re-submitted. Real data
  // from /api/time-entries?scope=approver&status=rejected; the boss sees the
  // count so they can nudge the worker (or correct the rejection).
  const rejectedHoursCount = hoursRejected.length;
  const rejectedHoursOldest = oldestAge(
    hoursRejected.map((e) => e.submittedAt).filter(Boolean) as string[]
  );

  // Missing hours: assigned crew with no entry on a past weekday in the
  // rolling window (server-computed in /api/time-entries-overview — weekdays
  // only, past days only, LH-scoped). The card count is the number of *people*
  // who owe hours; the subtitle is the age of the oldest unlogged day.
  const missingSummary = summariseMissing(hoursMissing);
  const missingHoursCount = missingSummary.workerCount;
  const missingHoursOldest = missingSummary.oldestDate
    ? relativeWhen(missingSummary.oldestDate + "T00:00:00Z")
    : null;

  const allClear =
    hoursPending.length === 0 &&
    rejectedHoursCount === 0 &&
    missingHoursCount === 0 &&
    evidencePending === 0 &&
    snagsActive === 0 &&
    itpReview.count === 0 &&
    obsCount === 0 &&
    planMismatchCount === 0 &&
    materialRequestCount === 0 &&
    !hoursError &&
    !hoursRejectedError &&
    !hoursMissingError &&
    !jobsError &&
    !observationsError &&
    !materialRequestsError &&
    // #185: the Today strip participates in all-clear — we can't claim the
    // morning view is complete while its source failed. (A quiet zero-day
    // pulse does NOT block all-clear; only a load failure does.)
    !todayPulseError;

  // Itemised "Needs attention" projection over the SAME already-loaded,
  // admin-gated sources the count cards use — no new fetch, no new store.
  const exceptions = decorateAges(
    buildExceptions({
      hoursPending,
      hoursRejected,
      jobs,
      observations,
      materialRequests,
    }),
    Date.now(),
  );
  const anySourceError =
    !!(hoursError ||
      hoursRejectedError ||
      jobsError ||
      observationsError ||
      materialRequestsError);

  // Mobile "Today" — a simpler projection of the SAME data for the < md home.
  // Greeting: the cookie carries no name, so it's resolved from /api/auth?action=me
  // (mirrors Phil My Day); fails soft to the impersonal part-of-day form.
  const partOfDay = partOfDayForHour(hourInTimeZone(new Date(), BUSINESS_TIMEZONE));
  const firstName = firstNameFrom(displayName);
  const greeting = firstName ? `${partOfDay}, ${firstName}` : partOfDay;
  const dateLabel = new Date().toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: BUSINESS_TIMEZONE,
  });
  // Day-to-day approvals (hours excluded — they're a weekly closeout): the
  // office queues that have a real approve action today.
  // The "to approve" pulse routes to /hours/approvals — expenses + ITPs +
  // materials. Proof-to-sign-off has its OWN section on Today (above), so it is
  // not folded into this hub-bound count (it would mislead the deep-link).
  const mobileApprovals = {
    expenses: expensesSubmitted,
    itps: itpReview.count,
    materials: materialRequestCount,
  };
  const mobileAllClear =
    exceptions.length === 0 &&
    expensesSubmitted === 0 &&
    itpReview.count === 0 &&
    materialRequestCount === 0 &&
    proofItems.length === 0 &&
    hoursPending.length === 0 &&
    !anySourceError &&
    !todayPulseError;

  return (
    <AdminShell title="Command Centre">
      {/* #503 Proof to sign off — the highest-trust office action, so it leads
          at all breakpoints. Flag-gated + admin-tier; dark (nothing here) when
          off. Wired to the existing proof-review engine. */}
      {showProofReview ? (
        <section aria-label="Proof to sign off" className="mx-auto mb-6 max-w-5xl">
          <h2 className="font-display text-sm uppercase tracking-wider text-text-muted">
            Proof to sign off
          </h2>
          <p className="mb-3 mt-1 text-sm text-text-muted">
            {proofItems.length > 0
              ? `${proofItems.length} task${proofItems.length === 1 ? "" : "s"} with site photos waiting on you.`
              : "Site photos a worker captured against required evidence land here for sign-off."}
          </p>
          <ProofReviewQueue initialItems={proofItems} />
        </section>
      ) : null}
      {/* Mobile home — the calm single-screen "what needs me first?". Desktop
          (the strip + 9-card grid + inbox below) is untouched, hidden < md. */}
      <div className="md:hidden">
        <MobileToday
          greeting={greeting}
          dateLabel={dateLabel}
          todayStrip={todayStrip}
          todayPulseError={todayPulseError}
          jobsActive={todayPulse ? todayPulse.jobs.activeJobs : null}
          pendingHours={hoursPending.length}
          approvals={mobileApprovals}
          exceptions={exceptions}
          anySourceError={anySourceError}
          errorMessage={
            hoursError ??
            hoursRejectedError ??
            jobsError ??
            observationsError ??
            materialRequestsError
          }
          allClear={mobileAllClear}
        />
      </div>
      {/* Desktop home — unchanged, hidden on phones (the mobile view above). */}
      <div className="mx-auto hidden max-w-5xl space-y-6 md:block">
        {showFlagsReadout ? (
          <section
            aria-label="Active feature flags"
            className="rounded-card border border-dashed border-border bg-surface-subtle px-4 py-3 text-xs text-text-muted"
          >
            <span className="font-semibold uppercase tracking-wider">Feature flags</span>{" "}
            {flagStates
              .map((f) => `${f.key}: ${f.on ? "ON" : "off"}${f.target === "admin-tier" ? " (admin tier)" : ""}`)
              .join(" · ")}{" "}
            — flip via FLAG_* env or the flags.json override (docs/feature-flags.md).
          </section>
        ) : null}
        {/* #185 — Today strip: the operational morning view (who's on the
            clock + the same pending count as the Hours card below). A strip,
            not a hero: the needs-you queue cards stay above the fold. */}
        <section aria-label="Today at a glance">
          <TodayStrip
            model={todayStrip}
            pulseError={todayPulseError}
            pendingApprovals={hoursPending.length}
          />
        </section>

        <section>
          <h2 className="font-display text-sm uppercase tracking-wider text-text-muted">
            Needs your attention
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            Open queues across the live loops. Each card is one click into
            the action.
          </p>

          {hoursError ||
          hoursRejectedError ||
          hoursMissingError ||
          jobsError ||
          observationsError ||
          materialRequestsError ? (
            <Card
              className="mt-3 border-amber-200 bg-amber-50"
              role="alert"
            >
              <CardTitle>Couldn&rsquo;t load every queue</CardTitle>
              <CardDescription className="text-amber-900">
                {hoursError ??
                  hoursRejectedError ??
                  hoursMissingError ??
                  jobsError ??
                  observationsError ??
                  materialRequestsError}
                . Counts shown may be incomplete.
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
                Nothing needs you right now — no hours pending, rejected or
                missing, no evidence, snags, ITPs, observations, plan mismatches
                or material requests waiting. New submissions land here as they
                come in.
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
            <QueueCard
              icon={<RotateCcw aria-hidden="true" className="h-5 w-5" />}
              label="Rejected hours"
              count={rejectedHoursCount}
              ageLabel={rejectedHoursOldest}
              href="/hours/approvals"
              ctaLabel="Review rejections"
              empty="No rejected timesheets waiting on a worker."
            />
            <QueueCard
              icon={<UserX aria-hidden="true" className="h-5 w-5" />}
              label="Missing hours"
              count={missingHoursCount}
              ageLabel={missingHoursOldest}
              href="/hours"
              ctaLabel="Chase missing hours"
              empty="Everyone's hours are in — no gaps."
            />
            <QueueCard
              icon={<Layers aria-hidden="true" className="h-5 w-5" />}
              label="Plan mismatches"
              count={planMismatchCount}
              jobsAffected={planMismatchJobs}
              href={"/observations" as Route}
              ctaLabel="Open inbox"
              empty="No plan mismatches reported from site."
            />
            <QueueCard
              icon={<Package aria-hidden="true" className="h-5 w-5" />}
              label="Material requests"
              count={materialRequestCount}
              jobsAffected={materialRequestJobs}
              href={"/material-requests" as Route}
              ctaLabel="Open material requests"
              empty="No material requests waiting on the office."
            />
          </div>
        </section>

        <section aria-label="Needs attention — item by item">
          <ExceptionsInbox initialItems={exceptions} partial={anySourceError} />
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
          <PushNotificationsCard audience="admin" />
        </section>

        <section>
          <Card>
            <div className="flex items-baseline justify-between gap-3">
              <div>
                <CardTitle>Still being built</CardTitle>
                <CardDescription className="mt-1">
                  A cross-job snags inbox and a full settings hub aren&rsquo;t
                  built yet. This is the only admin interface — the old{" "}
                  <code className="text-xs">/admin/*</code> tool suite was
                  retired in the legacy cutover and its URLs redirect here.
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
  hoursRejected: ReadonlyArray<TimeEntry>;
  hoursMissing: ReadonlyArray<MissingLog>;
  jobs: ReadonlyArray<Job>;
  observations: ReadonlyArray<ObservationItem>;
  materialRequests: ReadonlyArray<MaterialRequestItem>;
  todayPulse: TodayPulseResponse | null;
  /** Submitted expense claims awaiting review — the count for the mobile pulse. */
  expensesSubmitted: number;
  /** The admin's display name (cookie has none) — for the mobile greeting. */
  displayName: string | null;
  hoursError: string | null;
  hoursRejectedError: string | null;
  hoursMissingError: string | null;
  jobsError: string | null;
  observationsError: string | null;
  materialRequestsError: string | null;
  todayPulseError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const headersInit = cookieValue
    ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
    : undefined;

  // Missing-hours window: a rolling 7-day look-back ending *yesterday* in the
  // business timezone. We stop at yesterday so today's not-yet-logged hours
  // don't register as "missing" all morning; the server further restricts to
  // weekdays and past days.
  const DAY_MS = 86_400_000;
  const now = Date.now();
  const missingFrom = localDateString(new Date(now - 7 * DAY_MS), BUSINESS_TIMEZONE);
  const missingTo = localDateString(new Date(now - DAY_MS), BUSINESS_TIMEZONE);

  const [
    hoursResult,
    hoursRejectedResult,
    hoursMissingResult,
    jobsResult,
    obsResult,
    mrResult,
    todayPulseResult,
    expensesResult,
    profile,
  ] = await Promise.all([
    loadHoursByStatus(base, headersInit, "submitted"),
    loadHoursByStatus(base, headersInit, "rejected"),
    loadHoursOverview(base, headersInit, missingFrom, missingTo),
    loadJobsWithStats(base, headersInit),
    loadObservations(base, headersInit),
    loadMaterialRequests(base, headersInit),
    loadTodayPulse(base, headersInit),
    loadExpensesSubmitted(base, headersInit),
    // The greeting name — resolved from the authoritative /api/auth?action=me
    // (the cookie carries no name). Fails soft to null → impersonal greeting.
    cookieValue ? verifyViaApi(`${SESSION_COOKIE}=${cookieValue}`, base) : Promise.resolve(null),
  ]);

  const displayName =
    profile?.name?.trim() || profile?.username?.trim() || null;

  return {
    hoursPending: hoursResult.entries,
    hoursRejected: hoursRejectedResult.entries,
    hoursMissing: hoursMissingResult.missing,
    jobs: jobsResult.jobs,
    observations: obsResult.observations,
    materialRequests: mrResult.requests,
    todayPulse: todayPulseResult.pulse,
    expensesSubmitted: expensesResult.count,
    displayName,
    hoursError: hoursResult.error,
    hoursRejectedError: hoursRejectedResult.error,
    hoursMissingError: hoursMissingResult.error,
    jobsError: jobsResult.error,
    observationsError: obsResult.error,
    materialRequestsError: mrResult.error,
    todayPulseError: todayPulseResult.error,
  };
}

/**
 * #185 — today's live hours pulse for the Today strip. No `date` param on
 * purpose: api/today-pulse.js defaults to ITS Sydney day (sydneyToday()),
 * the same boundary the /hours closeout reads — we never recompute the day
 * client-side. It is the heaviest snapshot source (jobs.json + users/ blob
 * list + per-active-job reads), which is exactly why it joins the same
 * Promise.all and degrades to its own error chip instead of blocking queues.
 */
async function loadTodayPulse(
  base: string,
  headersInit: { cookie: string } | undefined
): Promise<{ pulse: TodayPulseResponse | null; error: string | null }> {
  try {
    const res = await fetch(`${base}/api/today-pulse`, {
      cache: "no-store",
      headers: headersInit,
    });
    if (!res.ok) {
      return { pulse: null, error: `Today pulse API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = TodayPulseResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { pulse: null, error: "Unexpected today pulse response shape" };
    }
    return { pulse: parsed.data, error: null };
  } catch (err) {
    return {
      pulse: null,
      error: err instanceof Error ? err.message : "Today pulse network error",
    };
  }
}

async function loadHoursOverview(
  base: string,
  headersInit: { cookie: string } | undefined,
  fromDate: string,
  toDate: string
): Promise<{ missing: ReadonlyArray<MissingLog>; error: string | null }> {
  try {
    const res = await fetch(
      `${base}/api/time-entries-overview?fromDate=${fromDate}&toDate=${toDate}`,
      { cache: "no-store", headers: headersInit }
    );
    if (!res.ok) {
      return { missing: [], error: `Hours overview API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = TimeEntryOverviewResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { missing: [], error: "Unexpected hours overview response shape" };
    }
    return { missing: parsed.data.missing, error: null };
  } catch (err) {
    return {
      missing: [],
      error: err instanceof Error ? err.message : "Hours overview network error",
    };
  }
}

/**
 * Submitted expense claims awaiting review — the count for the mobile "to
 * approve" pulse + the Approvals strip. Best-effort: a failure degrades to 0
 * (the strip just shows fewer items) rather than blocking the page.
 */
async function loadExpensesSubmitted(
  base: string,
  headersInit: { cookie: string } | undefined
): Promise<{ count: number; error: string | null }> {
  try {
    const res = await fetch(`${base}/api/expenses?status=submitted`, {
      cache: "no-store",
      headers: headersInit,
    });
    if (!res.ok) return { count: 0, error: `Expenses API returned ${res.status}` };
    const parsed = ExpenseListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { count: 0, error: "Unexpected expenses response shape" };
    return { count: parsed.data.expenses.length, error: null };
  } catch (err) {
    return { count: 0, error: err instanceof Error ? err.message : "Expenses network error" };
  }
}

async function loadMaterialRequests(
  base: string,
  headersInit: { cookie: string } | undefined
): Promise<{
  requests: ReadonlyArray<MaterialRequestItem>;
  error: string | null;
}> {
  try {
    const res = await fetch(`${base}/api/material-requests`, {
      cache: "no-store",
      headers: headersInit,
    });
    if (!res.ok) {
      return {
        requests: [],
        error: `Material requests API returned ${res.status}`,
      };
    }
    const body = await res.json();
    const parsed = MaterialRequestListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        requests: [],
        error: "Unexpected material requests response shape",
      };
    }
    return { requests: parsed.data.requests, error: null };
  } catch (err) {
    return {
      requests: [],
      error:
        err instanceof Error ? err.message : "Material requests network error",
    };
  }
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

async function loadHoursByStatus(
  base: string,
  headersInit: { cookie: string } | undefined,
  status: "submitted" | "rejected"
): Promise<{ entries: ReadonlyArray<TimeEntry>; error: string | null }> {
  try {
    const res = await fetch(
      `${base}/api/time-entries?scope=approver&status=${status}`,
      { cache: "no-store", headers: headersInit }
    );
    if (!res.ok) {
      return { entries: [], error: `Hours API returned ${res.status} (${status})` };
    }
    const body = await res.json();
    const parsed = TimeEntryListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { entries: [], error: `Unexpected hours response shape (${status})` };
    }
    return { entries: parsed.data.entries, error: null };
  } catch (err) {
    return {
      entries: [],
      error: err instanceof Error ? err.message : `Hours network error (${status})`,
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
