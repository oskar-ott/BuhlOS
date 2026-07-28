import { Suspense } from "react";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { LogHoursSheet } from "@/components/phil/LogHoursSheet";
import { PhilWeekStrip } from "@/components/phil/PhilWeekStrip";
import { RejectedHoursResubmitSheet } from "@/components/phil/RejectedHoursResubmitSheet";
import {
  PhilNeedsYouSection,
  PhilNeedsYouSectionFallback,
} from "@/components/phil/PhilNeedsYouSection";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { RefreshButton } from "@/components/ui/RefreshButton";
import {
  SESSION_COOKIE,
  decodeSessionCookie,
  verifyViaApi,
  type SessionPayload,
} from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { parseTimeEntryListLenient } from "@/domains/timesheets/parse-entries";
import type { TimeEntry } from "@/domains/timesheets/types";
import {
  BUSINESS_TIMEZONE,
  lastLoggedJobFor,
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
  PhilMyDayHonestyNote,
  PhilMyDayLogHoursBanner,
  PhilMyDayOnJobCard,
  PhilMyDayQuickGrid,
  PhilMyDaySharpenedHeader,
} from "@/components/phil/PhilMyDaySharpened";
import {
  PhilMyDaySharpenedAttention,
  PhilMyDaySharpenedAttentionFallback,
} from "@/components/phil/PhilMyDaySharpenedAttention";
import styles from "@/components/phil/myDay.module.css";

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
 *   → log today's hours (the unchanged LogHoursSheet)
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
  searchParams: Promise<{ fixDate?: string }>;
}) {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/phil/my-day");
  }
  if (!canAccessSurface(session.role, "phil")) {
    // Wrong-surface visitor (e.g. an admin opens Phil directly) lands back on /v2/login.
    // The middleware will route them to their proper landing once they re-auth.
    redirect("/v2/login");
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
  // parallel. The jobs feed the LogHoursSheet job-attribution block so a
  // field submission is tied to a real active job instead of jobId: null.
  // The sharpened-chrome flags ride the same parallel wave (cached flags.json
  // reads, not per-page blob round-trips). Resolved server-side; only booleans
  // reach the client (docs/feature-flags.md).
  const [{ todayEntry, recentEntries, fetchError }, assignedJobs, profile, sharpenedFlags] =
    await Promise.all([
      loadEntries(raw, fixDate),
      loadAssignedJobs(raw),
      loadWorkerProfile(raw),
      philSharpenedFlags(session),
    ]);

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
  const displayName =
    profile?.name?.trim() || profile?.username?.trim() || session.name?.trim() || null;
  const dateLabel = new Date().toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: BUSINESS_TIMEZONE,
  });
  const jobs = assignedJobs.jobs;
  const soleJob = jobs.length === 1 ? jobs[0]! : null;
  // The worker's most-recently-logged job (only if it's still assignable), so
  // the hours picker defaults to "same job as last time" — derived from the
  // already-loaded recent entries, with a REAL entry date for the sub-line
  // (never fabricated). Null when they haven't logged recently → the sheet
  // falls back to the sole job or an explicit pick.
  const lastLogged = lastLoggedJobFor(
    recentEntries,
    jobs.map((j) => j.id)
  );
  const { heading, subtitle, initials } = buildPhilGreeting({
    displayName,
    hour: hourInTimeZone(new Date(), BUSINESS_TIMEZONE),
    dateLabel,
    soleJobName: soleJob?.name ?? null,
  });

  const todayISO = localDateString(new Date(), BUSINESS_TIMEZONE);
  // The hours sheet keeps its own minimal {id,name} list and is preselected
  // when there's exactly one job, so the write/attribution path is unchanged.
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
    // ?fixDate= deep link (push notifications, needs-you rows — both point at
    // REJECTED days): the Hours tab (W2c) is the logging home now, so this
    // screen no longer mounts the week strip / day-logger — but the one-tap
    // fix contract must hold. When the linked day's entry is rejected and
    // fixable, a focused fixer card renders below with the SAME tested
    // resubmit sheet auto-opened. Any other fixDate (already fixed, never
    // rejected) has nothing to fix here — the attention hero and the Hours
    // tab carry the day's real status.
    const fixEntry = fixDate ? (recentEntries.find((e) => e.date === fixDate) ?? null) : null;
    // Rejected-only here: canResubmitInPhil also covers submitted days now
    // (2026-07-26 owner-directed), but THIS card's "was sent back" framing is
    // a rejection story — a submitted day's change affordance lives on the
    // Hours tab / LogHoursSheet instead.
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
              exists, "Today not logged" would be a lie, so the banner leaves
              and the quick tile below carries the quiet non-due state. */}
          {todayEntry === null ? <PhilMyDayLogHoursBanner /> : null}

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
                <RejectedHoursResubmitSheet
                  key={fixEntry.id}
                  entry={fixEntry}
                  assignedJobs={jobs}
                  jobsError={assignedJobs.error}
                  defaultOpen
                />
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
            />
          </Suspense>

          {/* "On the job" — only the exactly-one-assigned signal is real;
              with 0 or 2+ jobs the card is honestly absent (never guessed). */}
          {soleJob ? <PhilMyDayOnJobCard job={soleJob} /> : null}

          {/* Hours live on the Hours tab (W2c — LogHoursSheet is mounted
              there): the quick grid's "Log hours now" tile is THE hours
              affordance here. The old week strip + day-logger are gone from
              this screen — one logging home, not three competing forms. */}
          <PhilMyDayQuickGrid hoursDue={todayEntry === null} callJobId={soleJobId} />

          <PhilMyDayHonestyNote />

          {fetchError ? (
            <PhilNotice tone="warning" title="Couldn’t load recent entries" role="alert">
              <p>
                {fetchError}. Alerts for this week may be incomplete — you can still log
                hours from the Hours tab.
              </p>
              <div className="mt-3">
                <RefreshButton />
              </div>
            </PhilNotice>
          ) : null}
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

        <LogHoursSheet
          // Remount when the deep-linked day changes. The sheet seeds its date
          // (and the resubmit sheet's open state) in useState INITIALISERS, so
          // on a same-page soft navigation — tapping a week-strip day, or a
          // Needs You item, while already on /phil/my-day — React would keep
          // the existing instance and silently ignore the new initialDate. The
          // key makes the ?fixDate= contract hold for client-side navigations
          // too, not just fresh document loads (push notifications).
          key={fixDate ?? "no-fix-date"}
          initialTodayEntry={todayEntry}
          recentEntries={recentEntries}
          assignedJobs={jobs}
          jobsError={assignedJobs.error}
          initialJobId={soleJobId}
          lastLoggedJobId={lastLogged?.jobId ?? null}
          lastLoggedDate={lastLogged?.date ?? null}
          initialDate={fixDate}
          autoOpenFix={fixDate !== null}
        />

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
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  return verifyViaApi(`${SESSION_COOKIE}=${cookieValue}`, base);
}

