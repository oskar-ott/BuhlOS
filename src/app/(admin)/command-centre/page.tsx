import Link from "next/link";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { AdminShell } from "@/components/admin/AdminShell";
import { PushNotificationsCard } from "@/components/pwa/PushNotificationsCard";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SESSION_COOKIE, decodeSessionCookie, verifyViaApi } from "@/lib/auth/session";
import { isFlagEnabled, listFlags, isFlagOn } from "../../../../api/_lib/feature-flags.js";
import { partOfDayForHour, firstNameFrom, hourInTimeZone } from "@/domains/phil/greeting";
import { MobileToday } from "./MobileToday";
import { loadServiceM8SyncReport } from "@/server/servicem8/report";
import { canAccessSurface } from "@/lib/auth/permissions";
import {
  TimeEntryListResponseSchema,
  TimeEntryOverviewResponseSchema,
  TodayPulseResponseSchema,
} from "@/domains/timesheets/schema";
import { summariseTodayStrip } from "@/domains/timesheets/today-strip";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  BUSINESS_TIMEZONE,
  addDays,
  localDateString,
  summariseMissing,
  weekStartOf,
} from "@/domains/timesheets/service";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import type {
  MissingLog,
  TimeEntry,
  TodayPulseResponse,
} from "@/domains/timesheets/types";
import type { Job } from "@/domains/jobs/types";
import { buildExceptions, decorateAges } from "@/domains/exceptions/service";
import {
  buildNeedsYouQueue,
  buildRightNow,
  summaryHeadline,
  type NeedsYouTone,
} from "@/domains/command-centre/needs-you";

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
 *   - Rejected hours — /api/time-entries?scope=approver&status=rejected (PR 7)
 *   - Missing hours — assigned crew with no entry on a past weekday, from
 *     /api/time-entries-overview (rolling 7-day window, weekdays only)
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

  const sm8Enabled = await isFlagEnabled("servicem8_sync", session);

  const {
    hoursPending,
    hoursRejected,
    hoursMissing,
    weekTotals,
    jobs,
    todayPulse,
    rosterTotal,
    displayName,
    hoursError,
    hoursRejectedError,
    hoursMissingError,
    jobsError,
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

  // #155 pilot: the flags readout is itself flag-gated + admin-tier targeted
  // — dark for everyone (incl. this page) until FLAG_ADMIN_FLAGS_READOUT or
  // the flags.json override turns it on, and never rendered to non-admin
  // tiers even then. The first consumer of the flag system is the flag
  // system's own ops surface.
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

  // PR 7: rejected hours that the worker hasn't yet re-submitted. Real data
  // from /api/time-entries?scope=approver&status=rejected; the boss sees the
  // count so they can nudge the worker (or correct the rejection).
  const rejectedHoursCount = hoursRejected.length;

  // Missing hours: assigned crew with no entry on a past weekday in the
  // rolling window (server-computed in /api/time-entries-overview — weekdays
  // only, past days only, LH-scoped). The queue row counts worker-DAYS never
  // logged (`total`) — the design's "past days never logged".
  const missingSummary = summariseMissing(hoursMissing);

  // Itemised "Needs attention" projection over the SAME already-loaded,
  // admin-gated sources the count cards use — no new fetch, no new store.
  const exceptions = decorateAges(
    buildExceptions({
      hoursPending,
      hoursRejected,
      jobs,
    }),
    Date.now(),
  );
  const anySourceError =
    !!(hoursError ||
      hoursRejectedError ||
      jobsError);

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
  const mobileAllClear =
    exceptions.length === 0 &&
    hoursPending.length === 0 &&
    !anySourceError &&
    !todayPulseError;

  // ── Lean-reset desktop view-model (design: replica command-centre frame) —
  //    the summary sentence, the "Needs you" queue and the "Right now" strip,
  //    projected from the SAME already-loaded, permission-gated signals (no
  //    new fetch). ──
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
  const needsYou = buildNeedsYouQueue({
    rejected: rejectedHoursCount,
    missingDays: missingSummary.total,
    // The chase link lands the weekly board on the week the count covers —
    // the last complete Mon–Sun week (same window loadSnapshot queried).
    missingWeekStart: addDays(weekStartOf(localDateString(new Date(), BUSINESS_TIMEZONE)), -7),
    noCrewJobs,
    pending: hoursPending.length,
    evidence: evidencePending,
  });
  // Weekly-first (owner directive 2026-08-08): the strip counts the CURRENT
  // Mon–Sun week, not today — the crew logs weekly, so today-figures read 0
  // four days out of five and train the office to ignore the strip.
  const rightNow = buildRightNow({
    crewLoggedThisWeek: weekTotals ? weekTotals.workers : null,
    // Field-staff roster (leading hands + tradies) from /api/admin-stats; null
    // when that fetch failed → a plain count, no fabricated denominator (P7).
    rosterTotal,
    weekHoursLabel: weekTotals ? formatHoursLabel(weekTotals.hours) : null,
    jobsThisWeek: weekTotals ? weekTotals.jobs : null,
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
      {/* Mobile home — the calm single-screen "what needs me first?". Desktop
          (the strip + 9-card grid + inbox below) is untouched, hidden < md. */}
      <div className="md:hidden">
        <MobileToday
          greeting={greeting}
          dateLabel={dateLabel}
          todayStrip={todayStrip}
          todayPulseError={todayPulseError}
          jobsWithActivityToday={todayPulse ? todayPulse.jobs.jobsWithActivityToday : null}
          weekWorkersLogged={weekTotals ? weekTotals.workers : null}
          weekHoursLabel={weekTotals ? formatHoursLabel(weekTotals.hours) : null}
          pendingHours={hoursPending.length}
          exceptions={exceptions}
          anySourceError={anySourceError}
          errorMessage={hoursError ?? hoursRejectedError ?? jobsError}
          allClear={mobileAllClear}
        />
      </div>
      {/* Desktop home — unchanged, hidden on phones (the mobile view above). */}
      <div className="mx-auto hidden max-w-5xl space-y-6 md:block">
        {/* Page head (mockup): the title sits in AdminTopbar; here we add its
            dateline subline. */}
        <div className="flex items-center justify-between gap-4">
          <p className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
            {deskDatetime}
          </p>
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
                jobsError}
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
            from buildNeedsYouQueue (zero counts drop). */}
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

        {/* "This week" (weekly-first, owner directive 2026-08-08): the strip
            counts the current Mon–Sun week — workers logged, hours, jobs —
            because the crew logs weekly and today-numbers read 0 most days.
            Unloaded signals read "—", never a fake 0. */}
        <section aria-label="This week">
          <h2 className="font-display text-[13px] font-semibold uppercase tracking-wider text-text-muted">
            This week
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
): Promise<{
  hoursPending: ReadonlyArray<TimeEntry>;
  hoursRejected: ReadonlyArray<TimeEntry>;
  hoursMissing: ReadonlyArray<MissingLog>;
  /** CURRENT Mon–Sun week rollup for the "This week" strip; null = failed. */
  weekTotals: OverviewWeekTotals | null;
  jobs: ReadonlyArray<Job>;
  todayPulse: TodayPulseResponse | null;
  /** Field-staff roster (leading hands + tradies) for the on-the-clock ring; null when admin-stats didn't load → plain count. */
  rosterTotal: number | null;
  /** The admin's display name (cookie has none) — for the mobile greeting. */
  displayName: string | null;
  hoursError: string | null;
  hoursRejectedError: string | null;
  hoursMissingError: string | null;
  weekTotalsError: string | null;
  jobsError: string | null;
  todayPulseError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const headersInit = cookieValue
    ? { cookie: `${SESSION_COOKIE}=${cookieValue}` }
    : undefined;

  // Missing-hours window: the last COMPLETE Mon–Sun week. The crew logs
  // hours weekly — often the whole week at its end (owner directive
  // 2026-08-08) — so the current week's un-logged days are expected, not a
  // chase; the card only counts days from the week that has already closed.
  // The server further restricts to weekdays, past days and the go-live floor.
  const todayISO = localDateString(new Date(), BUSINESS_TIMEZONE);
  const thisMonday = weekStartOf(todayISO);
  const missingFrom = addDays(thisMonday, -7);
  const missingTo = addDays(thisMonday, -1);

  const [
    hoursResult,
    hoursRejectedResult,
    hoursMissingResult,
    weekOverviewResult,
    jobsResult,
    todayPulseResult,
    rosterTotal,
    profile,
  ] = await Promise.all([
    loadHoursByStatus(base, headersInit, "submitted"),
    loadHoursByStatus(base, headersInit, "rejected"),
    loadHoursOverview(base, headersInit, missingFrom, missingTo),
    // The CURRENT Mon–Sun week's rollup — the "This week" strip's three real
    // numbers (workers logged / hours / jobs). Same endpoint, current window.
    loadHoursOverview(base, headersInit, thisMonday, todayISO),
    loadJobsWithStats(base, headersInit),
    loadTodayPulse(base, headersInit),
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
    weekTotals: weekOverviewResult.totals,
    jobs: jobsResult.jobs,
    todayPulse: todayPulseResult.pulse,
    rosterTotal,
    displayName,
    hoursError: hoursResult.error,
    hoursRejectedError: hoursRejectedResult.error,
    hoursMissingError: hoursMissingResult.error,
    weekTotalsError: weekOverviewResult.error,
    jobsError: jobsResult.error,
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

/** Distinct-worker / total-hours / distinct-job rollup for a range — the
 *  "This week" strip's three real numbers. null = the fetch failed. */
interface OverviewWeekTotals {
  workers: number;
  hours: number;
  jobs: number;
}

async function loadHoursOverview(
  base: string,
  headersInit: { cookie: string } | undefined,
  fromDate: string,
  toDate: string
): Promise<{
  missing: ReadonlyArray<MissingLog>;
  totals: OverviewWeekTotals | null;
  error: string | null;
}> {
  try {
    const res = await fetch(
      `${base}/api/time-entries-overview?fromDate=${fromDate}&toDate=${toDate}`,
      { cache: "no-store", headers: headersInit }
    );
    if (!res.ok) {
      return { missing: [], totals: null, error: `Hours overview API returned ${res.status}` };
    }
    const body = await res.json();
    const parsed = TimeEntryOverviewResponseSchema.safeParse(body);
    if (!parsed.success) {
      return { missing: [], totals: null, error: "Unexpected hours overview response shape" };
    }
    return {
      missing: parsed.data.missing,
      totals: {
        workers: parsed.data.totals.byUser.length,
        hours: parsed.data.totals.totalHours,
        // Real jobs only — the null-job "Internal" bucket isn't a job on site.
        jobs: parsed.data.totals.byJob.filter((j) => j.jobId != null).length,
      },
      error: null,
    };
  } catch (err) {
    return {
      missing: [],
      totals: null,
      error: err instanceof Error ? err.message : "Hours overview network error",
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
