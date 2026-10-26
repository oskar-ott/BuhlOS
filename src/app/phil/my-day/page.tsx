import { Suspense } from "react";
import type { Route } from "next";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import {
  loadCurrentUserInProcess,
  loadWorkerEntriesInProcess,
  loadFieldJobsInProcess,
} from "../../../../api/_lib/phil-page-data.js";
import { PhilShell } from "@/components/phil/PhilShell";
import { PhilWeekStrip } from "@/components/phil/PhilWeekStrip";
import { PhilOfflineLink } from "@/components/phil/PhilOfflineLink";
import {
  PhilNeedsYouSection,
  PhilNeedsYouSectionFallback,
} from "@/components/phil/PhilNeedsYouSection";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { RefreshButton } from "@/components/ui/RefreshButton";
import {
  SESSION_COOKIE,
  decodeSessionCookie,
  parseSessionUser,
  type SessionPayload,
} from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import { landingFor } from "@/lib/auth/landing";
import { needsRoleSync, ROLE_SYNC_PATH } from "@/lib/auth/role-sync";
import { parseTimeEntryListLenient } from "@/domains/timesheets/parse-entries";
import type { TimeEntry } from "@/domains/timesheets/types";
import {
  BUSINESS_TIMEZONE,
  localDateString,
  parseFixDate,
} from "@/domains/timesheets/service";
import { canResubmitInPhil } from "@/domains/timesheets/resubmit";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import { isVisibleToField } from "@/domains/jobs/builder";
import { buildPhilNeedsYou } from "@/domains/phil/needs-you";
import { buildMyDayHero } from "@/domains/phil/my-day-hero";
import { PhilMyDayHero } from "@/components/phil/PhilMyDayHero";
import { buildPhilGreeting, hourInTimeZone } from "@/domains/phil/greeting";
import { philOnSiteSince, philSharpenedFlags } from "@/lib/phil/sharpened";
import {
  PhilMyDayLogHoursBanner,
  PhilMyDayOnJobCard,
  PhilMyDayQuickGrid,
  PhilMyDaySharpenedHeader,
} from "@/components/phil/PhilMyDaySharpened";
import { weekLoggedProgress } from "@/components/phil/philWeek";
import {
  PhilMyDaySharpenedAttention,
  PhilMyDaySharpenedAttentionFallback,
} from "@/components/phil/PhilMyDaySharpenedAttention";
import styles from "@/components/phil/myDay.module.css";
import { isFlagEnabled, isFlagOn } from "../../../../api/_lib/feature-flags.js";

export const dynamic = "force-dynamic";

/** "Tue 1 Jul" for the ?fixDate= fixer card — from the entry's REAL date. */
function formatFixDayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/**
 * /phil/my-day — the Phase B Phil home that replaces the placeholder
 * /v2/phil. Legacy /phil and /my-day continue to serve legacy until the
 * Phase C cutover; this is the parallel new surface that field workers
 * use once Phase B ships.
 *
 * Laid out as the approved final "Phil My Day" design — a payroll-focused
 * home that opens straight into the week timesheet:
 *   greeting ("Arvo, {name}" + date + the job they're on)
 *   → This week (the Mon–Sun PhilWeekStrip)
 *   → a "Log my hours" card to the Hours tab (the one logging home)
 *   → "Needs you" feed (PhilNeedsYouFeed — real attention only).
 * The centre Capture shutter stays on the shell (PhilTabBar).
 *
 * Honesty: the "Needs you" feed is backed ONLY by real, worker-attributable
 * sources — rejected hours + held-gear calibrations (see buildPhilNeedsYou and
 * docs/phil-my-day-needs-you.md). The design's "Submit timesheet" (weekly
 * batch) is NOT shipped (no weekly batch-submit workflow exists — logging a
 * day already submits it); unwired attention types are omitted, never faked.
 *
 * Cross-ref:
 *   docs/rebuild-audit/13-ui-information-architecture.md §Phil/Today
 *   docs/rebuild-audit/19-phase-b-hours-implementation-brief.md §Phil surface
 *   docs/phil-my-day.md (this surface)
 */