async function loadEntries(
  cookieValue: string | undefined,
  fixDate: string | null = null
): Promise<{
  todayEntry: TimeEntry | null;
  recentEntries: ReadonlyArray<TimeEntry>;
  fetchError: string | null;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  // Server-side "today" must use the business timezone so a Vercel UTC server
  // doesn't compute yesterday's date for a Sydney worker. The browser-local
  // date is still used inside the LogHoursSheet client form (it initialises
  // its date state in the worker's actual timezone). The rolling 7-day window
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
    const res = await fetch(
      `${base}/api/time-entries?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`,
      {
        cache: "no-store",
        headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
      }
    );
    if (!res.ok) {
      return {
        todayEntry: null,
        recentEntries: [],
        fetchError: `API returned ${res.status}`,
      };
    }
    const body = await res.json();
    const parsed = parseTimeEntryListLenient(body);
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
 * on any failure so the sheet can block submission rather than fall back to an
 * unattributed entry. Feeds both the LogHoursSheet attribution and the
 * greeting's "on {job}" line (shown only for a single assigned job).
 */
async function loadAssignedJobs(cookieValue: string | undefined): Promise<{
  /** ref/siteAddress ride along for the sharpened "On the job" card — the
   *  same single /api/jobs read, no extra call. Consumers that only need
   *  {id,name} (LogHoursSheet, needs-you) are structurally unaffected. */
  jobs: ReadonlyArray<{
    id: string;
    name: string;
    ref: string | null;
    siteAddress: string | null;
  }>;
  error: boolean;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/jobs`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return { jobs: [], error: true };
    const body = await res.json();
    const parsed = JobListResponseSchema.safeParse(body);
    if (!parsed.success) return { jobs: [], error: true };
    const jobs = parsed.data.jobs
      .filter((j) => isVisibleToField(j))
      .map((j) => ({
        id: j.id,
        name: j.name,
        ref: j.ref ?? null,
        siteAddress: j.siteAddress ?? null,
      }));
    return { jobs, error: false };
  } catch {
    return { jobs: [], error: true };
  }
}
