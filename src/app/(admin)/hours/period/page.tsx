import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { EmptyState } from "@/components/ui/EmptyState";
import { AttentionBanner } from "@/components/ui/AttentionBanner";
import { HoursTabs } from "@/components/admin/HoursTabs";
import { PeriodPayrollExport } from "@/components/admin/PeriodPayrollExport";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import { TimeEntryOverviewResponseSchema } from "@/domains/timesheets/schema";
import {
  BUSINESS_TIMEZONE,
  localDateString,
  weekEndOf,
  weekStartOf,
} from "@/domains/timesheets/service";
import { formatDateLabel } from "@/domains/timesheets/format";
import {
  buildWeeklyHoursCloseout,
  type WeeklyHoursCloseout,
} from "@/domains/timesheets/weekly-closeout";
import { buildPayPeriodRollup } from "@/domains/timesheets/pay-period-rollup";
import {
  isValidRange,
  payPeriodRangeFor,
  payPeriodWeekStarts,
  shiftAnchor,
  summarisePeriodReadiness,
  toPayPeriodRows,
  workerActionMap,
  type PayPeriodKind,
  type PayPeriodRange,
} from "@/domains/timesheets/pay-period-view";

export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * /hours/period — the Xero-ready payroll preview across a pay period (#131).
 *
 * The weekly board (/hours/weekly) closes ONE Mon–Sun week; pay runs span
 * periods (fortnightly pay, "what did we approve this fortnight?"). This is
 * that view: pick a period, see approved hours rolled up by worker with the
 * ordinary/overtime split, what isn't yet in a committed run, and which
 * workers have no Xero employee id — the office's pre-push check.
 *
 * NO Xero here (payroll-boundary ADR #609): it reads the EXISTING export
 * dry-run rows and reuses the weekly-closeout engine for readiness. No second
 * calculation engine, no writes, no OAuth. Earnings classes are ordinary +
 * overtime only — travel/allowance/earnings-rate ids are deferred (#129/#611),
 * not faked.
 *
 * Admin-tier only: the content derives from the admin-only export endpoint, so
 * leading hands are sent to the board they can act on.
 */
export default async function HoursPeriodPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; anchor?: string; from?: string; to?: string }>;
}) {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/hours/period");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  // #760: Hours kill-switch — hide the office surface when the owner turns it off.
  if (!(await isFlagEnabled("hours", session))) notFound();
  if (!isAdminRole(session.role)) {
    redirect("/hours/weekly");
  }

  const sp = await searchParams;
  const today = localDateString(new Date(), BUSINESS_TIMEZONE);

  // Resolve the period. Custom needs a valid ordered range, else we fall back
  // to a fortnight and say so. Week/fortnight anchor on a date in the last week.
  const requestedCustom = sp.period === "custom";
  const customValid = requestedCustom && isValidRange(sp.from ?? "", sp.to ?? "");
  const kind: PayPeriodKind = sp.period === "week" ? "week" : "fortnight";
  const anchorParam = sp.anchor && ISO.test(sp.anchor) ? sp.anchor : today;

  let range: PayPeriodRange;
  let mode: "week" | "fortnight" | "custom";
  if (customValid) {
    range = { fromDate: sp.from!, toDate: sp.to! };
    mode = "custom";
  } else {
    range = payPeriodRangeFor(kind, anchorParam);
    mode = kind;
  }
  const customFellBack = requestedCustom && !customValid;

  const navAnchor = weekStartOf(range.toDate);
  const weekStarts = payPeriodWeekStarts(range);

  // Two existing engines, fetched together: per-week closeouts (readiness) and
  // the export dry-run rows (approved totals + OT split + export/mapping flags).
  const [weekResults, exportResult] = await Promise.all([
    Promise.all(weekStarts.map((ws) => loadWeekCloseout(raw, ws, today))),
    loadExportRows(raw, range),
  ]);

  const closeouts = weekResults
    .map((r) => r.closeout)
    .filter((c): c is WeeklyHoursCloseout => c !== null);
  const weekError = weekResults.find((r) => r.error)?.error ?? null;
  const fetchError = exportResult.error ?? weekError;

  const rollup = buildPayPeriodRollup(exportResult.rows, range);
  const readiness = summarisePeriodReadiness(closeouts);
  const actions = workerActionMap(closeouts);

  const rangeLabel = `${formatDateLabel(range.fromDate)} – ${formatDateLabel(range.toDate)}`;
  // Finalise gates must match the SERVER's eligible-row semantics: the POST
  // finalise blocks on unmapped workers among NOT-YET-EXPORTED rows only (never
  // period-wide). Scope the UI counts the same way so the button is never
  // stricter than the endpoint (an already-exported, unmapped worker must not
  // disable a legitimate new-hours run).
  const eligibleWorkers = rollup.workers.filter((w) => w.unexportedApprovedHours > 0);
  const eligibleWorkerCount = eligibleWorkers.length;
  const unmappedEligibleWorkerCount = eligibleWorkers.filter((w) => !w.xeroMapped).length;

  return (
    <AdminShell
      title="Hours · pay period"
      breadcrumb={
        <Link
          href="/hours"
          className="underline decoration-accent-yellow decoration-2 underline-offset-2"
        >
          ← Hours overview
        </Link>
      }
    >
      <HoursTabs />
      <div className="mx-auto max-w-4xl space-y-4">
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Pay period</CardTitle>
              <CardDescription className="mt-1">{rangeLabel}</CardDescription>
            </div>
            <div className="flex items-center gap-1">
              <PeriodModeLink mode="week" current={mode} anchor={navAnchor} label="Week" />
              <PeriodModeLink mode="fortnight" current={mode} anchor={navAnchor} label="Fortnight" />
            </div>
          </div>

          {mode !== "custom" ? (
            <div className="mt-3 flex items-center gap-1">
              <PeriodNavLink
                period={mode}
                anchor={shiftAnchor(mode, navAnchor, -1)}
                label={`Previous ${mode}`}
                icon={<ArrowLeft aria-hidden="true" className="h-4 w-4" />}
              />
              <Link
                href={{ pathname: "/hours/period", query: { period: mode } }}
                className="rounded-card border border-border px-3 py-2 text-xs font-medium text-text hover:border-brand-navy"
              >
                {mode === "week" ? "This week" : "This fortnight"}
              </Link>
              <PeriodNavLink
                period={mode}
                anchor={shiftAnchor(mode, navAnchor, 1)}
                label={`Next ${mode}`}
                icon={<ArrowRight aria-hidden="true" className="h-4 w-4" />}
              />
            </div>
          ) : null}

          {/* Custom range — a plain GET form, no client JS. */}
          <form method="get" action="/hours/period" className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="period" value="custom" />
            <label htmlFor="period-from" className="text-xs text-text-muted">
              From
              <input
                id="period-from"
                type="date"
                name="from"
                defaultValue={range.fromDate}
                className="mt-1 block rounded-card border border-border px-2 py-1.5 text-sm text-text"
              />
            </label>
            <label htmlFor="period-to" className="text-xs text-text-muted">
              To
              <input
                id="period-to"
                type="date"
                name="to"
                defaultValue={range.toDate}
                className="mt-1 block rounded-card border border-border px-2 py-1.5 text-sm text-text"
              />
            </label>
            <button
              type="submit"
              className="rounded-card border border-border px-3 py-2 text-xs font-medium text-text hover:border-brand-navy"
            >
              Apply custom range
            </button>
          </form>

          <CardDescription className="mt-3">
            Approved hours only, rolled up for payroll. Ordinary and overtime
            only — this is the pre-Xero preview; no hours are sent anywhere from
            here. Decide submitted or missing days on the{" "}
            <Link
              href="/hours/weekly"
              className="underline decoration-accent-yellow decoration-2 underline-offset-2"
            >
              weekly closeout board
            </Link>
            .
          </CardDescription>
          {customFellBack ? (
            <p className="mt-2 text-xs text-amber-900">
              That custom range wasn&rsquo;t valid — showing this fortnight instead.
            </p>
          ) : null}
        </Card>

        {fetchError ? (
          <Card>
            <CardTitle>Couldn&rsquo;t load this period</CardTitle>
            <CardDescription className="mt-1">
              {fetchError}. Reload the page to try again.
            </CardDescription>
          </Card>
        ) : rollup.workers.length === 0 ? (
          <EmptyState
            title="No approved hours in this period"
            description={
              readiness.workersNeedingAction > 0
                ? `${readiness.workersNeedingAction} worker(s) have undecided days — approve them on the weekly board and they'll appear here.`
                : "Nothing has been approved for these dates yet."
            }
            action={
              <Link
                href="/hours/weekly"
                className="rounded-card border border-border px-3 py-2 text-sm font-medium text-text hover:border-brand-navy"
              >
                Open weekly closeout
              </Link>
            }
          />
        ) : (
          <>
            {!readiness.fullyClosed ? (
              <AttentionBanner
                chip="Not closed"
                tone="warning"
                title={`${readiness.workersNeedingAction} worker(s) still have undecided days in this period.`}
                description="Approved totals below will change once those days are decided."
                cta={
                  <Link
                    href="/hours/weekly"
                    className="underline decoration-accent-yellow decoration-2 underline-offset-2"
                  >
                    Open the weekly closeout board →
                  </Link>
                }
              />
            ) : null}

            <Card>
              <CardTitle>Approved this period</CardTitle>
              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Metric label="Approved hours" value={rollup.summary.approvedHours} />
                <Metric label="Ordinary" value={rollup.summary.ordinaryHours} />
                <Metric label="Overtime" value={rollup.summary.overtimeHours} />
                <Metric label="Not yet exported" value={rollup.summary.unexportedApprovedHours} />
              </div>
              <CardDescription className="mt-3">
                {rollup.summary.workerCount} worker(s) ·{" "}
                {rollup.summary.unmappedWorkerCount > 0 ? (
                  <span className="text-amber-900">
                    {rollup.summary.unmappedWorkerCount} without a Xero employee id
                  </span>
                ) : (
                  "all have a Xero employee id set"
                )}
                . &ldquo;Not yet exported&rdquo; = approved hours not in a committed payroll run.
              </CardDescription>
            </Card>

            <PeriodPayrollExport
              fromDate={range.fromDate}
              toDate={range.toDate}
              unexportedApprovedHours={rollup.summary.unexportedApprovedHours}
              eligibleWorkerCount={eligibleWorkerCount}
              unmappedEligibleWorkerCount={unmappedEligibleWorkerCount}
              notClosed={!readiness.fullyClosed}
            />

            <Card className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-border text-xs uppercase tracking-wide text-text-muted">
                    <th className="px-2 py-2 font-medium">Worker</th>
                    <th className="px-2 py-2 text-right font-medium">Approved</th>
                    <th className="px-2 py-2 text-right font-medium">Ordinary</th>
                    <th className="px-2 py-2 text-right font-medium">Overtime</th>
                    <th className="px-2 py-2 text-right font-medium">Not exported</th>
                    <th className="px-2 py-2 font-medium">Xero id</th>
                    <th className="px-2 py-2 font-medium">Readiness</th>
                  </tr>
                </thead>
                <tbody>
                  {rollup.workers.map((w) => {
                    const action = actions.get(w.workerId);
                    const needsAction = action?.needsAction ?? false;
                    return (
                      <tr key={w.workerId} className="border-b border-border/60">
                        <td className="px-2 py-2 font-medium text-text">
                          {w.workerName}
                          <span className="block text-xs font-normal text-text-muted">
                            {w.approvedDayCount} day(s)
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-text">
                          {w.approvedHours}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-text-muted">
                          {w.ordinaryHours}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums text-text-muted">
                          {w.overtimeHours}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {w.unexportedApprovedHours > 0 ? (
                            <span className="text-amber-900">{w.unexportedApprovedHours}</span>
                          ) : (
                            <span className="text-text-muted">0</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {w.xeroMapped ? (
                            <span className="text-xs text-text-muted">set</span>
                          ) : (
                            <Pill tone="warning">No Xero id</Pill>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {needsAction ? (
                            <Pill tone="warning">
                              Needs action{action ? ` (${action.blockingWeeks} wk)` : ""}
                            </Pill>
                          ) : (
                            <Pill tone="success">Ready</Pill>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          </>
        )}
      </div>
    </AdminShell>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-card border border-border bg-surface-subtle px-3 py-2">
      <div className="text-xs text-text-muted">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-text">{value}</div>
    </div>
  );
}

function PeriodModeLink({
  mode,
  current,
  anchor,
  label,
}: {
  mode: "week" | "fortnight";
  current: "week" | "fortnight" | "custom";
  anchor: string;
  label: string;
}) {
  const active = current === mode;
  return (
    <Link
      href={{ pathname: "/hours/period", query: { period: mode, anchor } }}
      aria-current={active ? "true" : undefined}
      className={
        active
          ? "rounded-card border border-brand-navy bg-brand-navy px-3 py-2 text-xs font-semibold text-text-inverse"
          : "rounded-card border border-border px-3 py-2 text-xs font-medium text-text hover:border-brand-navy"
      }
    >
      {label}
    </Link>
  );
}

function PeriodNavLink({
  period,
  anchor,
  label,
  icon,
}: {
  period: "week" | "fortnight";
  anchor: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={{ pathname: "/hours/period", query: { period, anchor } }}
      aria-label={label}
      title={label}
      className="rounded-card border border-border p-2 text-text-muted hover:border-brand-navy hover:text-text"
    >
      {icon}
    </Link>
  );
}

/** One Mon–Sun closeout for readiness — fail-soft to an error string. */
async function loadWeekCloseout(
  cookieValue: string | undefined,
  weekStart: string,
  todayISO: string,
): Promise<{ closeout: WeeklyHoursCloseout | null; error: string | null }> {
  const base = await apiBase();
  const weekEnd = weekEndOf(weekStart);
  try {
    const res = await fetch(
      `${base}/api/time-entries-overview?fromDate=${weekStart}&toDate=${weekEnd}`,
      {
        cache: "no-store",
        headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
      },
    );
    if (!res.ok) return { closeout: null, error: `Hours API returned ${res.status}` };
    const parsed = TimeEntryOverviewResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { closeout: null, error: "Unexpected hours response shape" };
    const closeout = buildWeeklyHoursCloseout({
      entries: parsed.data.entries,
      missing: parsed.data.missing,
      leave: parsed.data.leave ?? [],
      holidays: parsed.data.holidays ?? [],
      weekStart,
      todayISO,
    });
    return { closeout, error: null };
  } catch (err) {
    return { closeout: null, error: err instanceof Error ? err.message : "Network error" };
  }
}

/** The approved export dry-run rows for the whole period — fail-soft. */
async function loadExportRows(
  cookieValue: string | undefined,
  range: PayPeriodRange,
): Promise<{ rows: ReturnType<typeof toPayPeriodRows>; error: string | null }> {
  const base = await apiBase();
  try {
    const res = await fetch(
      `${base}/api/time-entries-export?dryRun=1&format=json&status=approved` +
        `&fromDate=${range.fromDate}&toDate=${range.toDate}`,
      {
        cache: "no-store",
        headers: cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined,
      },
    );
    if (!res.ok) return { rows: [], error: `Export API returned ${res.status}` };
    return { rows: toPayPeriodRows(await res.json()), error: null };
  } catch (err) {
    return { rows: [], error: err instanceof Error ? err.message : "Network error" };
  }
}

async function apiBase(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  return host ? `${proto}://${host}` : "http://localhost:3000";
}
