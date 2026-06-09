import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { AttentionBanner } from "@/components/ui/AttentionBanner";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { LogHoursSheet } from "@/components/phil/LogHoursSheet";
import { PhilRightNowCard } from "@/components/phil/PhilRightNowCard";
import { PhilJobsList } from "@/components/phil/PhilJobsList";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { TimeEntryListResponseSchema } from "@/domains/timesheets/schema";
import type { TimeEntry } from "@/domains/timesheets/types";
import { BUSINESS_TIMEZONE, localDateString } from "@/domains/timesheets/service";
import { JobListResponseSchema } from "@/domains/jobs/schema";
import type { Job } from "@/domains/jobs/types";
import { isVisibleToField } from "@/domains/jobs/builder";

export const dynamic = "force-dynamic";

/**
 * /phil/my-day — the Phase B Phil home that replaces the placeholder
 * /v2/phil. Legacy /phil and /my-day continue to serve legacy until the
 * Phase C cutover; this is the parallel new surface that field workers
 * use once Phase B ships.
 *
 * Laid out as the approved A·Right Now direction: identity (Hey, {name} +
 * date) → what matters now (the assigned job as a navy accent hero, or the
 * real jobs list for 2+ jobs) → the action (the unchanged LogHoursSheet) →
 * this-week history → secondary links. The centre Capture shutter stays on
 * the shell (PhilTabBar). No fabricated state: the worker name, job, address,
 * status and open-work counts are all real or omitted.
 *
 * Cross-ref:
 *   docs/rebuild-audit/13-ui-information-architecture.md §Phil/Today
 *   docs/rebuild-audit/19-phase-b-hours-implementation-brief.md §Phil surface
 *   docs/phil-my-day-right-now.md (this surface)
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

  // Bible vNext §16.3 quick-win: surface the most recent rejected entry
  // at the top of My day so the worker can act in five seconds. Only one
  // banner stacks — §13 forbids more than one AttentionBanner per screen.
  const rejectedEntry = recentEntries.find(
    (e) => e.status === "rejected" && e.rejectedReason
  );

  // A · Right Now identity line. The worker name rides on the session cookie
  // (session.name) — no extra fetch — and degrades to a name-less lead when
  // it's absent. Date is rendered in the business timezone so a UTC server
  // never shows yesterday to a Sydney worker.
  const firstName = session.name?.trim().split(/\s+/)[0] || null;
  const todayLabel = new Date().toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: BUSINESS_TIMEZONE,
  });

  // "What matters now" = the assigned job. We crown a single job "you're on"
  // (the navy hero); with 2+ jobs there is no active-job signal, so we show
  // the real jobs list and never fabricate a current job. The hours sheet
  // keeps its own minimal {id,name} list (and is preselected when there's
  // exactly one job) so the write/attribution path is byte-for-byte unchanged.
  const jobs = assignedJobs.jobs;
  const sheetJobs = jobs.map((j) => ({ id: j.id, name: j.name }));
  const soleJobId = jobs.length === 1 ? jobs[0]!.id : null;

  return (
    <PhilShell title="My day">
      <div className="space-y-4">
        <header>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-text">
            {firstName ? `Hey, ${firstName}.` : "Right now"}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">{todayLabel}</p>
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

        {jobs.length === 1 ? (
          <PhilRightNowCard job={jobs[0]!} />
        ) : jobs.length > 1 ? (
          <section className="space-y-2">
            <h2 className="font-display text-xs font-semibold uppercase tracking-widest text-text-muted">
              Your jobs
            </h2>
            <PhilJobsList initialJobs={jobs} />
          </section>
        ) : null}

        <LogHoursSheet
          initialTodayEntry={todayEntry}
          recentEntries={recentEntries}
          assignedJobs={sheetJobs}
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

        <Card>
          <div className="flex items-center justify-between gap-3">
            <CardTitle>This week</CardTitle>
            <Link
              href="/phil/hours"
              className="text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
            >
              See history →
            </Link>
          </div>
          <CardDescription className="mt-1">
            Last 7 days. Tap the date to copy that day&rsquo;s notes when fixing a rejected entry.
          </CardDescription>
          <RecentEntriesTable entries={recentEntries} />
        </Card>

        <div className="px-1">
          <Link
            href="/phil/gear"
            className="inline-flex min-h-[44px] items-center text-sm font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
          >
            My gear →
          </Link>
        </div>

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
  // its date state in the worker's actual timezone).
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
 * Load the worker's active assigned jobs.
 *
 * Source of truth: users.json.assignedJobIds — the same source Phil already
 * uses for job visibility. The legacy GET /api/jobs already scopes a field
 * caller to their assignedJobIds and strips draft/archived (api/jobs.js); the
 * isVisibleToField filter here is defence-in-depth so an admin previewing My
 * Day never sees a draft/archived job as a log target. Returns `error: true`
 * on any failure so the sheet can block submission rather than fall back to an
 * unattributed entry.
 *
 * `?withStats=1` enriches each job with real, opt-in site counts (open snags +
 * active ITPs) for the A·Right Now lead card's open-work chips — the SAME
 * proven-soft enrichment the Phil jobs list already uses (api/jobs.js fails
 * soft: a bad stats read still returns the core job with zeroed stats, so the
 * chips simply don't render and nothing else regresses). The full Job objects
 * are kept (not narrowed to {id,name}) so the card has the real address/status;
 * the hours sheet is handed a minimal {id,name} list by the page, so its
 * client payload and attribution are unchanged.
 */
