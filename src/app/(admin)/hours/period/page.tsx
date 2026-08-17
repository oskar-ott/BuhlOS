import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { isFlagEnabled } from "../../../../../api/_lib/feature-flags.js";
import { readTimesheetRecipients } from "../../../../../api/_lib/timesheet-email-settings.js";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { HoursTabs } from "@/components/admin/HoursTabs";
import { PayRunCard } from "@/components/admin/PayRunCard";
import { PeriodStatTiles } from "@/components/admin/PeriodStatTiles";
import { PreviewLinksRow } from "@/components/admin/PreviewLinksRow";
import { ReadinessStrip } from "@/components/admin/ReadinessStrip";
import { SendTimesheetsCard } from "@/components/admin/SendTimesheetsCard";
import { WorkerRollupTable } from "@/components/admin/WorkerRollupTable";
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
  type PayPeriodRange,
} from "@/domains/timesheets/pay-period-view";

export const dynamic = "force-dynamic";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * /hours/period — the pay-week payroll page (#131; owner redesign 2026-08-16,
 * "BuhlOS Hours Replica").
 *
 * The weekly board (/hours/weekly) DECIDES days; this page RUNS the pay week:
 * readiness strip → the four headline tiles → the pay-run card (Send to Tia
 * while Xero is out of action; the 3-step batch flow when the Xero flags are
 * on) → the per-worker rollup. Pay runs weekly, Monday to Sunday (#1013) —
 * the fortnight toggle is gone from the UI (the owner's own design); any
 * other range is the Custom… disclosure, a plain GET form.
 *
 * Same engines as before (payroll-boundary ADR #609): the export dry-run rows
 * and the weekly-closeout readiness engine — no second calculation engine.
 * Admin-tier only: the content derives from the admin-only export endpoint.
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
  // #893/#894: the payroll-batch flow rides the xero_connection flag — dark
  // means the PayRunCard simply doesn't render (downloads unaffected).
  const xeroBatchesEnabled = await isFlagEnabled("xero_connection", session);
  // #249: the draft-timesheet SEND rides an independent write flag.
  const xeroExportEnabled = await isFlagEnabled("xero_payroll_export", session);
  // Owner pull 2026-08-15/16: while the Xero push is out of action the pay run
  // is EMAILED to accounts as the period PDF. The recipient list managed on
  // /settings is the switch — ≥1 address → the Send-to-Tia card renders here
  // (and the phone closeout ends the same way); empty → it disappears and
  // Xero resumes. No feature flag, no env var.
  const accountsEmailConfigured = (await readTimesheetRecipients()).length > 0;
  if (!isAdminRole(session.role)) {
    redirect("/hours/weekly");
  }

  const sp = await searchParams;
  const today = localDateString(new Date(), BUSINESS_TIMEZONE);

  // Resolve the range. Pay runs WEEKLY, Monday to Sunday — a `?period=`
  // param other than a valid custom range resolves to the week around the
  // anchor (the old fortnight links land on the week of their anchor).
  const requestedCustom = sp.period === "custom";
  const customValid = requestedCustom && isValidRange(sp.from ?? "", sp.to ?? "");
  const anchorParam = sp.anchor && ISO.test(sp.anchor) ? sp.anchor : today;

  let range: PayPeriodRange;
  let mode: "week" | "custom";
  if (customValid) {
    range = { fromDate: sp.from!, toDate: sp.to! };
    mode = "custom";
  } else {
    range = payPeriodRangeFor("week", anchorParam);
    mode = "week";
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
  const unmapped = rollup.summary.unmappedWorkerCount;

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
              <CardTitle>Pay week</CardTitle>
              <CardDescription className="mt-1">
                {mode === "week" ? `${rangeLabel} · Monday to Sunday` : rangeLabel}
              </CardDescription>
            </div>
            {mode === "week" ? (
              <div className="flex flex-wrap items-center gap-1">
                <PeriodNavLink
                  anchor={shiftAnchor("week", navAnchor, -1)}
                  label="Previous week"
                  icon={<ArrowLeft aria-hidden="true" className="h-4 w-4" />}
                />
                <Link
                  href={{ pathname: "/hours/period", query: { period: "week" } }}
                  className="rounded-card border border-border px-3 py-2 text-xs font-medium text-text hover:border-brand-navy"
                >
                  This week
                </Link>
                <PeriodNavLink
                  anchor={shiftAnchor("week", navAnchor, 1)}
                  label="Next week"
                  icon={<ArrowRight aria-hidden="true" className="h-4 w-4" />}
                />
              </div>
            ) : null}
          </div>

          {/* Custom range — a plain GET form behind a no-JS disclosure. */}
          <details open={mode === "custom"} className="mt-3">
            <summary className="inline-block cursor-pointer list-none rounded-card border border-border px-3 py-2 text-xs font-medium text-text-muted hover:border-brand-navy hover:text-text [&::-webkit-details-marker]:hidden">
              Custom range…
            </summary>
            <form
              method="get"
              action="/hours/period"
              className="mt-3 flex flex-wrap items-end gap-2 border-t border-border pt-3"
            >
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
                Apply
              </button>
            </form>
          </details>
          {customFellBack ? (
            <p className="mt-2 text-xs text-amber-900">
              That custom range wasn&rsquo;t valid — showing this week instead.
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
            <ReadinessStrip
              fullyClosed={readiness.fullyClosed}
              workersNeedingAction={readiness.workersNeedingAction}
              weeksTotal={readiness.weeksTotal}
            />

            <PeriodStatTiles summary={rollup.summary} />

            {accountsEmailConfigured ? (
              <SendTimesheetsCard
                fromDate={range.fromDate}
                toDate={range.toDate}
                periodLabel={rangeLabel}
                notClosed={!readiness.fullyClosed}
                workersNeedingAction={readiness.workersNeedingAction}
              />
            ) : null}

            {xeroBatchesEnabled ? (
              <PayRunCard
                fromDate={range.fromDate}
                toDate={range.toDate}
                notClosed={!readiness.fullyClosed}
                exportEnabled={xeroExportEnabled}
              />
            ) : (
              /* No batch flow on this deployment — the read-only previews
                 still need a home (the dryRun=1 invariant lives on). */
              <Card>
                <p className="text-xs text-text-muted">
                  <PreviewLinksRow fromDate={range.fromDate} toDate={range.toDate} />
                </p>
              </Card>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between px-1">
                <h2 className="font-display text-sm font-semibold text-text">By worker</h2>
                <span className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
                  {rollup.summary.workerCount}{" "}
                  {rollup.summary.workerCount === 1 ? "worker" : "workers"}
                  {unmapped > 0 ? ` · ${unmapped} without a Xero id` : " · all Xero ids set"}
                </span>
              </div>
              <WorkerRollupTable rollup={rollup} actions={actions} />
            </div>
          </>
        )}
      </div>
    </AdminShell>
  );
}

function PeriodNavLink({
  anchor,
  label,
  icon,
}: {
  anchor: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={{ pathname: "/hours/period", query: { period: "week", anchor } }}
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
