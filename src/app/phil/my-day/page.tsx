import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { PhilShell } from "@/components/phil/PhilShell";
import { AttentionBanner } from "@/components/ui/AttentionBanner";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { LogHoursSheet } from "@/components/phil/LogHoursSheet";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { TimeEntryListResponseSchema } from "@/domains/timesheets/schema";
import type { TimeEntry } from "@/domains/timesheets/types";
import { BUSINESS_TIMEZONE, localDateString } from "@/domains/timesheets/service";

export const dynamic = "force-dynamic";

/**
 * /phil/my-day — the Phase B Phil home that replaces the placeholder
 * /v2/phil. Legacy /phil and /my-day continue to serve legacy until the
 * Phase C cutover; this is the parallel new surface that field workers
 * use once Phase B ships.
 *
 * Cross-ref:
 *   docs/rebuild-audit/13-ui-information-architecture.md §Phil/Today
 *   docs/rebuild-audit/19-phase-b-hours-implementation-brief.md §Phil surface
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

  const { todayEntry, recentEntries, fetchError } = await loadEntries(raw);

  // Bible vNext §16.3 quick-win: surface the most recent rejected entry
  // at the top of My day so the worker can act in five seconds. Only one
  // banner stacks — §13 forbids more than one AttentionBanner per screen.
  const rejectedEntry = recentEntries.find(
    (e) => e.status === "rejected" && e.rejectedReason
  );

  return (
    <PhilShell title="My day">
      <div className="space-y-4">
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
                className="underline decoration-rose-400 decoration-2 underline-offset-2 hover:text-rose-950"
              >
                Fix &amp; resubmit →
              </Link>
            }
          />
        ) : null}

        <LogHoursSheet initialTodayEntry={todayEntry} recentEntries={recentEntries} />

        {fetchError ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Couldn&rsquo;t load recent entries</CardTitle>
            <CardDescription className="text-amber-900">
              {fetchError}. You can still submit a new entry — it&rsquo;ll appear here once
              we&rsquo;re back online.
            </CardDescription>
          </Card>
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
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="font-medium text-text">{formatShortDate(entry.date)}</span>
              <span className="text-text-muted">{formatShortHours(entry.totalHours)}</span>
              <StatusChip tone={HOURS_TONE[entry.status]}>
                {HOURS_LABEL[entry.status]}
              </StatusChip>
            </div>
            {isRejected ? (
              <p className="mt-1 text-xs leading-snug text-rose-800">
                <span className="font-semibold">Why:</span>{" "}
                {entry.rejectedReason}{" "}
                <Link
                  href="/phil/hours"
                  className="ml-1 underline decoration-rose-400 decoration-2 underline-offset-2"
                >
                  Fix &amp; resubmit
                </Link>
              </p>
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
