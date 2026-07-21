import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { HoursTabs } from "@/components/admin/HoursTabs";
import { WeeklyHoursCloseoutBoard } from "@/components/admin/WeeklyHoursCloseoutBoard";
import { WeeklyHoursApprovalMobile } from "@/components/admin/WeeklyHoursApprovalMobile";
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
import {
  CostRateHistoryResponseSchema,
  effectiveCostRateOn,
} from "@/domains/cost-rates/schema";

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
  // #760: Hours kill-switch — hide the office surface when the owner turns it off.
  if (!(await isFlagEnabled("hours", session))) notFound();

  // `?week=` is any date inside the desired week (nav links pass a Monday).
  // DEFAULT to the most recent COMPLETE week (last week), not the in-progress
  // current week — the closeout is a pay-run ritual run AFTER a week ends, so
  // it should open on a populated week, not one that only has today's entries.
  // The ← → nav still reaches the current (and future) weeks.
  const sp = await searchParams;
  const todayISO = localDateString(new Date(), BUSINESS_TIMEZONE);
  const lastCompleteWeekStart = addDays(weekStartOf(todayISO), -7);
  const anchor =
    sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week) ? sp.week : lastCompleteWeekStart;
  const weekStart = weekStartOf(anchor);
  const weekEnd = weekEndOf(anchor);
  const prevWeek = addDays(weekStart, -7);
  const nextWeek = addDays(weekStart, 7);
  const isCurrentWeek = weekStart === weekStartOf(todayISO);

  const [{ overview, fetchError }, runsResult] = await Promise.all([
    loadWeek(raw, weekStart, weekEnd),
    loadRuns(raw),
  ]);

  // Worker universe of the week (anyone with an entry or a server-flagged
  // missing day) — the ids we need cost rates for. Built from the same data the
  // closeout uses, so no extra round-trip and no fabricated workers.
  const workerIds = new Set<string>();
  for (const e of overview?.entries ?? []) workerIds.add(e.userId);
  for (const m of overview?.missing ?? []) workerIds.add(m.userId);

  // §5 labour $: /hours is admin-tier, so the office sees labour here. We read
  // the confidential, effective-dated cost rate (api/cost-rates.js, admin-gated)
  // for each worker, resolved to the rate effective on the week's Monday. A
  // leading-hand viewer never reaches this (admin-gated page) and the endpoint
  // 403s them anyway → no rates → the board shows "—" / omits the labour figure.
  const costRatesByWorker = isAdminRole(session.role)
    ? await loadCostRates(raw, [...workerIds], weekStart)
    : {};

  const closeout = buildWeeklyHoursCloseout({
    entries: overview?.entries ?? [],
    missing: overview?.missing ?? [],
    leave: overview?.leave ?? [],
    holidays: overview?.holidays ?? [],
    weekStart,
    todayISO,
    costRatesByWorker,
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
      {/* Section tabs (#415) — navigation chrome only, above all content. */}
      <HoursTabs />

      {/* Phones + narrow tablets: the purpose-built, one-at-a-time approval
          flow (summary readout, "Review each" stepper, per-person cards). It
          fires the SAME approve / reject / reopen endpoints the desktop board
          below uses — no second status-transition path. */}
      <div className="mx-auto w-full max-w-xl lg:hidden">
        <WeeklyHoursApprovalMobile
          closeout={closeout}
          weekNav={{
            prevWeek,
            nextWeek,
            currentWeek: weekStartOf(todayISO),
            isCurrentWeek,
          }}
          canUndo={isAdminRole(session.role)}
          fetchError={fetchError}
        />
      </div>

      {/* Desktop (lg+): the dense pay-run board — the full closeout with the
          payroll export panel. */}
      <div className="mx-auto hidden max-w-4xl space-y-4 lg:block">
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
            worker&rsquo;s phone with the reason.
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

/**
 * §5 labour: the effective LOADED-COST rate (integer cents) per worker for the
 * week, keyed by userId. ADMIN-TIER — the caller has already checked the role,
 * and /api/cost-rates is admin-gated server-side too. One GET per worker (a
 * week is a handful of workers); a worker with no rate is simply absent from the
 * map, so the closeout carries null cost → the board shows "—", never a $0.
 * Fail-soft: a failed fetch drops that worker (understated labour, never a 500).
 * Rates are resolved against the worker's history to the rate effective on the
 * week's Monday, so a back-week is costed at the rate that was effective THEN.
 */
async function loadCostRates(
  cookieValue: string | undefined,
  workerIds: string[],
  weekStart: string,
): Promise<Record<string, number>> {
  if (workerIds.length === 0) return {};
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";

  const pairs = await Promise.all(
    workerIds.map(async (userId): Promise<[string, number] | null> => {
      try {
        const res = await fetch(
          `${base}/api/cost-rates?userId=${encodeURIComponent(userId)}`,
          {
            cache: "no-store",
            headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
          },
        );
        if (!res.ok) return null;
        const parsed = CostRateHistoryResponseSchema.safeParse(await res.json());
        if (!parsed.success) return null;
        const effective = effectiveCostRateOn(parsed.data.history, weekStart);
        if (!effective || effective.costRateCents <= 0) return null;
        return [userId, effective.costRateCents];
      } catch {
        return null;
      }
    }),
  );

  const out: Record<string, number> = {};
  for (const pair of pairs) {
    if (pair) out[pair[0]] = pair[1];
  }
  return out;
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