async function loadAssignedJobs(cookieValue: string | undefined): Promise<{
  jobs: ReadonlyArray<Job>;
  error: boolean;
}> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(`${base}/api/jobs?withStats=1`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return { jobs: [], error: true };
    const body = await res.json();
    const parsed = JobListResponseSchema.safeParse(body);
    if (!parsed.success) return { jobs: [], error: true };
    const jobs = parsed.data.jobs.filter((j) => isVisibleToField(j));
    return { jobs, error: false };
  } catch {
    return { jobs: [], error: true };
  }
}

function RecentEntriesTable({ entries }: { entries: ReadonlyArray<TimeEntry> }) {
  if (entries.length === 0) {
    return (
      <p className="mt-3 rounded-card border border-dashed border-border bg-surface-subtle p-4 text-sm text-text-muted">
        No entries in the last 7 days. Tap Standard day above to log today.
      </p>
    );
  }
  return (
    <ul className="mt-3 divide-y divide-border">
      {entries.slice(0, 7).map((entry) => {
        const isRejected = entry.status === "rejected" && entry.rejectedReason;
        return (
          <li key={entry.id} className="py-2">
            <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-sm">
              <span className="font-medium text-text">{formatShortDate(entry.date)}</span>
              <span className="text-text-muted">{formatShortHours(entry.totalHours)}</span>
              <StatusChip tone={HOURS_TONE[entry.status]}>
                {HOURS_LABEL[entry.status]}
              </StatusChip>
            </div>
            {isRejected ? (
              <div className="mt-1 space-y-1">
                <p className="text-xs leading-snug text-text-muted">
                  <span className="font-semibold text-state-danger">Why:</span>{" "}
                  {entry.rejectedReason}
                </p>
                <Link
                  href="/phil/hours"
                  className="inline-flex min-h-[44px] items-center text-xs font-semibold text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
                >
                  Fix &amp; resubmit →
                </Link>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

const HOURS_TONE: Record<TimeEntry["status"], StatusTone> = {
  draft: "neutral",
  submitted: "info",
  approved: "success",
  rejected: "danger",
};

const HOURS_LABEL: Record<TimeEntry["status"], string> = {
  draft: "Draft",
  submitted: "Submitted",
  approved: "Approved",
  rejected: "Rejected",
};

function formatShortDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = new Date(date + "T00:00:00");
  return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

function formatShortHours(decimalHours: number): string {
  if (decimalHours <= 0) return "0h";
  const totalMinutes = Math.round(decimalHours * 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes - hours * 60;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}
