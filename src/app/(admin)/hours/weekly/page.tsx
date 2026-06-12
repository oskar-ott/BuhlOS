import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { WeeklyHoursCloseoutBoard } from "@/components/admin/WeeklyHoursCloseoutBoard";
import { WeeklyPayrollExportPanel } from "@/components/admin/WeeklyPayrollExportPanel";
import { notPayrollReadyWorkers } from "@/domains/timesheets/payroll-export";
import { PayrollRunsResponseSchema } from "@/domains/timesheets/schema";
import type { PayrollRun } from "@/domains/timesheets/types";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import { TimeEntryOverviewResponseSchema } from "@/domains/timesheets/schema";
import type { TimeEntryOverviewResponse } from "@/domains/timesheets/types";
import {
  BUSINESS_TIMEZONE,
  addDays,
  localDateString,
  weekEndOf,
  weekStartOf,
} from "@/domains/timesheets/service";
import { formatDateLabel } from "@/domains/timesheets/format";
import { buildWeeklyHoursCloseout } from "@/domains/timesheets/weekly-closeout";

export const dynamic = "force-dynamic";

/**
 * /hours/weekly — the weekly hours closeout / payroll-readiness board.
 *
 * The business closes hours WEEK BY WEEK: workers log day-by-day in Phil
 * (#112's loop), and this is where the office turns those daily entries into
 * a payroll-ready week. Decision-first, not a raw table — it answers, fast:
 * is this week ready, who is blocking it, and what happens next.
 *
 * Read path: ONE existing endpoint — /api/time-entries-overview for the
 * Mon–Sun range (entries + the server's honest missing-day detection).
 * Write path: the SAME approve / reject endpoints the approvals queue uses,
 * via the client board. No new API, no second status-transition code path,
 * no export/Xero side effects from this surface.
 *
 * Cross-ref: docs/hours-weekly-closeout.md (model + honesty rules)
 *            docs/hours-operational-loop.md (the daily loop underneath)
 */
export default async function HoursWeeklyCloseoutPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/hours/weekly");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }

  // `?week=` is any date inside the desired week (nav links pass a Monday);
  // default to the current Sydney week — same convention as /hours.
  const sp = await searchParams;
  const anchor =
    sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week)
      ? sp.week
      : localDateString(new Date(), BUSINESS_TIMEZONE);
  const weekStart = weekStartOf(anchor);
  const weekEnd = weekEndOf(anchor);
  const prevWeek = addDays(weekStart, -7);
  const nextWeek = addDays(weekStart, 7);
  const todayISO = localDateString(new Date(), BUSINESS_TIMEZONE);
  const isCurrentWeek = weekStart === weekStartOf(todayISO);

  const [{ overview, fetchError }, runsResult] = await Promise.all([
    loadWeek(raw, weekStart, weekEnd),
    loadRuns(raw),
  ]);
  const closeout = buildWeeklyHoursCloseout({
    entries: overview?.entries ?? [],
    missing: overview?.missing ?? [],
    leave: overview?.leave ?? [],
    weekStart,
    todayISO,
  });

  return (
    <AdminShell
      title="Hours · weekly closeout"
      breadcrumb={
        <Link
          href="/hours"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Hours overview
        </Link>
      }
    >
      <div className="mx-auto max-w-4xl space-y-4">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>{isCurrentWeek ? "This week" : "Week"}</CardTitle>
              <CardDescription className="mt-1">
                {formatDateLabel(weekStart)} – {formatDateLabel(weekEnd)}
              </CardDescription>
            </div>
            <div className="flex items-center gap-1">
              <WeekNavLink
                week={prevWeek}
                label="Previous week"
                icon={<ArrowLeft aria-hidden="true" className="h-4 w-4" />}
              />
              {!isCurrentWeek ? (
                <Link
                  href={{ pathname: "/hours/weekly", query: { week: weekStartOf(todayISO) } }}
                  className="rounded-card border border-border px-3 py-2 text-xs font-medium text-text hover:border-brand-navy"
                >
                  This week
                </Link>
              ) : null}
              <WeekNavLink
                week={nextWeek}
                label="Next week"
                icon={<ArrowRight aria-hidden="true" className="h-4 w-4" />}
              />
            </div>
          </div>
          <CardDescription className="mt-2">
            Daily entries roll up here for the weekly payroll closeout. Approve or
            reject submitted days in place — rejected days bounce back to the
            worker&rsquo;s Phil with the reason.
          </CardDescription>
        </Card>

        <WeeklyHoursCloseoutBoard closeout={closeout} fetchError={fetchError} canUndo={isAdminRole(session.role)} />

        {/* Committed payroll export (#126) — admin tier only; the endpoint
            itself is admin-gated, so the panel never renders for LH. */}
        {isAdminRole(session.role) ? (
          <WeeklyPayrollExportPanel
            weekStart={weekStart}
            weekEnd={weekEnd}
            weekLabel={`${formatDateLabel(weekStart)} – ${formatDateLabel(weekEnd)}`}
            notReadyWorkers={notPayrollReadyWorkers(closeout.workers)}
            initialRuns={runsResult.runs}
            runsError={runsResult.error}
          />
        ) : null}
      </div>
    </AdminShell>
  );
}

function WeekNavLink({
  week,
  label,
  icon,
}: {
  week: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={{ pathname: "/hours/weekly", query: { week } }}
      aria-label={label}
      title={label}
      className="rounded-card border border-border p-2 text-text-muted hover:border-brand-navy hover:text-text"
    >
      {icon}
    </Link>
  );
}

/** The committed-run log for the panel — fail-soft to an error string. */
async function loadRuns(
  cookieValue: string | undefined
): Promise<{ runs: PayrollRun[]; error: string | null }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  try {
    const res = await fetch(`${base}/api/payroll-runs?limit=8`, {
      cache: "no-store",
      headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
    });
    if (!res.ok) return { runs: [], error: `Runs API returned ${res.status}` };
    const parsed = PayrollRunsResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { runs: [], error: "Unexpected runs response shape" };
    return { runs: [...parsed.data.runs], error: null };
  } catch (err) {
    return { runs: [], error: err instanceof Error ? err.message : "Network error" };
  }
}

async function loadWeek(
  cookieValue: string | undefined,
  fromDate: string,
  toDate: string
): Promise<{ overview: TimeEntryOverviewResponse | null; fetchError: string | null }> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  try {
    const res = await fetch(
      `${base}/api/time-entries-overview?fromDate=${fromDate}&toDate=${toDate}`,
      {
        cache: "no-store",
        headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
      }
    );
    if (!res.ok) {
      return { overview: null, fetchError: `API returned ${res.status}` };
    }
    const parsed = TimeEntryOverviewResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      return { overview: null, fetchError: "Unexpected response shape" };
    }
    return { overview: parsed.data, fetchError: null };
  } catch (err) {
    return {
      overview: null,
      fetchError: err instanceof Error ? err.message : "Network error",
    };
  }
}