export default async function MyDayPage({
  searchParams,
}: {
  searchParams: Promise<{ fixDate?: string; synced?: string }>;
}) {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/phil/my-day");
  }
  if (!canAccessSurface(session.role, "phil")) {
    // Wrong-surface visitor (e.g. a client opens Phil directly) lands back on /v2/login.
    // The middleware will route them to their proper landing once they re-auth.
    redirect("/v2/login");
  }
  if (isAdminRole(session.role)) {
    // Belt-and-braces with src/middleware.ts: the installed PWA opens HERE for
    // everyone (manifest start_url), but an admin's home is the office (owner
    // pull 2026-08-16). Admin tier keeps the rest of Phil (own tool-day hours,
    // owner decision 2026-08-02) — only the field home bounces. The `as Route`
    // cast matches src/app/page.tsx — landingFor() returns dynamic paths.
    redirect(landingFor(session.role) as Route);
  }

  // ?fixDate=YYYY-MM-DD — landing from a "Hours rejected" push notification,
  // the Needs You feed, or a tap on a week-strip day (PhilWeekStrip links
  // today + past days here). Preselects that day in the hours sheet and
  // auto-opens the fix-and-resubmit form when that day was rejected, so the
  // fix is one tap from the notification (parity with the legacy /my-day
  // handler). Invalid values are ignored.
  const sp = await searchParams;
  const fixDate = parseFixDate(sp.fixDate);

  // Load the worker's recent entries AND their active assigned jobs in
  // parallel. The jobs feed the greeting's "on {job}" line and the sharpened
  // On-the-job card / receipt sheet (hours themselves log on the Hours tab).
  // The sharpened-chrome flags ride the same parallel wave (cached flags.json
  // reads, not per-page blob round-trips). Resolved server-side; only booleans
  // reach the client (docs/feature-flags.md).
  const [{ todayEntry, recentEntries, fetchError }, assignedJobs, profile, sharpenedFlags, receiptsOn, stockOn] =
    await Promise.all([
      loadEntries(raw, fixDate),
      loadAssignedJobs(raw),
      loadWorkerProfile(raw),
      philSharpenedFlags(session),
      // Receipts from the field: the worker flag AND the office inbox it feeds.
      Promise.all([isFlagEnabled("receipt_capture", session), isFlagOn("invoice_capture")])
        .then(([a, b]) => a && b)
        .catch(() => false),
      // Workshop stock: a Today tile while the flag is on for this viewer.
      isFlagEnabled("workshop_stock", session).catch(() => false),
    ]);

  // Role-change sync (src/lib/auth/role-sync.ts): the live login role differs
  // from the one they signed in with — e.g. an electrician the office just
  // made project manager. Re-sign the session once so they land on their new
  // home instead of keeping the old role's screens until they sign out.
  if (needsRoleSync(session.role, profile?.role, sp.synced === "1")) {
    redirect(ROLE_SYNC_PATH as Route);
  }

  // Hero priority state ("a day was sent back") is driven by REJECTED HOURS,
  // which buildPhilNeedsYou derives purely from the time entries already loaded
  // above (selector section A). Calibrations only feed the "Needs you" FEED
  // below the fold, which streams in its own <Suspense> boundary
  // (PhilNeedsYouSection) — so the actionable shell paints after ONE data wave
  // instead of two (each /api/* read is a ~1.3–2.1s Blob round-trip; #670).
  // Omitting the calibrations here yields a byte-identical hero because the
  // hero reads only the rejected-hours items.
  const heroNeedsYou = buildPhilNeedsYou({
    viewerId: session.userId ?? null,
    entries: recentEntries,
  });

  // #422: the ONE "what now" answer, from a pure state model. soleJob is set
  // below (exactly-one-assigned); compute the hero just before render so it
  // sees the resolved job.

  // Greeting. Time-of-day + the worker's real display name. The legacy login
  // signs the cookie as { userId, role } only — it never carries a name — so
  // the name is resolved from /api/auth?action=me (users.json), where the
  // username doubles as the display name app-wide (the hours pipeline stamps
  // it onto entries; the employees bridge splits it into first/last). Fails
  // soft: no profile → impersonal "Arvo" and no avatar, never a placeholder.
  // The job they're on is shown only when there's exactly one assigned job —
  // there is no active-job signal, so we never guess.
  // The greeting is the ONE place the "what you go by" nickname wins
  // (owner-directed 2026-08-09): every other surface (hours, approvals,
  // payroll prep, the register) shows the real full name.
  const displayName =
    profile?.preferredName?.trim() ||
    profile?.name?.trim() ||
    profile?.username?.trim() ||
    session.name?.trim() ||
    null;
  const dateLabel = new Date().toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: BUSINESS_TIMEZONE,
  });
  const jobs = assignedJobs.jobs;
  const soleJob = jobs.length === 1 ? jobs[0]! : null;
  const { heading, subtitle, initials } = buildPhilGreeting({
    displayName,
    hour: hourInTimeZone(new Date(), BUSINESS_TIMEZONE),
    dateLabel,
    soleJobName: soleJob?.name ?? null,
  });

  const todayISO = localDateString(new Date(), BUSINESS_TIMEZONE);
  const soleJobId = soleJob?.id ?? null;

  // ── Sharpened My Day (phil_sharpened, dark — Wave 2a) ────────────────────
  // The redesigned screen, from the SAME data waves as the current one (no new
  // API calls). Flag off falls through to the return below, byte-identical.
  if (sharpenedFlags.sharpened) {
    // "on site since {t}" only when today's REAL entry carries a start time.
    const onSiteSince = philOnSiteSince(todayEntry?.startTime ?? null);
    const sharpSubline = onSiteSince
      ? `${dateLabel} · on site since ${onSiteSince}`
      : dateLabel;
    // Week progress for the banner subline (weekly-first, owner directive
    // 2026-08-08) — real entries in the current Mon–Sun week vs weekdays
    // elapsed; the 7-day entries window always covers Monday→today.
    const weekProgress = weekLoggedProgress(recentEntries, todayISO);
    // ?fixDate= deep link (the "Hours rejected" push still points here): the
    // Hours tab is the one logging AND fixing home (docs/phil-hours.md), so
    // this card names the sent-back day with the office's reason and hands
    // the worker to its Fix sheet in one tap. Any other fixDate (already
    // fixed, never rejected) has nothing to fix here — the attention hero and
    // the Hours tab carry the day's real status.
    const fixEntry = fixDate ? (recentEntries.find((e) => e.date === fixDate) ?? null) : null;
    // Rejected-only here: canResubmitInPhil also covers submitted days now
    // (2026-07-26 owner-directed), but THIS card's "was sent back" framing is
    // a rejection story — a submitted day is changed from the Hours tab.
    const showFixCard =
      fixEntry !== null && fixEntry.status === "rejected" && canResubmitInPhil(fixEntry);
    return (
      <PhilShell
        title="My day"
        userId={session.userId ?? ""}
        sharpened
        jobRoomsEnabled={sharpenedFlags.jobRooms}
        accountInitials={initials}
      >
        <div className="flex flex-col gap-3" data-testid="phil-my-day-sharpened">
          <PhilMyDaySharpenedHeader heading={heading} subline={sharpSubline} />

          {/* The design's primary hours action — the yellow banner directly
              under the header, pointing at the Hours tab (the one logging
              home). Only while today is genuinely unlogged: once an entry
              exists the banner leaves and the quick tile below carries the
              quiet non-due state. Weekly-first (owner directive 2026-08-08):
              the subline is real week progress ("2 of 4 days logged this
              week") — the crew logs weekly, so no daily nag. todayISO/
              viewerId feed the client-side saved-entries journal gate — a
              just-saved day the store hasn't served back yet also clears
              the banner (2026-08-06). */}
          {/* A failed entries read leads the screen (P9 — critical state on
              the surface, not below the fold): what's logged and what was
              sent back are unknown, so no week count and no all-clear is
              claimed below it. */}
          {fetchError ? (
            <PhilNotice tone="warning" title="Couldn’t load your hours" role="alert">
              <p>
                What&rsquo;s logged this week and anything sent back may be missing. You can
                still log hours on the Hours tab.
              </p>
              <div className="mt-3">
                <RefreshButton />
              </div>
            </PhilNotice>
          ) : null}

          {todayEntry === null && !fetchError ? (
            <PhilMyDayLogHoursBanner
              todayISO={todayISO}
              viewerId={session.userId ?? null}
              weekLogged={weekProgress.logged}
              weekExpected={weekProgress.expected}
            />
          ) : null}

          {showFixCard ? (
            <section
              aria-labelledby="phil-my-day-fix-heading"
              data-testid="phil-my-day-fix-card"
            >
              <h2
                id="phil-my-day-fix-heading"
                className="mb-2 font-display text-[12px] font-bold uppercase tracking-[0.09em] text-text-muted"
              >
                Fix &amp; resubmit
              </h2>
              <div className="space-y-2 rounded-card border border-border bg-surface-raised p-4 shadow-card">
                <p className="font-display text-[15px] font-bold text-text">
                  {formatFixDayLabel(fixEntry.date)} was sent back
                </p>
                {fixEntry.rejectedReason ? (
                  <p className="whitespace-pre-line text-sm text-text-muted">
                    {fixEntry.rejectedReason}
                  </p>
                ) : null}
                <PhilOfflineLink
                  href={`/phil/hours?fix=${encodeURIComponent(fixEntry.date)}` as Route}
                  data-testid="phil-my-day-fix-link"
                  className="flex min-h-[48px] items-center justify-center rounded-card bg-accent-yellow px-4 font-display text-[15px] font-bold text-accent-ink active:scale-[0.99]"
                >
                  {`Fix ${formatFixDayLabel(fixEntry.date)} on the Hours tab`}
                </PhilOfflineLink>
              </div>
            </section>
          ) : null}

          {/* Hero "Do this now" + "Needs you" — the existing needs-you model,
              streamed exactly like the current screen's feed (second data
              wave: held calibrations). */}
          <Suspense fallback={<PhilMyDaySharpenedAttentionFallback />}>
            <PhilMyDaySharpenedAttention
              cookieValue={raw}
              viewerId={session.userId ?? null}
              entries={recentEntries}
              entriesFailed={Boolean(fetchError)}
            />
          </Suspense>

          {/* "On the job" — only the exactly-one-assigned signal is real;
              with 0 or 2+ jobs the card is honestly absent (never guessed). */}
          {soleJob ? <PhilMyDayOnJobCard job={soleJob} /> : null}

          {/* Hours live on the Hours tab (docs/phil-hours.md): the quick
              grid's "Log hours now" tile is THE hours
              affordance here. The old week strip + day-logger are gone from
              this screen — one logging home, not three competing forms. */}
          <PhilMyDayQuickGrid
            hoursDue={todayEntry === null}
            callJobId={soleJobId}
            todayISO={todayISO}
            viewerId={session.userId ?? null}
            receipts={
              receiptsOn
                ? { jobs: jobs.map((j) => ({ id: j.id, name: j.name, code: j.code ?? null })), defaultJobId: soleJobId }
                : null
            }
            stock={stockOn}
          />

        </div>
      </PhilShell>
    );
  }

  return (
    <PhilShell
      title="My day"
      userId={session.userId ?? ""}
      sharpened={sharpenedFlags.sharpened}
      jobRoomsEnabled={sharpenedFlags.jobRooms}
      accountInitials={initials}
    >
      <div className={styles.surface}>
        <header className={styles.greetBar}>
          <div className="min-w-0">
            <h1 className={styles.greetName}>{heading}</h1>
            <p className={styles.greetSub}>{subtitle}</p>
          </div>
          {initials ? (
            <div className={styles.avatar} aria-hidden="true">
              {initials}
            </div>
          ) : null}
        </header>

        <PhilMyDayHero
          hero={buildMyDayHero({
            todayStatus: (todayEntry?.status as
              | "draft"
              | "submitted"
              | "approved"
              | "rejected"
              | undefined) ?? null,
            needsYouItems: heroNeedsYou,
            soleJob: soleJob ? { id: soleJob.id, name: soleJob.name } : null,
          })}
        />

        <PhilWeekStrip entries={recentEntries} todayISO={todayISO} selectedDate={fixDate} />

        {/* Hours are logged, changed and fixed on the Hours tab
            (docs/phil-hours.md). A week-strip tap (?fixDate=) hands that day
            on: a sent-back day opens its Fix sheet; any other day lands on the
            Hours screen. */}
        <PhilOfflineLink
          href={
            (fixDate
              ? `/phil/hours?fix=${encodeURIComponent(fixDate)}`
              : "/phil/hours?log=1") as Route
          }
          data-testid="phil-my-day-hours-link"
          className="flex min-h-[64px] items-center justify-between gap-3 rounded-card bg-accent-yellow px-4 font-display text-[17px] font-bold text-accent-ink shadow-card active:scale-[0.99]"
        >
          {fixDate ? `Open ${formatFixDayLabel(fixDate)} on the Hours tab` : "Log my hours"}
          <span aria-hidden="true">→</span>
        </PhilOfflineLink>

        {/* Workshop stock — the same tile the redesigned Today carries in its
            Quick grid; absent while the flag is off for this viewer. */}
        {stockOn ? (
          <PhilOfflineLink
            href={"/phil/stock" as Route}
            data-testid="phil-my-day-stock"
            className="flex min-h-[64px] items-center justify-between gap-3 rounded-card border-2 border-brand-navy bg-surface-raised px-4 shadow-card active:scale-[0.99]"
          >
            <span className="min-w-0">
              <span className="block font-display text-[17px] font-bold text-brand-navy">Workshop stock</span>
              <span className="block text-sm text-text-muted">Take, add or return</span>
            </span>
            <span aria-hidden="true" className="font-display text-[17px] font-bold text-brand-navy">→</span>
          </PhilOfflineLink>
        ) : null}

        {fetchError ? (
          <PhilNotice tone="warning" title="Couldn’t load recent entries" role="alert">
            <p>
              {fetchError}. You can still submit a new entry — it’ll appear here once
              we’re back online.
            </p>
            <div className="mt-3">
              <RefreshButton />
            </div>
          </PhilNotice>
        ) : null}

        <Suspense fallback={<PhilNeedsYouSectionFallback />}>
          <PhilNeedsYouSection
            cookieValue={raw}
            viewerId={session.userId ?? null}
            entries={recentEntries}
          />
        </Suspense>
      </div>
    </PhilShell>
  );
}

