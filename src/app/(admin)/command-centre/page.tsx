import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  Briefcase,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  FileCheck2,
  Inbox,
  Layers,
  Package,
  RotateCcw,
  UserX,
  type LucideIcon,
} from "lucide-react";
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
import { buildBoard, type BoardIcon, type OpenWorkInput } from "@/domains/command-centre/board";
import { NeedsNowCards } from "@/components/admin/NeedsNowCards";
import { summariseItpReviewQueue } from "./itp-queue-card";

export const dynamic = "force-dynamic";

/**
 * The board's icon-name vocabulary → lucide components. Mirrors NeedsNowCards'
 * SOURCE_ICON so the pulse tiles, open-work heatmap and "needs you now" cards
 * speak one icon language. board.ts stays React-free and names icons by string;
 * this is the single place those names resolve to components.
 */
const BOARD_ICON: Record<BoardIcon, LucideIcon> = {
  "clipboard-check": ClipboardCheck,
  briefcase: Briefcase,
  camera: Camera,
  "alert-octagon": AlertOctagon,
  "file-check": FileCheck2,
  inbox: Inbox,
  "rotate-ccw": RotateCcw,
  "user-x": UserX,
  layers: Layers,
  package: Package,
};

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

  // #503 — Proof to sign off (mobile-admin redesign, flagged admin-tier). When
  // on, the cross-job submitted-proof queue is scanned server-side and shown as
  // a Command Centre surface; dark (zero render, zero scan) when off. Kicked off
  // BEFORE the snapshot await so the scan overlaps the other fetches.
  const showProofReview = await isFlagEnabled("admin_proof_review", session);
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

  const itpReview = summariseItpReviewQueue(jobs);

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
  // only, past days only, LH-scoped). The card count is the number of *people*
  // who owe hours; the subtitle is the age of the oldest unlogged day.
  const missingSummary = summariseMissing(hoursMissing);
  const missingHoursCount = missingSummary.workerCount;

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

  // ── §2 board view-model — the desktop Command Centre's four glance zones,
  //    projected from the SAME already-loaded, permission-gated signals (no new
  //    fetch). Proof-to-sign-off keeps its own dedicated section above, so it is
  //    not double-counted here. ──
  const openWork: OpenWorkInput[] = [
    { key: "hours", label: "Hours pending approval", count: hoursPending.length, href: "/hours/approvals", icon: "clipboard-check" },
    { key: "evidence", label: "Evidence to review", count: evidencePending, href: "/v2/jobs", icon: "camera" },
    { key: "snags", label: "Snags needing attention", count: snagsActive, href: "/v2/jobs", icon: "alert-octagon" },
    { key: "itp", label: "ITPs needing sign-off", count: itpReview.count, href: itpReview.href, icon: "file-check" },
    { key: "observations", label: "Observations to action", count: obsCount, href: "/observations", icon: "inbox" },
    { key: "rejected", label: "Rejected hours", count: rejectedHoursCount, href: "/hours/approvals", icon: "rotate-ccw" },
    { key: "missing", label: "Missing hours", count: missingHoursCount, href: "/hours", icon: "user-x" },
    { key: "plan", label: "Plan mismatches", count: planMismatchCount, href: "/observations", icon: "layers" },
    { key: "materials", label: "Material requests", count: materialRequestCount, href: "/material-requests", icon: "package" },
  ];
  const board = buildBoard({
    crewOnSite: todayStrip ? todayStrip.crewCount : null,
    // Field-staff roster (leading hands + tradies) from /api/admin-stats; null
    // when that fetch failed → buildBoard renders a plain count (honest, P7).
    rosterTotal,
    loggedHoursLabel: todayStrip ? todayStrip.loggedHoursLabel : null,
    pendingApprovals: hoursPending.length,
    jobsLiveToday: todayPulse ? todayPulse.jobs.jobsWithActivityToday : null,
    exceptions,
    openWork,
  });
  const heatClasses: Record<"red" | "amber" | "calm", string> = {
    red: "border-rose-200 bg-rose-50 text-rose-900 hover:border-rose-400",
    amber: "border-amber-200 bg-amber-50 text-amber-900 hover:border-amber-400",
    calm: "border-border bg-surface-raised text-text hover:border-brand-navy",
  };
  const heroClasses: Record<"critical" | "busy" | "calm", string> = {
    critical: "border-rose-200 bg-rose-50",
    busy: "border-amber-200 bg-amber-50",
    calm: "border-emerald-200 bg-emerald-50",
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
          exceptions={exceptions}
          anySourceError={mobileAnySourceError}
          errorMessage={
            hoursError ??
            hoursRejectedError ??
            jobsError ??
            observationsError ??
            materialRequestsError ??
            expensesError
          }
          allClear={mobileAllClear}
        />
      </div>
      {/* Desktop home — unchanged, hidden on phones (the mobile view above). */}
      <div className="mx-auto hidden max-w-5xl space-y-6 md:block">
        {/* Page head (mockup): the title sits in AdminTopbar; here we add its
            dateline subline + the "Owner numbers →" jump to the reports surface
            (the analytics board lives there, deliberately off the morning view). */}
        <div className="flex items-center justify-between gap-4">
          <p className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
            {deskDatetime}
          </p>
          <Link
            href={"/reports" as Route}
            className="inline-flex shrink-0 items-center gap-1 rounded-pill border border-border px-3 py-1.5 font-display text-sm font-medium text-brand-navy transition-colors hover:border-brand-navy focus:outline-none focus:ring-2 focus:ring-brand-navy"
          >
            Owner numbers
            <ArrowRight aria-hidden="true" className="h-4 w-4" />
          </Link>
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
        {/* §2 — state-of-play hero: one calm sentence + a glance tag. */}
        <section aria-label="State of play">
          <div
            className={cn(
              "flex items-center gap-4 rounded-card border p-5",
              heroClasses[board.hero.tone],
            )}
          >
            <span
              className={cn(
                "shrink-0",
                board.hero.tone === "critical"
                  ? "text-state-danger"
                  : board.hero.tone === "busy"
                    ? "text-state-warning"
                    : "text-state-success",
              )}
            >
              {board.hero.tone === "critical" ? (
                <AlertOctagon aria-hidden="true" className="h-6 w-6" />
              ) : board.hero.tone === "busy" ? (
                <AlertTriangle aria-hidden="true" className="h-6 w-6" />
              ) : (
                <CheckCircle2 aria-hidden="true" className="h-6 w-6" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
                State of play
              </p>
              <p className="mt-0.5 font-display text-lg font-semibold text-text">
                {board.hero.headline}
              </p>
            </div>
            <span className="shrink-0 rounded-pill border border-current px-2.5 py-0.5 font-mono text-[11px] font-semibold tracking-wider text-text-muted">
              {board.hero.tag}
            </span>
          </div>
        </section>

        {/* §2 — pulse: four tiles. Unloaded signals read "—", never a fake 0.
            On-the-clock renders an SVG donut ring (crew / roster) when a real
            roster denominator loaded; otherwise a plain number. Approvals + jobs
            lead with an icon (clipboard-check / briefcase). */}
        <section aria-label="Today at a glance">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {board.pulse.map((tile) => {
              const TileIcon = tile.icon ? BOARD_ICON[tile.icon] : null;
              return (
                <div
                  key={tile.key}
                  className={cn(
                    "flex flex-col items-center gap-2 rounded-card border p-4 text-center",
                    tile.amber
                      ? "border-amber-200 bg-amber-50"
                      : "border-border bg-surface-raised",
                  )}
                >
                  {tile.ringPct != null ? (
                    // SVG donut — strokeDasharray is an SVG attribute (NOT the
                    // banned inline `style`); pathLength=100 lets the dash be a
                    // literal percentage. Navy arc over a muted track ring.
                    <span className="relative inline-flex h-16 w-16 items-center justify-center">
                      <svg
                        viewBox="0 0 36 36"
                        className="h-16 w-16 -rotate-90"
                        aria-hidden="true"
                      >
                        <circle
                          cx="18"
                          cy="18"
                          r="15.5"
                          fill="none"
                          className="stroke-border"
                          strokeWidth="3.5"
                        />
                        <circle
                          cx="18"
                          cy="18"
                          r="15.5"
                          fill="none"
                          className="stroke-brand-navy"
                          strokeWidth="3.5"
                          strokeLinecap="round"
                          pathLength={100}
                          strokeDasharray={`${tile.ringPct} 100`}
                        />
                      </svg>
                      <span className="absolute font-display text-base font-semibold tabular-nums text-text">
                        {tile.value}
                        {tile.denom ? (
                          <span className="text-[11px] font-normal text-text-muted">
                            {tile.denom}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  ) : (
                    <div
                      className={cn(
                        "inline-flex items-center gap-1.5 font-display text-2xl font-semibold tabular-nums",
                        tile.amber ? "text-state-warning" : "text-text",
                      )}
                    >
                      {TileIcon ? (
                        <TileIcon aria-hidden="true" className="h-[18px] w-[18px] text-text-muted" />
                      ) : null}
                      <span>
                        {tile.value}
                        {tile.denom ? (
                          <span className="text-base font-normal text-text-muted">
                            {tile.denom}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  )}
                  <div className="text-xs text-text-muted">{tile.label}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Honest degradation: a failed source means the board may undercount. */}
        {anySourceError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load every signal</CardTitle>
            <CardDescription className="text-amber-900">
              {hoursError ??
                hoursRejectedError ??
                hoursMissingError ??
                jobsError ??
                observationsError ??
                materialRequestsError}
              . The board may be incomplete.
            </CardDescription>
            <div className="mt-3">
              <RefreshButton />
            </div>
          </Card>
        ) : null}

        {/* §2 — needs you now: the criticals as ≤4 action cards (+N more). */}
        <section aria-label="Needs you now">
          <h2 className="font-display text-sm uppercase tracking-wider text-text-muted">
            Needs you now
            {board.needsNow.total > 0 ? (
              <span className="ml-2 rounded-pill bg-brand-navy px-2 py-0.5 font-mono text-xs text-text-inverse">
                {board.needsNow.total}
              </span>
            ) : null}
          </h2>
          {board.needsNow.total === 0 ? (
            <Card className="mt-3 border-emerald-200 bg-emerald-50" role="status">
              <CardTitle className="text-emerald-900">All clear</CardTitle>
              <CardDescription className="text-emerald-900">
                Nothing is holding a crew up right now. New items land here as
                they come in.
              </CardDescription>
            </Card>
          ) : (
            <NeedsNowCards items={board.needsNow.items} cap={board.needsNow.cap} />
          )}
        </section>

        {/* §2 — open work: colour-graded heatmap of the live loops. */}
        <section aria-label="Open work">
          <h2 className="font-display text-sm uppercase tracking-wider text-text-muted">
            Open work
            {board.openWork.total > 0 ? (
              <span className="ml-2 rounded-pill bg-surface-subtle px-2 py-0.5 font-mono text-xs text-text-muted">
                {board.openWork.total}
              </span>
            ) : null}
          </h2>
          {board.openWork.tiles.length === 0 ? (
            <Card className="mt-3 border-border bg-surface-raised" role="status">
              <CardTitle>No open work</CardTitle>
              <CardDescription>
                New submissions land here as they come in.
              </CardDescription>
            </Card>
          ) : (
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {board.openWork.tiles.map((tile) => {
                const TileIcon = tile.icon ? BOARD_ICON[tile.icon] : null;
                return (
                  <Link
                    key={tile.key}
                    href={tile.href as Route}
                    aria-label={`${tile.label}: ${tile.count}`}
                    className={cn(
                      "relative block rounded-card border p-4 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-navy",
                      heatClasses[tile.heat],
                    )}
                  >
                    {TileIcon ? (
                      // Corner icon, recoloured by heat (red/amber/calm) — the
                      // text colour already carries the heat tint via heatClasses.
                      <TileIcon
                        aria-hidden="true"
                        className={cn(
                          "absolute right-3 top-3 h-[18px] w-[18px]",
                          tile.heat === "calm" ? "text-text-muted" : "opacity-80",
                        )}
                      />
                    ) : null}
                    <div className="font-display text-2xl font-semibold tabular-nums">
                      {tile.count}
                    </div>
                    <div className="mt-1 text-xs">{tile.label}</div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <PushNotificationsCard audience="admin" />
        </section>
      </div>
    </AdminShell>
  );
}

async function loadSnapshot(cookieValue: string | undefined): Promise<{
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
    loadObservations(base, headersInit),
    loadMaterialRequests(base, headersInit),
    loadTodayPulse(base, headersInit),
    loadExpensesSubmitted(base, headersInit),
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
