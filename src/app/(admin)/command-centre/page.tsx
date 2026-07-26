import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { ArrowRight, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { AdminShell } from "@/components/admin/AdminShell";
import { PushNotificationsCard } from "@/components/pwa/PushNotificationsCard";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
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
import { runRfiScan, blobRfiScanDeps } from "@/server/rfi/overdue-rfis";
import { loadServiceM8SyncReport } from "@/server/servicem8/report";
import { canAccessSurface } from "@/lib/auth/permissions";
import {
  TimeEntryListResponseSchema,
  TimeEntryOverviewResponseSchema,
  TodayPulseResponseSchema,
} from "@/domains/timesheets/schema";
import { summariseTodayStrip } from "@/domains/timesheets/today-strip";
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
import { buildExceptions, decorateAges } from "@/domains/exceptions/service";
import {
  buildNeedsYouQueue,
  buildRightNow,
  summaryHeadline,
  type NeedsYouTone,
} from "@/domains/command-centre/needs-you";
import { summariseItpReviewQueue } from "./itp-queue-card";

export const dynamic = "force-dynamic";

/**
 * /command-centre — BuhlOS admin home.
 *
 * Lean-reset desktop layout (design: BuhlOS replica, command-centre frame):
 * a one-line summary sentence ("2 things are holding up pay this week…"),
 * the "Needs you — what blocks pay, first" row queue, then the "Right now"
 * big-number strip. No KPI cards, no charts — those land with the reports
 * phase. The home always answers "what needs my attention first?" rather
 * than "what happened this week?"
 *
 * Queue sources (real data only — no fake metrics):
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
 *   - RFIs overdue (#276 chase, flag-gated `rfi_register`) — cross-job scan of
 *     jobs/<id>/rfis.json over the snapshot's live jobs; dark = zero reads
 *
 * Lean reset (2026-07): the observations / plan-mismatch / material-request /
 * expenses / snags / ITP queues and the reports link are flag-gated dark by
 * default (docs/product/02-lean-reset.md). A dark source is never fetched and
 * leaves NO trace here — no tile, no count, no label, no error chip.
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

  // Feature gates — resolved once, up front, in one batch:
  //  - #503 proof review (admin-tier): when on, the cross-job submitted-proof
  //    queue is scanned server-side (kicked off right below, BEFORE the
  //    snapshot await, so the scan overlaps the other fetches); dark = zero
  //    render, zero scan.
  //  - #276 RFI register: dark flag does ZERO extra reads (the scan below
  //    never runs) and renders no RFI tile at all.
  //  - Lean reset (2026-07): observations / material requests / expenses /
  //    snags / ITPs / reports are dark launch-gates now. A dark source is
  //    never fetched, derives nothing, renders no tile, count, link or error
  //    chip — a hidden feature leaves NO trace on this home.
  const [
    showProofReview,
    rfiEnabled,
    obsEnabled,
    matEnabled,
    expEnabled,
    snagsEnabled,
    itpEnabled,
    reportsEnabled,
    sm8Enabled,
  ] = await Promise.all([
    isFlagEnabled("admin_proof_review", session),
    isFlagEnabled("rfi_register", session),
    isFlagEnabled("observations_inbox", session),
    isFlagEnabled("material_requests", session),
    isFlagEnabled("expenses", session),
    isFlagEnabled("snags", session),
    isFlagEnabled("itp", session),
    isFlagEnabled("reports", session),
    isFlagEnabled("servicem8_sync", session),
  ]);
  const proofPromise = showProofReview
    ? runProofQueue(blobProofQueueDeps())
    : Promise.resolve(null);

  const {
    hoursPending,
    hoursRejected,
    hoursMissing,
    jobs,
    observations,
    materialRequests,
    todayPulse,
    rosterTotal,
    expensesSubmitted,
    expensesError,
    displayName,
    hoursError,
    hoursRejectedError,
    hoursMissingError,
    jobsError,
    observationsError,
    materialRequestsError,
    todayPulseError,
  } = await loadSnapshot(raw, {
    observations: obsEnabled,
    materialRequests: matEnabled,
    expenses: expEnabled,
  });

  // #185 Today strip — pure derivation from the pulse payload. Null model
  // (failed fetch) renders the strip's own error chip; the queues are
  // untouched either way.
  const todayStrip = summariseTodayStrip(todayPulse);

  const evidencePending = jobs.reduce(
    (sum, j) => sum + (j.statsEvidenceV2Pending ?? 0),
    0
  );
  // Belt-and-braces (lean reset): the live job stats STILL carry snag/ITP
  // counts while those features are dark — zero the derivations at the source
  // so a hidden feature can't resurface through the jobs list.
  const snagsActive = snagsEnabled
    ? jobs.reduce((sum, j) => sum + (j.statsSnagsV2Active ?? 0), 0)
    : 0;

  const itpReview = itpEnabled
    ? summariseItpReviewQueue(jobs)
    : { count: 0, jobsAffected: 0, href: "/v2/jobs" };

  // #155 pilot: the flags readout is itself flag-gated + admin-tier targeted
  // — dark for everyone (incl. this page) until FLAG_ADMIN_FLAGS_READOUT or
  // the flags.json override turns it on, and never rendered to non-admin
  // tiers even then. The first consumer of the flag system is the flag
  // system's own ops surface.
  // Resolve the proof scan kicked off above. Surface BOTH failure signals
  // honestly (P7): a total failure (ok:false) → an error card; a partial
  // failure (failedJobs) → a "couldn't read N jobs" notice — never a false
  // all-clear or an undercount presented as the total.
  const proofRes = await proofPromise;
  const proofItems: ProofQueueItem[] = proofRes && proofRes.ok ? proofRes.items : [];
  const proofError: string | null = proofRes && !proofRes.ok ? proofRes.error : null;
  const proofFailedJobs: number = proofRes && proofRes.ok ? proofRes.failedJobs.length : 0;

  // ServiceM8 daily-sync report (dark flag ⇒ zero reads, zero render). The
  // cron (api/internal/sync-checks/servicem8) writes the snapshot; this page
  // only reads the blob — it never talks to ServiceM8.
  const sm8Report = sm8Enabled ? await loadServiceM8SyncReport() : null;

  const showFlagsReadout = await isFlagEnabled("admin_flags_readout", session);
  const flagStates = showFlagsReadout
    ? await Promise.all(
        listFlags().map(async (f) => ({ key: f.key, on: await isFlagOn(f.key), target: f.target }))
      )
    : [];

  // Open observations flagged as needing office action (the field-to-office
  // loop's "what came in from site" queue).
  const obsNeedingAction = observations.filter(
    (o) => isOpenObservation(o.status) && o.requiresAction
  );
  const obsCount = obsNeedingAction.length;

  // PR 7: real exception sub-queue derived from the same observations fetch
  // (no extra round-trip). Plan mismatches are the observation type the owner
  // most often actions personally — the inbox already filters them, but the
  // count belongs on the morning view too.
  const obsPlanMismatch = obsNeedingAction.filter((o) => o.type === "plan_mismatch");
  const planMismatchCount = obsPlanMismatch.length;

  // PR 11: the Material requests queue is now real — count open ones
  // (status='requested' or 'approved' = "office action needed before
  // procurement places the order"). Observations of type='material_request'
  // that haven't yet been converted still surface in the main Observations
  // card; this card represents the procurement-side queue only.
  const openMaterialRequests = materialRequests.filter((m) =>
    isOpenRequest(m.status)
  );
  const materialRequestCount = openMaterialRequests.length;

  // PR 7: rejected hours that the worker hasn't yet re-submitted. Real data
  // from /api/time-entries?scope=approver&status=rejected; the boss sees the
  // count so they can nudge the worker (or correct the rejection).
  const rejectedHoursCount = hoursRejected.length;

  // Missing hours: assigned crew with no entry on a past weekday in the
  // rolling window (server-computed in /api/time-entries-overview — weekdays
  // only, past days only, LH-scoped). The queue row counts worker-DAYS never
  // logged (`total`) — the design's "past days never logged".
  const missingSummary = summariseMissing(hoursMissing);

  // #276 chase — overdue RFIs across live jobs. The register store is per-job
  // (jobs/<id>/rfis.json, no cross-job index), so this is the one snapshot
  // source needing a real fan-out: BOUNDED to the snapshot's live jobs (the
  // list already fetched above — no second jobs read), all in parallel, and
  // only when the `rfi_register` flag is on (off ⇒ zero extra reads). It runs
  // after the snapshot because it needs that job list; the day is judged in
  // the business timezone, same boundary the hours surfaces use.
  const rfiScan = rfiEnabled ? await runRfiScan(jobs, blobRfiScanDeps()) : null;
  const rfiToday = localDateString(new Date(), BUSINESS_TIMEZONE);
  const rfiError =
    rfiScan && rfiScan.failedJobs.length > 0
      ? `${rfiScan.failedJobs.length} job${rfiScan.failedJobs.length === 1 ? "’s" : "s’"} RFIs couldn’t be read`
      : null;

  // Itemised "Needs attention" projection over the SAME already-loaded,
  // admin-gated sources the count cards use — no new fetch, no new store.
  const exceptions = decorateAges(
    buildExceptions({
      hoursPending,
      hoursRejected,
      jobs,
      observations,
      materialRequests,
      // Flag off / scan skipped → the optional source is simply absent.
      ...(rfiScan ? { rfis: rfiScan.rfis, today: rfiToday } : {}),
    }).filter(
      // Lean reset: jobExceptions derives per-JOB snag/ITP items from the same
      // job stats gated above — drop those kinds while their feature is dark.
      // Observation/material items need no filter here: their sources were
      // skipped in loadSnapshot, so the arrays are already empty.
      (e) =>
        (snagsEnabled || e.source !== "snag") &&
        (itpEnabled || e.source !== "itp"),
    ),
    Date.now(),
  );
  const anySourceError =
    !!(hoursError ||
      hoursRejectedError ||
      jobsError ||
      observationsError ||
      materialRequestsError ||
      rfiError);
  // The mobile home also reads expenses (the "to approve" count) — fold its
  // error in so a failed expenses fetch shows the mobile "couldn't load every
  // queue" card and blocks all-clear (no fabricated 0). Desktop is unchanged
  // (it has no expenses queue card, so its anySourceError stays as-is).
  const mobileAnySourceError = anySourceError || !!expensesError;

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
  // Desktop header subline (mockup PageHead): "{weekday} {date} · {time}" in the
  // business timezone. Rendered once server-side (the page is force-dynamic), so
  // it's the time the desk opened the page — not a live clock (no fake ticking).
  const deskDatetime = new Date().toLocaleString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "numeric",
    minute: "2-digit",
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
    !proofError &&
    proofFailedJobs === 0 &&
    hoursPending.length === 0 &&
    !mobileAnySourceError &&
    !todayPulseError;

  // ── Lean-reset desktop view-model (design: replica command-centre frame) —
  //    the summary sentence, the "Needs you" queue and the "Right now" strip,
  //    projected from the SAME already-loaded, permission-gated signals (no
  //    new fetch). Proof-to-sign-off keeps its own dedicated section above, so
  //    it is not double-counted here. ──
  // The sentence only speaks for sources that LOADED: a failed source passes
  // null and its clause is omitted (never counted as 0); total failure renders
  // no sentence at all — the degradation card below discloses it.
  const headline = summaryHeadline({
    rejected: hoursRejectedError ? null : rejectedHoursCount,
    missingDays: hoursMissingError ? null : missingSummary.total,
    pending: hoursError ? null : hoursPending.length,
  });
  // Active-but-no-crew criticals from the SAME exceptions projection the
  // mobile home ranks (source "job" emits critical only for no-crew; draft
  // jobs are info) — one judgement, one number.
  const noCrewJobs = exceptions.filter(
    (e) => e.source === "job" && e.severity === "critical",
  ).length;
  // Lean reset: a dark feature's loop is OMITTED from the queue input — not a
  // zero row, no entry at all (zero counts drop anyway; omission keeps even
  // the label/href out of the view-model, matching "no trace").
  const needsYou = buildNeedsYouQueue({
    rejected: rejectedHoursCount,
    missingDays: missingSummary.total,
    noCrewJobs,
    pending: hoursPending.length,
    evidence: evidencePending,
    ...(itpEnabled ? { itp: { count: itpReview.count, href: itpReview.href } } : {}),
    ...(obsEnabled ? { observations: obsCount, planMismatches: planMismatchCount } : {}),
    ...(matEnabled ? { materials: materialRequestCount } : {}),
    // #276 chase — overdue RFIs across live jobs, counted from the SAME
    // exceptions projection (one judgement of "overdue", one number). No
    // cross-job RFI surface exists, so the row links to the jobs list; no row
    // when the flag is off.
    ...(rfiScan
      ? { rfisOverdue: exceptions.filter((e) => e.source === "rfi").length }
      : {}),
    ...(snagsEnabled ? { snags: snagsActive } : {}),
  });
  const rightNow = buildRightNow({
    crewOnSite: todayStrip ? todayStrip.crewCount : null,
    // Field-staff roster (leading hands + tradies) from /api/admin-stats; null
    // when that fetch failed → a plain count, no fabricated denominator (P7).
    rosterTotal,
    loggedHoursLabel: todayStrip ? todayStrip.loggedHoursLabel : null,
    jobsLiveToday: todayPulse ? todayPulse.jobs.jobsWithActivityToday : null,
  });
  // Row accents (design: red/amber/neutral left border + tinted count numeral).
  const toneAccent: Record<NeedsYouTone, string> = {
    block: "border-l-state-danger",
    wait: "border-l-state-warning",
    calm: "border-l-border-strong",
  };
  const toneCount: Record<NeedsYouTone, string> = {
    block: "text-state-danger-subtle-text",
    wait: "text-state-warning-subtle-text",
    calm: "text-text",
  };

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
          {proofError ? (
            // Total scan failure — never render a degraded read as "Queue clear".
            <Card className="mt-2 border-amber-200 bg-amber-50" role="alert">
              <CardTitle>Couldn&rsquo;t load proof to sign off</CardTitle>
              <CardDescription className="text-amber-900">{proofError}.</CardDescription>
              <div className="mt-3">
                <RefreshButton />
              </div>
            </Card>
          ) : (
            <>
              <p className="mb-3 mt-1 text-sm text-text-muted">
                {proofItems.length > 0
                  ? `${proofItems.length} task${proofItems.length === 1 ? "" : "s"} with site photos waiting on you.`
                  : "Site photos a worker captured against required evidence land here for sign-off."}
                {proofFailedJobs > 0
                  ? ` ${proofFailedJobs} job${proofFailedJobs === 1 ? "" : "s"}’ proof couldn’t be read and ${proofFailedJobs === 1 ? "isn’t" : "aren’t"} counted.`
                  : ""}
              </p>
              {/* Key on the review ids + revisions so a router.refresh() after a
                  stale-revision conflict remounts the client with the fresh list
                  + revisions (the client list is seeded from initialItems). */}
              <ProofReviewQueue
                key={proofItems.map((i) => `${i.reviewId}:${i.jobControlRevision}`).join(",") || "empty"}
                initialItems={proofItems}
              />
            </>
          )}
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
          jobsWithActivityToday={todayPulse ? todayPulse.jobs.jobsWithActivityToday : null}
          pendingHours={hoursPending.length}
          approvals={mobileApprovals}
          approvalsEnabled={{ expenses: expEnabled, itps: itpEnabled, materials: matEnabled }}
          exceptions={exceptions}
          anySourceError={mobileAnySourceError}
          errorMessage={
            hoursError ??
            hoursRejectedError ??
            jobsError ??
            observationsError ??
            materialRequestsError ??
            rfiError ??
            expensesError
          }
          allClear={mobileAllClear}
        />
      </div>
      {/* Desktop home — unchanged, hidden on phones (the mobile view above). */}
      <div className="mx-auto hidden max-w-5xl space-y-6 md:block">
        {/* Page head (mockup): the title sits in AdminTopbar; here we add its
            dateline subline + the "Owner numbers →" jump to the reports surface
            (the analytics board lives there, deliberately off the morning view).
            Flag-gated on `reports` (lean reset — /reports 404s while dark); the
            link returns when the owner re-enables the feature. */}
        <div className="flex items-center justify-between gap-4">
          <p className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
            {deskDatetime}
          </p>
          {reportsEnabled ? (
            <Link
              href={"/reports" as Route}
              className="inline-flex shrink-0 items-center gap-1 rounded-pill border border-border px-3 py-1.5 font-display text-sm font-medium text-brand-navy transition-colors hover:border-brand-navy focus:outline-none focus:ring-2 focus:ring-brand-navy"
            >
              Owner numbers
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          ) : null}
        </div>
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
        {/* One-line summary sentence (design): what blocks pay + what waits on
            you, derived from real counts only — a failed source drops its
            clause; total failure renders no sentence (the card below owns it). */}
        {headline ? (
          <p className="max-w-[56ch] font-display text-[17px] font-medium leading-snug text-text">
            {headline}
          </p>
        ) : null}

        {/* Honest degradation: a failed source means the queue may undercount. */}
        {anySourceError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load every signal</CardTitle>
            <CardDescription className="text-amber-900">
              {hoursError ??
                hoursRejectedError ??
                hoursMissingError ??
                jobsError ??
                observationsError ??
                materialRequestsError ??
                rfiError}
              . The queue below may be incomplete.
            </CardDescription>
            <div className="mt-3">
              <RefreshButton />
            </div>
          </Card>
        ) : null}

        {/* "Needs you — what blocks pay, first" (design): a single vertical
            list of rows — accent left border, big count numeral, title + one-
            line explainer, right-aligned mono destination + chevron. Rows come
            from buildNeedsYouQueue (zero counts drop; dark loops leave no
            trace). */}
        <section aria-label="Needs you">
          <div className="flex items-baseline gap-3">
            <h2 className="font-display text-[13px] font-semibold uppercase tracking-wider text-text-muted">
              Needs you
            </h2>
            <span className="font-mono text-[11px] tracking-wide text-text-muted">
              what blocks pay, first
            </span>
          </div>
          {needsYou.length === 0 ? (
            <Card
              className="mt-3 border-state-success-subtle-border bg-state-success-subtle-bg"
              role="status"
            >
              <CardTitle className="text-state-success-subtle-text">All clear</CardTitle>
              <CardDescription className="text-state-success-subtle-text">
                Nothing is holding up pay or waiting on you. New items land here
                as they come in.
              </CardDescription>
            </Card>
          ) : (
            <div className="mt-3 flex flex-col overflow-hidden rounded-card border border-border bg-surface-raised shadow-card">
              {needsYou.map((row, i) => (
                <Link
                  key={row.key}
                  href={row.href as Route}
                  aria-label={`${row.title}: ${row.count}`}
                  className={cn(
                    "grid w-full grid-cols-[52px_1fr_auto] items-center gap-4 border-l-[3px] px-5 py-5 text-left transition-colors hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-navy",
                    i > 0 ? "border-t border-t-border" : "",
                    toneAccent[row.tone],
                  )}
                >
                  <span
                    className={cn(
                      "font-display text-[26px] font-semibold leading-none tabular-nums",
                      toneCount[row.tone],
                    )}
                  >
                    {row.count}
                  </span>
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="font-display text-[15px] font-semibold text-text">
                      {row.title}
                    </span>
                    <span className="text-[13px] leading-snug text-text-muted">
                      {row.sub}
                    </span>
                  </span>
                  <span className="flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px] font-semibold uppercase tracking-wider text-text-muted">
                    {row.cta}
                    <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* "Right now" (design): the live pulse as three big-number tiles
            divided by hairlines — same real signals the old pulse tiles showed;
            unloaded signals read "—", never a fake 0. */}
        <section aria-label="Right now">
          <h2 className="font-display text-[13px] font-semibold uppercase tracking-wider text-text-muted">
            Right now
          </h2>
          <div className="mt-3.5 flex flex-wrap items-stretch gap-y-4">
            {rightNow.map((tile, i) => (
              <div
                key={tile.key}
                className={cn(
                  "flex flex-col gap-1.5 pr-7",
                  i > 0 ? "border-l border-border pl-7" : "",
                )}
              >
                <span className="font-display text-[26px] font-semibold leading-none tabular-nums text-text">
                  {tile.value}
                  {tile.suffix ? (
                    <span className="text-sm font-normal text-text-muted">
                      {tile.suffix}
                    </span>
                  ) : null}
                </span>
                <span className="text-xs text-text-muted">{tile.label}</span>
              </div>
            ))}
          </div>
        </section>

        {/* ServiceM8 daily job sync — flag-gated. The morning answer to "does
            every ServiceM8 work order have a BuhlOS job the crew can log hours
            to?". Auto-created jobs with no assigned workers stay flagged here
            until someone assigns the crew (creation alone doesn't make hours
            loggable). */}
        {sm8Enabled ? (
          <section aria-label="ServiceM8 job sync">
            <h2 className="font-display text-sm uppercase tracking-wider text-text-muted">
              ServiceM8 job sync
            </h2>
            {!sm8Report ? (
              <Card className="mt-3 border-border bg-surface-raised" role="status">
                <CardTitle>No sync has run yet</CardTitle>
                <CardDescription>
                  The daily check runs each morning once SERVICEM8_API_KEY is
                  configured. It compares active ServiceM8 work orders against
                  BuhlOS jobs and creates any that are missing.
                </CardDescription>
              </Card>
            ) : sm8Report.status === "skipped" ? (
              <Card className="mt-3 border-amber-200 bg-amber-50" role="alert">
                <CardTitle>ServiceM8 sync isn&rsquo;t connected</CardTitle>
                <CardDescription className="text-amber-900">
                  {sm8Report.reason ?? "SERVICEM8_API_KEY is not configured"} —
                  jobs booked in ServiceM8 are not being checked against BuhlOS.
                </CardDescription>
              </Card>
            ) : (
              <>
                {sm8Report.status === "error" ? (
                  <Card className="mt-3 border-amber-200 bg-amber-50" role="alert">
                    <CardTitle>Couldn&rsquo;t reach ServiceM8</CardTitle>
                    <CardDescription className="text-amber-900">
                      Last attempt {formatSyncTime(sm8Report.lastRun)} failed
                      {sm8Report.error ? ` — ${sm8Report.error}` : ""}. New
                      ServiceM8 jobs may be missing from BuhlOS until the next
                      successful run.
                    </CardDescription>
                  </Card>
                ) : null}
                {(sm8Report.needsAssignment?.length ?? 0) > 0 ? (
                  <Card className="mt-3 border-amber-200 bg-amber-50" role="alert">
                    <CardTitle className="text-amber-900">
                      {sm8Report.needsAssignment!.length} job
                      {sm8Report.needsAssignment!.length === 1 ? "" : "s"} from
                      ServiceM8 with no crew assigned
                    </CardTitle>
                    <CardDescription className="text-amber-900">
                      These were created from ServiceM8 but nobody can log hours
                      to them until workers are assigned.
                    </CardDescription>
                    <ul className="mt-2 space-y-1">
                      {sm8Report.needsAssignment!.slice(0, 8).map((j) => (
                        <li key={j.id}>
                          <Link
                            href={`/v2/jobs/${j.id}` as Route}
                            className="text-sm font-medium text-amber-900 underline underline-offset-2"
                          >
                            {j.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : null}
                {(sm8Report.created?.length ?? 0) > 0 ? (
                  <Card className="mt-3 border-border bg-surface-raised" role="status">
                    <CardTitle>
                      {sm8Report.created!.length} job
                      {sm8Report.created!.length === 1 ? "" : "s"} created from
                      ServiceM8
                    </CardTitle>
                    <CardDescription>
                      Found in ServiceM8 ({formatSyncTime(sm8Report.lastRun)})
                      without a matching BuhlOS job, so they were created
                      automatically.
                    </CardDescription>
                    <ul className="mt-2 space-y-1">
                      {sm8Report.created!.slice(0, 8).map((j) => (
                        <li key={j.id}>
                          <Link
                            href={`/v2/jobs/${j.id}` as Route}
                            className="text-sm font-medium underline underline-offset-2"
                          >
                            {j.name}
                          </Link>
                          {j.sm8Number ? (
                            <span className="ml-2 font-mono text-xs text-text-muted">
                              SM8 #{j.sm8Number}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : null}
                {(sm8Report.failed?.length ?? 0) > 0 ? (
                  <Card className="mt-3 border-amber-200 bg-amber-50" role="alert">
                    <CardTitle>
                      {sm8Report.failed!.length} ServiceM8 job
                      {sm8Report.failed!.length === 1 ? "" : "s"} couldn&rsquo;t
                      be created
                    </CardTitle>
                    <CardDescription className="text-amber-900">
                      {sm8Report
                        .failed!.slice(0, 3)
                        .map((f) => `${f.name}: ${f.error ?? "unknown error"}`)
                        .join(" · ")}
                    </CardDescription>
                  </Card>
                ) : null}
                {sm8Report.status === "ok" &&
                (sm8Report.created?.length ?? 0) === 0 &&
                (sm8Report.failed?.length ?? 0) === 0 &&
                (sm8Report.needsAssignment?.length ?? 0) === 0 ? (
                  <Card className="mt-3 border-emerald-200 bg-emerald-50" role="status">
                    <CardTitle className="text-emerald-900">
                      All {sm8Report.sm8Count ?? 0} ServiceM8 work orders matched
                    </CardTitle>
                    <CardDescription className="text-emerald-900">
                      Checked {formatSyncTime(sm8Report.lastRun)} — every active
                      ServiceM8 work order has a BuhlOS job.
                    </CardDescription>
                  </Card>
                ) : null}
              </>
            )}
          </section>
        ) : null}

        <section>
          <PushNotificationsCard audience="admin" />
        </section>
      </div>
    </AdminShell>
  );
}

/** "Sat 5:15 am" in the business timezone — the ServiceM8 card's run stamp. */
function formatSyncTime(iso?: string): string {
  if (!iso) return "recently";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "recently";
  return d.toLocaleString("en-AU", {
    timeZone: BUSINESS_TIMEZONE,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

async function loadSnapshot(
  cookieValue: string | undefined,
  /** Lean-reset gates. A dark source is SKIPPED — no fetch at all — and comes
   *  back as empty data + a null error: dark is not failed, so it must never
   *  trip the "couldn't load every signal/queue" chips or block all-clear. */
  enabled: { observations: boolean; materialRequests: boolean; expenses: boolean },
): Promise<{
  hoursPending: ReadonlyArray<TimeEntry>;
  hoursRejected: ReadonlyArray<TimeEntry>;
  hoursMissing: ReadonlyArray<MissingLog>;
  jobs: ReadonlyArray<Job>;
  observations: ReadonlyArray<ObservationItem>;
  materialRequests: ReadonlyArray<MaterialRequestItem>;
  todayPulse: TodayPulseResponse | null;
  /** Field-staff roster (leading hands + tradies) for the on-the-clock ring; null when admin-stats didn't load → plain count. */
  rosterTotal: number | null;
  /** Submitted expense claims awaiting review — the count for the mobile pulse. */
  expensesSubmitted: number;
  /** Non-null when the expenses fetch failed (so the mobile home degrades honestly). */
  expensesError: string | null;
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
    rosterTotal,
    profile,
  ] = await Promise.all([
    loadHoursByStatus(base, headersInit, "submitted"),
    loadHoursByStatus(base, headersInit, "rejected"),
    loadHoursOverview(base, headersInit, missingFrom, missingTo),
    loadJobsWithStats(base, headersInit),
    enabled.observations
      ? loadObservations(base, headersInit)
      : Promise.resolve({ observations: [], error: null }),
    enabled.materialRequests
      ? loadMaterialRequests(base, headersInit)
      : Promise.resolve({ requests: [], error: null }),
    loadTodayPulse(base, headersInit),
    enabled.expenses
      ? loadExpensesSubmitted(base, headersInit)
      : Promise.resolve({ count: 0, error: null }),
    loadRosterTotal(base, headersInit),
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
    rosterTotal,
    expensesSubmitted: expensesResult.count,
    expensesError: expensesResult.error,
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

/**
 * Field-staff roster for the on-the-clock pulse ring — leading hands + tradies
 * from /api/admin-stats (`users.byRole`), the SAME endpoint the sidebar badges
 * read (useNavCounts). Admins/clients are excluded: the ring compares crew on
 * the clock against the people who clock on. Best-effort + honest: any failure
 * or unexpected shape returns null, so buildBoard degrades to a plain count
 * instead of fabricating a denominator (P7). Parsed defensively (no zod schema
 * for this ops endpoint) — a non-numeric/absent role yields null, not 0.
 */
async function loadRosterTotal(
  base: string,
  headersInit: { cookie: string } | undefined
): Promise<number | null> {
  try {
    const res = await fetch(`${base}/api/admin-stats`, {
      cache: "no-store",
      headers: headersInit,
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const root = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
    const users = root && typeof root.users === "object" ? (root.users as Record<string, unknown>) : null;
    const byRole =
      users && typeof users.byRole === "object" ? (users.byRole as Record<string, unknown>) : null;
    if (!byRole) return null;
    const lh = byRole.leadingHand;
    const tr = byRole.tradie;
    // Need at least one real numeric count to claim a roster; otherwise null.
    if (typeof lh !== "number" && typeof tr !== "number") return null;
    const lhN = typeof lh === "number" && Number.isFinite(lh) ? lh : 0;
    const trN = typeof tr === "number" && Number.isFinite(tr) ? tr : 0;
    return lhN + trN;
  } catch {
    return null;
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
    // Perf: the Command Centre aggregates only per-job COUNT stats (crew /
    // evidence-pending / snags-active / ITPs-needs-review) — never task counts —
    // so `statsOnly=1` serves them from the small jobs-summary + per-job stat
    // reads, skipping the ~8s jobs.json monolith. Same counts, no staleness.
    const res = await fetch(`${base}/api/jobs?withStats=1&statsOnly=1`, {
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