/**
 * Resolve the signed-in worker's profile (display name) via the authoritative
 * /api/auth?action=me endpoint. The session cookie never carries a name (the
 * legacy login signs { userId, role } only), and users.json is the one store
 * that knows what this worker is called. Fails soft to null on any error —
 * the greeting degrades to the impersonal form rather than blocking the page.
 */
async function loadWorkerProfile(
  cookieValue: string | undefined
): Promise<SessionPayload | null> {
  if (!cookieValue) return null;
  // In-process read (2026-08-03): same authoritative getCurrentUser the
  // /api/auth?action=me hop ran, without invoking a second serverless
  // function; parseSessionUser applies the same shape gate to the result.
  try {
    return parseSessionUser(await loadCurrentUserInProcess(cookieValue));
  } catch {
    return null; // fail-soft, same as verifyViaApi — the greeting degrades
  }
}

async function loadEntries(
  cookieValue: string | undefined,
  fixDate: string | null = null
): Promise<{
  todayEntry: TimeEntry | null;
  recentEntries: ReadonlyArray<TimeEntry>;
  fetchError: string | null;
}> {
  // Server-side "today" must use the business timezone so a Vercel UTC server
  // doesn't compute yesterday's date for a Sydney worker. The rolling 7-day window
  // always covers this week's Monday→today, so PhilWeekStrip needs no extra
  // fetch. A ?fixDate= deep link can point outside that window (rejections can
  // be up to 14 days back), so the range stretches to include it — otherwise
  // the worker would land on the right day but never see the entry to fix.
  const today = localDateString(new Date(), BUSINESS_TIMEZONE);
  const sevenDaysAgo = localDateString(
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    BUSINESS_TIMEZONE
  );
  const fromDate = fixDate && fixDate < sevenDaysAgo ? fixDate : sevenDaysAgo;
  const toDate = fixDate && fixDate > today ? fixDate : today;

  try {
    // In-process read (2026-08-03): this used to HTTP-fetch our own
    // /api/time-entries — a second serverless invocation whose cold start
    // stacked onto this page's. Same auth + read path, same lenient parse.
    const res = await loadWorkerEntriesInProcess(cookieValue, { fromDate, toDate });
    if (!res.ok) {
      return {
        todayEntry: null,
        recentEntries: [],
        fetchError: `API returned ${res.status}`,
      };
    }
    const parsed = parseTimeEntryListLenient({ entries: res.entries });
    if (!parsed.ok) {
      return {
        todayEntry: null,
        recentEntries: [],
        fetchError: "Unexpected response shape",
      };
    }
    if (parsed.dropped > 0) {
      console.warn(
        `phil/my-day: skipped ${parsed.dropped} malformed time entr${parsed.dropped === 1 ? "y" : "ies"}`,
      );
    }
    const todayEntry = parsed.entries.find((e) => e.date === today) ?? null;
    return {
      todayEntry,
      recentEntries: parsed.entries,
      fetchError: null,
    };
  } catch (err) {
    return {
      todayEntry: null,
      recentEntries: [],
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}

/**
 * Load the worker's active assigned jobs (id + name).
 *
 * Source of truth: users.json.assignedJobIds — the same source Phil already
 * uses for job visibility. The legacy GET /api/jobs already scopes a field
 * caller to their assignedJobIds and strips draft/archived (api/jobs.js); the
 * isVisibleToField filter here is defence-in-depth so an admin previewing My
 * Day never sees a draft/archived job as a log target. Returns `error: true`
 * on any failure so the receipt sheet can block rather than fall back to an
 * unattributed entry. Feeds the greeting's "on {job}" line (shown only for a
 * single assigned job) and the sharpened On-the-job card.
 */
async function loadAssignedJobs(cookieValue: string | undefined): Promise<{
  /** ref/siteAddress ride along for the sharpened "On the job" card — the
   *  same single /api/jobs read, no extra call. */
  jobs: ReadonlyArray<{
    id: string;
    name: string;
    ref: string | null;
    siteAddress: string | null;
    /** The IV code — the receipt sheet's job picker shows it beside the name. */
    code: string | null;
  }>;
  error: boolean;
}> {
  try {
    // In-process read (2026-08-03) — same role-scoped job set the HTTP
    // /api/jobs list served, without invoking a second serverless function.
    const res = await loadFieldJobsInProcess(cookieValue);
    if (!res.ok) return { jobs: [], error: true };
    const parsed = JobListResponseSchema.safeParse({ jobs: res.jobs });
    if (!parsed.success) return { jobs: [], error: true };
    const jobs = parsed.data.jobs
      .filter((j) => isVisibleToField(j))
      .map((j) => ({
        id: j.id,
        name: j.name,
        ref: j.ref ?? null,
        siteAddress: j.siteAddress ?? null,
        code: j.code ?? null,
      }));
    return { jobs, error: false };
  } catch {
    return { jobs: [], error: true };
  }
}
