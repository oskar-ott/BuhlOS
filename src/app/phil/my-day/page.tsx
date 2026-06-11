import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { JetBrains_Mono } from "next/font/google";
import { cn } from "@/lib/cn";
import { PhilShell } from "@/components/phil/PhilShell";
import { LogHoursSheet } from "@/components/phil/LogHoursSheet";
import { PhilWeekStrip } from "@/components/phil/PhilWeekStrip";
import { PhilNeedsYouFeed } from "@/components/phil/PhilNeedsYouFeed";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { RefreshButton } from "@/components/ui/RefreshButton";
import {
  SESSION_COOKIE,
  decodeSessionCookie,
  verifyViaApi,
  type SessionPayload,
} from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { TimeEntryListResponseSchema } from "@/domains/timesheets/schema";
import type { TimeEntry } from "@/domains/timesheets/types";
import {
  BUSINESS_TIMEZONE,
  localDateString,
  parseFixDate,
} from "@/domains/timesheets/service";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import { isVisibleToField } from "@/domains/jobs/builder";
import { SnagListResponseSchema } from "@/domains/snags/schema";
import { buildPhilNeedsYou, type JobSnags } from "@/domains/phil/needs-you";
import { buildPhilGreeting, hourInTimeZone } from "@/domains/phil/greeting";
import styles from "@/components/phil/myDay.module.css";

export const dynamic = "force-dynamic";

// JetBrains Mono — the design's microcopy face. Scoped to the My Day wrapper
// (its CSS variable is only applied there), so it never restyles the rest of
// the app. The display/body faces (Inter Tight / Inter) already load globally.
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

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
 * sources — rejected hours + snagsV2 assigned to this worker (see
 * buildPhilNeedsYou and docs/phil-my-day-needs-you.md). The design's "Submit
 * timesheet" (weekly batch) is NOT shipped (no weekly batch-submit workflow
 * exists — logging a day already submits it); unwired attention types (tasks,
 * evidence, ITP, RFI) are omitted, never faked.
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

  // ?fixDate=YYYY-MM-DD — landing from a "Hours rejected" push notification or
  // the Needs You feed. Preselects that day in the hours sheet and auto-opens
  // the fix-and-resubmit form, so the fix is one tap from the notification
  // (parity with the legacy /my-day handler). Invalid values are ignored.
  const sp = await searchParams;
  const fixDate = parseFixDate(sp.fixDate);

  // Load the worker's recent entries AND their active assigned jobs in
  // parallel. The jobs feed the LogHoursSheet job-attribution block so a
  // field submission is tied to a real active job instead of jobId: null.
  const [{ todayEntry, recentEntries, fetchError }, assignedJobs, profile] = await Promise.all(
    [loadEntries(raw, fixDate), loadAssignedJobs(raw), loadWorkerProfile(raw)]
  );

  // "Needs you" feed — the worker's real, actionable attention across their
  // assigned jobs. Snags are job-scoped (GET /api/snags?jobId=), so we fetch
  // them per assigned job once the jobs are known; the build is a pure
  // selector. Both inputs are real (rejected hours + snags assigned to ME) —
  // see buildPhilNeedsYou; nothing here is fabricated.
  const jobSnags = await loadAssignedSnags(assignedJobs.jobs, raw);
  const needsYouItems = buildPhilNeedsYou({
    viewerId: session.userId ?? null,
    entries: recentEntries,
    jobSnags,
  });

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

  return (
    <PhilShell title="My day">
      <div className={cn(styles.surface, mono.variable)}>
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

        <PhilWeekStrip entries={recentEntries} todayISO={todayISO} />

        <LogHoursSheet
          initialTodayEntry={todayEntry}
          recentEntries={recentEntries}
          assignedJobs={jobs}
          jobsError={assignedJobs.error}
          initialJobId={soleJobId}
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

        <PhilNeedsYouFeed items={needsYouItems} />

        <div className={styles.deferNote}>
          <div className={styles.deferNoteLabel}>Heads up</div>
          <p className={styles.deferNoteBody}>
            One allocation per submission. To split a day across two jobs, use the{" "}
            <a href="/my-day" className={styles.deferNoteLink}>
              legacy My day
            </a>
            .
          </p>
        </div>
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
    const parsed = TimeEntryListResponseSchema.safeParse(body);
    if (!parsed.success) {
      return {
        todayEntry: null,
        recentEntries: [],
        fetchError: "Unexpected response shape",
      };
    }
    const todayEntry = parsed.data.entries.find((e) => e.date === today) ?? null;
    return {
      todayEntry,
      recentEntries: parsed.data.entries,
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
  jobs: ReadonlyArray<{ id: string; name: string }>;
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
      .map((j) => ({ id: j.id, name: j.name }));
    return { jobs, error: false };
  } catch {
    return { jobs: [], error: true };
  }
}

/**
 * Load snagsV2 for each assigned job and aggregate into the "Needs you" feed
 * input. snagsV2 is job-scoped (GET /api/snags?jobId=), so this fetches per
 * assigned job in parallel and FAILS SOFT per job — a job whose snags can't be
 * read is skipped (its snags don't appear), never an error that blanks the
 * page. The pure selector (buildPhilNeedsYou) then keeps only snags assigned to
 * THIS worker that are still open / in progress. Workers have a handful of
 * assigned jobs, so this is a small, bounded fan-out.
 */
async function loadAssignedSnags(
  jobs: ReadonlyArray<{ id: string; name: string }>,
  cookieValue: string | undefined,
): Promise<JobSnags[]> {
  if (jobs.length === 0) return [];
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  const results = await Promise.all(
    jobs.map(async (job): Promise<JobSnags | null> => {
      try {
        const res = await fetch(`${base}/api/snags?jobId=${encodeURIComponent(job.id)}`, {
          cache: "no-store",
          headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
        });
        if (!res.ok) return null;
        const parsed = SnagListResponseSchema.safeParse(await res.json());
        if (!parsed.success) return null;
        return { jobId: job.id, jobName: job.name, snags: parsed.data.snags };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is JobSnags => r !== null);
}
