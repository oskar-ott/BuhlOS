import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { JetBrains_Mono } from "next/font/google";
import { cn } from "@/lib/cn";
import { PhilShell } from "@/components/phil/PhilShell";
import { AttentionBanner } from "@/components/ui/AttentionBanner";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { LogHoursSheet } from "@/components/phil/LogHoursSheet";
import { PhilWeekStrip } from "@/components/phil/PhilWeekStrip";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { TimeEntryListResponseSchema } from "@/domains/timesheets/schema";
import type { TimeEntry } from "@/domains/timesheets/types";
import { BUSINESS_TIMEZONE, localDateString } from "@/domains/timesheets/service";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import { isVisibleToField } from "@/domains/jobs/builder";
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
 *   → rejected-hours alert (the only real "needs you" on this surface).
 * The centre Capture shutter stays on the shell (PhilTabBar).
 *
 * Honesty: the design's "Submit timesheet" (weekly batch) and "Needs you"
 * RFI / ITP-mark rows are NOT shipped — logging a day already submits it to
 * the office (there is no weekly batch submit), and RFIs / a cross-job
 * needs-you feed don't exist in Phil yet. We never fabricate that state.
 *
 * Cross-ref:
 *   docs/rebuild-audit/13-ui-information-architecture.md §Phil/Today
 *   docs/rebuild-audit/19-phase-b-hours-implementation-brief.md §Phil surface
 *   docs/phil-my-day.md (this surface)
 */
export default async function MyDayPage() {
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

  // Load the worker's recent entries AND their active assigned jobs in
  // parallel. The jobs feed the LogHoursSheet job-attribution block so a
  // field submission is tied to a real active job instead of jobId: null.
  const [{ todayEntry, recentEntries, fetchError }, assignedJobs] = await Promise.all([
    loadEntries(raw),
    loadAssignedJobs(raw),
  ]);

  // Bible vNext §16.3 quick-win: surface the most recent rejected entry so the
  // worker can act in five seconds. This is the only real "needs you" signal on
  // My Day — kept at the top rather than the design's bottom slot because a
  // rejected day is about the hours flow right here. Only one banner stacks.
  const rejectedEntry = recentEntries.find(
    (e) => e.status === "rejected" && e.rejectedReason
  );

  // Greeting. Time-of-day + worker name (both real: the name rides on the
  // session cookie, no extra fetch; the part-of-day is computed in the business
  // timezone). The job they're on is shown only when there's exactly one
  // assigned job — there is no active-job signal, so we never guess.
  const firstName = session.name?.trim().split(/\s+/)[0] || null;
  const initials = workerInitials(session.name);
  const partOfDay = businessPartOfDay();
  const greeting = firstName ? `${partOfDay}, ${firstName}` : partOfDay;
  const dateLabel = new Date().toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: BUSINESS_TIMEZONE,
  });
  const jobs = assignedJobs.jobs;
  const soleJob = jobs.length === 1 ? jobs[0]! : null;
  const subtitle = soleJob ? `${dateLabel} · on ${soleJob.name}` : dateLabel;

  const todayISO = localDateString(new Date(), BUSINESS_TIMEZONE);
  // The hours sheet keeps its own minimal {id,name} list and is preselected
  // when there's exactly one job, so the write/attribution path is unchanged.
  const soleJobId = soleJob?.id ?? null;

  return (
    <PhilShell title="My day">
      <div className={cn(styles.surface, mono.variable)}>
        <header className={styles.greet}>
          <div className="min-w-0">
            <h1 className={styles.greetName}>{greeting}</h1>
            <p className={styles.greetSub}>{subtitle}</p>
          </div>
          {initials ? (
            <div className={styles.avatar} aria-hidden="true">
              {initials}
            </div>
          ) : null}
        </header>

        {rejectedEntry ? (
          <AttentionBanner
            chip="Rejected"
            tone="danger"
            title={`${formatShortDate(rejectedEntry.date)} hours need a fix`}
            description={
              <>
                <span className="font-medium">Why:</span>{" "}
                {rejectedEntry.rejectedReason}
              </>
            }
            cta={
              <Link
                href="/phil/hours"
                className="inline-flex min-h-[44px] items-center font-semibold text-text underline decoration-accent-yellow decoration-2 underline-offset-4"
              >
                Fix &amp; resubmit →
              </Link>
            }
          />
        ) : null}

        <PhilWeekStrip entries={recentEntries} todayISO={todayISO} />

        <LogHoursSheet
          initialTodayEntry={todayEntry}
          recentEntries={recentEntries}
          assignedJobs={jobs}
          jobsError={assignedJobs.error}
          initialJobId={soleJobId}
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

        <UnderConstructionPanel
          feature="Multi-job allocation · job picker"
          description="One allocation per submission today. Splitting a day across two jobs, or picking which job a Standard day lands on, is still on the legacy My day — that loop lands here in a later phase."
          legacyHref="/my-day"
          legacyLabel="Use the legacy My day for multi-job allocations"
        />
      </div>
    </PhilShell>
  );
}

/** Up-to-two-letter avatar initials from the worker's real name, or null. */
function workerInitials(name: string | undefined): string | null {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** "Morning" / "Arvo" / "Evening" in the business timezone (Australian register). */
function businessPartOfDay(): string {
  const hour = Number(
    new Intl.DateTimeFormat("en-AU", {
      hour: "numeric",
      hour12: false,
      timeZone: BUSINESS_TIMEZONE,
    }).format(new Date())
  );
  if (Number.isNaN(hour) || hour < 12) return "Morning";
  if (hour < 17) return "Arvo";
  return "Evening";
}

async function loadEntries(cookieValue: string | undefined): Promise<{
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
  // fetch.
  const today = localDateString(new Date(), BUSINESS_TIMEZONE);
  const sevenDaysAgo = localDateString(
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    BUSINESS_TIMEZONE
  );

  try {
    const res = await fetch(
      `${base}/api/time-entries?fromDate=${encodeURIComponent(sevenDaysAgo)}&toDate=${encodeURIComponent(today)}`,
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

function formatShortDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}
