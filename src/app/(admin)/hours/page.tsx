import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { ArrowLeft, ArrowRight, Download, HardHat, UserX } from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { UnderConstructionPanel } from "@/components/ui/UnderConstructionPanel";
import { cn } from "@/lib/cn";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import {
  TimeEntryListResponseSchema,
  TimeEntryOverviewResponseSchema,
  PayrollExportPreviewResponseSchema,
  TodayPulseResponseSchema,
} from "@/domains/timesheets/schema";
import {
  BUSINESS_TIMEZONE,
  addDays,
  localDateString,
  summariseMissing,
  weekEndOf,
  weekStartOf,
} from "@/domains/timesheets/service";
import { formatDateLabel, formatHoursLabel } from "@/domains/timesheets/format";
import type {
  TimeEntry,
  TimeEntryOverviewResponse,
  PayrollExportPreviewResponse,
  TodayPulseResponse,
} from "@/domains/timesheets/types";

export const dynamic = "force-dynamic";

/**
 * /hours — admin hours overview.
 *
 * Three live blocks, all real data on the existing legacy endpoints:
 *   1. Queue depth (pending / approved / rejected) — /api/time-entries?scope=approver
 *   2. This week's rollup — /api/time-entries-overview (totals by job/worker/
 *      status + the server's missing-hours list). Week-navigable via ?week=.
 *   3. Payroll export — a safe dry-run preview from /api/time-entries-export
 *      (?dryRun=1, no stamping) plus a Download CSV link to the real export.
 *
 * Only genuinely-unbuilt flows stay behind an UNDER CONSTRUCTION panel:
 * one-tap "approve the whole week" and a direct Xero push (CSV is the Xero
 * path today; we never fake the integration).
 */
export default async function HoursOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const cookieStore = await cookies();
  const raw = cookieStore.get(SESSION_COOKIE)?.value;
  const session = decodeSessionCookie(raw);
  if (!session?.role) {
    redirect("/v2/login?next=/hours");
  }
  if (!canAccessSurface(session.role, "admin")) {
    redirect("/v2/login");
  }
  const isAdmin = isAdminRole(session.role);

  // Which week are we looking at? `?week=` is any date inside the desired week
  // (the prev/next links pass a Monday); default to the current Sydney week.
  const sp = await searchParams;
  const anchor =
    sp.week && /^\d{4}-\d{2}-\d{2}$/.test(sp.week)
      ? sp.week
      : localDateString(new Date(), BUSINESS_TIMEZONE);
  const weekStart = weekStartOf(anchor);
  const weekEnd = weekEndOf(anchor);
  const prevWeek = addDays(weekStart, -7);
  const nextWeek = addDays(weekStart, 7);
  const today = localDateString(new Date(), BUSINESS_TIMEZONE);
  const thisWeekStart = weekStartOf(today);
  const isCurrentWeek = weekStart === thisWeekStart;

  const { pending, approved, rejected, overview, exportPreview, pulse, errors } =
    await loadHours(raw, weekStart, weekEnd, today, isAdmin);

  const missing = overview ? summariseMissing(overview.missing) : null;

  return (
    <AdminShell title="Hours">
      <div className="mx-auto max-w-4xl space-y-4">
        {errors.length > 0 ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Some data couldn&rsquo;t load</CardTitle>
            <CardDescription className="text-amber-900">
              {errors.join(" · ")}. The rest of the page still reflects what
              loaded.
            </CardDescription>
          </Card>
        ) : null}

        {/* ── End-of-day closeout (today) ───────────────────────────── */}
        <TodayCloseout pulse={pulse} today={today} />

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <QueueCard
            label="Pending approval"
            count={pending.length}
            tone="info"
            href="/hours/approvals"
            description="Worker entries waiting for an admin or leading-hand decision."
          />
          <QueueCard
            label="Approved (this view)"
            count={approved.length}
            tone="success"
            description="Already-approved entries returned by the approver queue."
          />
          <QueueCard
            label="Rejected (this view)"
            count={rejected.length}
            tone="danger"
            description="Workers see the reason in Phil and can edit + resubmit."
          />
        </div>

        {/* ── This week ─────────────────────────────────────────────── */}
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
                  href={{ pathname: "/hours", query: { week: thisWeekStart } }}
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

          {overview ? (
            <WeekRollup overview={overview} missing={missing!} />
          ) : (
            <CardDescription className="mt-4">
              Weekly rollup unavailable — see the notice above.
            </CardDescription>
          )}
        </Card>

        {/* ── Payroll export (admin only) ───────────────────────────── */}
        {isAdmin ? (
          <PayrollExportCard
            preview={exportPreview}
            weekStart={weekStart}
            weekEnd={weekEnd}
          />
        ) : null}

        {/* ── Approval queue CTA ────────────────────────────────────── */}
        <Card>
          <CardTitle>Review the queue</CardTitle>
          <CardDescription className="mt-1">
            Approve or reject submitted entries one at a time. Leading hands see
            only entries on jobs they run.
          </CardDescription>
          <div className="mt-4">
            <Link
              href="/hours/approvals"
              className="inline-flex items-center rounded-card bg-brand-navy px-5 py-3 text-sm font-medium text-text-inverse hover:bg-accent-ink"
            >
              Open approval queue →
            </Link>
          </div>
        </Card>

        <UnderConstructionPanel
          feature="One-tap weekly approve · direct Xero push"
          description="Per-entry approve and payroll CSV export are live above. Approving a worker's whole week in a single tap, and a direct API push into Xero (the CSV is the Xero path for now — we don't fake the integration) still live on legacy /admin/hours."
          legacyHref="/admin/hours"
          legacyLabel="Legacy /admin/hours for one-tap weekly approve"
        />
      </div>
    </AdminShell>
  );
}

/**
 * End-of-day closeout — today's live hours pulse so the office can answer
 * "is today's labour accounted for?" before they leave. The verdict is
 * deliberately strict: a day is only "ready to close" when nothing is still
 * pending approval *and* nothing is sitting in draft (logged but not
 * submitted). Drafts are the silent gap — they never reach the approval
 * queue, so the closeout is the one place they surface.
 */
function TodayCloseout({
  pulse,
  today,
}: {
  pulse: TodayPulseResponse | null;
  today: string;
}) {
  if (!pulse) {
    return (
      <Card>
        <div className="flex items-center gap-2">
          <HardHat aria-hidden="true" className="h-5 w-5 text-text-muted" />
          <CardTitle>Today&rsquo;s closeout</CardTitle>
        </div>
        <CardDescription className="mt-1">
          Live snapshot unavailable right now. The queue and weekly rollup below
          reflect the same entries.
        </CardDescription>
      </Card>
    );
  }

  const h = pulse.hours;
  const needsApproval = h.pendingCount > 0;
  const hasDrafts = h.draftCount > 0;
  const anyActivity =
    h.crewOnSite > 0 ||
    h.submittedCount > 0 ||
    h.approvedCount > 0 ||
    h.draftCount > 0;
  const ready = anyActivity && !needsApproval && !hasDrafts;

  const verdict = !anyActivity
    ? {
        tone: "neutral" as const,
        text: "No hours logged yet today. Nothing to close — check back as crew log off.",
      }
    : ready
      ? {
          tone: "success" as const,
          text: "Every logged hour is approved. Today is ready to close.",
        }
      : {
          tone: "warning" as const,
          text: [
            needsApproval
              ? `${h.pendingCount} ${h.pendingCount === 1 ? "entry" : "entries"} still awaiting approval`
              : null,
            hasDrafts
              ? `${h.draftCount} ${h.draftCount === 1 ? "draft" : "drafts"} logged but not submitted`
              : null,
          ]
            .filter(Boolean)
            .join(" · ") + " — clear these before close.",
        };

  return (
    <Card className="border-l-4 border-l-brand-navy">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <HardHat aria-hidden="true" className="h-5 w-5 text-brand-navy" />
          <div>
            <CardTitle>Today&rsquo;s closeout</CardTitle>
            <CardDescription>{formatDateLabel(today)}</CardDescription>
          </div>
        </div>
        <Pill tone={h.crewOnSite > 0 ? "info" : "neutral"}>
          {h.crewOnSite} {h.crewOnSite === 1 ? "worker" : "crew"} on site
        </Pill>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <CloseoutStat
          label="Pending approval"
          primary={String(h.pendingCount)}
          secondary={formatHoursLabel(h.submittedTotal)}
          tone={needsApproval ? "warning" : "neutral"}
        />
        <CloseoutStat
          label="Approved"
          primary={String(h.approvedCount)}
          secondary={formatHoursLabel(h.approvedTotal)}
          tone={h.approvedCount > 0 ? "success" : "neutral"}
        />
        <CloseoutStat
          label="Not submitted"
          primary={String(h.draftCount)}
          secondary={h.draftCount > 0 ? "needs a nudge" : "all submitted"}
          tone={hasDrafts ? "warning" : "neutral"}
        />
      </div>

      <p
        className={cn(
          "mt-4 rounded-card px-3 py-2 text-sm",
          verdict.tone === "success" && "bg-emerald-50 text-emerald-900",
          verdict.tone === "warning" && "bg-amber-50 text-amber-900",
          verdict.tone === "neutral" && "bg-surface-subtle text-text-muted"
        )}
      >
        {verdict.text}
      </p>

      {needsApproval ? (
        <div className="mt-3">
          <Link
            href="/hours/approvals"
            className="inline-flex items-center rounded-card bg-brand-navy px-4 py-2 text-sm font-medium text-text-inverse hover:bg-accent-ink"
          >
            Review {h.pendingCount} pending →
          </Link>
        </div>
      ) : null}
    </Card>
  );
}

function CloseoutStat({
  label,
  primary,
  secondary,
  tone,
}: {
  label: string;
  primary: string;
  secondary: string;
  tone: "neutral" | "success" | "warning";
}) {
  return (
    <div
      className={cn(
        "rounded-card border px-3 py-2",
        tone === "success" && "border-emerald-200 bg-emerald-50",
        tone === "warning" && "border-amber-200 bg-amber-50",
        tone === "neutral" && "border-border bg-surface"
      )}
    >
      <p className="font-display text-xs uppercase tracking-widest text-text-muted">
        {label}
      </p>
      <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-text">
        {primary}
      </p>
      <p className="text-xs text-text-muted">{secondary}</p>
    </div>
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
      href={{ pathname: "/hours", query: { week } }}
      aria-label={label}
      title={label}
      className="rounded-card border border-border p-2 text-text-muted hover:border-brand-navy hover:text-text"
    >
      {icon}
    </Link>
  );
}

function WeekRollup({
  overview,
  missing,
}: {
  overview: TimeEntryOverviewResponse;
  missing: ReturnType<typeof summariseMissing>;
}) {
  const { totals } = overview;
  const statusOrder = ["submitted", "approved", "rejected", "draft"] as const;
  const statusTones = {
    submitted: "info",
    approved: "success",
    rejected: "danger",
    draft: "neutral",
  } as const;

  return (
    <div className="mt-4 space-y-5">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <p className="font-display text-3xl font-semibold text-text">
            {formatHoursLabel(totals.totalHours)}
          </p>
          <p className="text-xs uppercase tracking-widest text-text-muted">
            Total logged
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {statusOrder.map((s) => (
            <Pill key={s} tone={statusTones[s]}>
              {totals.byStatus[s]} {s}
            </Pill>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <RollupTable
          title="By job"
          empty="No hours logged against a job this week."
          rows={totals.byJob.map((j) => ({
            key: j.jobId ?? "__internal__",
            label: j.jobName,
            value: formatHoursLabel(j.hours),
          }))}
        />
        <RollupTable
          title="By worker"
          empty="No worker has logged hours this week."
          rows={totals.byUser.map((u) => ({
            key: u.userId,
            label: u.role ? `${u.userName} · ${u.role}` : u.userName,
            value: formatHoursLabel(u.hours),
          }))}
        />
      </div>

      {/* Missing hours — the server's detection, grouped per worker. */}
      <div>
        <p className="font-display text-xs uppercase tracking-widest text-text-muted">
          Missing hours
        </p>
        {missing.workerCount === 0 ? (
          <p className="mt-2 text-sm text-text-muted">
            Every assigned crew member has logged their weekday hours for this
            range. Nothing to chase.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {missing.byWorker.map((w) => (
              <li
                key={w.userId}
                className="flex items-center justify-between gap-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm"
              >
                <span className="flex items-center gap-2 text-amber-900">
                  <UserX aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span className="font-medium">{w.userName}</span>
                  {w.role ? (
                    <span className="text-amber-700">· {w.role}</span>
                  ) : null}
                </span>
                <span
                  className="text-amber-800"
                  title={w.dates.map((d) => formatDateLabel(d)).join(", ")}
                >
                  {w.dates.length} {w.dates.length === 1 ? "day" : "days"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RollupTable({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: ReadonlyArray<{ key: string; label: string; value: string }>;
  empty: string;
}) {
  return (
    <div>
      <p className="font-display text-xs uppercase tracking-widest text-text-muted">
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">{empty}</p>
      ) : (
        <ul className="mt-2 divide-y divide-border rounded-card border border-border">
          {rows.map((r) => (
            <li
              key={r.key}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="truncate text-text">{r.label}</span>
              <span className="shrink-0 font-medium tabular-nums text-text">
                {r.value}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PayrollExportCard({
  preview,
  weekStart,
  weekEnd,
}: {
  preview: PayrollExportPreviewResponse | null;
  weekStart: string;
  weekEnd: string;
}) {
  const exportHref = `/api/time-entries-export?fromDate=${weekStart}&toDate=${weekEnd}`;
  const summary = preview?.summary ?? null;
  const hasRows = (summary?.rowCount ?? 0) > 0;

  return (
    <Card>
      <CardTitle>Payroll export</CardTitle>
      <CardDescription className="mt-1">
        Approved hours for {formatDateLabel(weekStart)} – {formatDateLabel(weekEnd)},
        one row per job allocation — the format Xero and most payroll systems
        import directly.
      </CardDescription>

      {summary ? (
        hasRows ? (
          <div className="mt-3 space-y-3">
            <div className="flex flex-wrap gap-2">
              <Pill tone="success">{summary.rowCount} rows</Pill>
              <Pill tone="info">{formatHoursLabel(summary.totalHours)}</Pill>
              <Pill tone="neutral">
                {summary.workerCount}{" "}
                {summary.workerCount === 1 ? "worker" : "workers"}
              </Pill>
              <Pill tone="neutral">
                {summary.jobCount} {summary.jobCount === 1 ? "job" : "jobs"}
              </Pill>
            </div>
            <a
              href={exportHref}
              className="inline-flex items-center gap-2 rounded-card bg-brand-navy px-5 py-3 text-sm font-medium text-text-inverse hover:bg-accent-ink"
            >
              <Download aria-hidden="true" className="h-4 w-4" />
              Download payroll CSV
            </a>
            <p className="text-xs text-text-muted">
              Downloading marks these entries as exported (so the run
              isn&rsquo;t double-paid) and locks them from edits until an admin
              reopens them. Each run is logged with a content hash.
            </p>
          </div>
        ) : (
          <p className="mt-3 text-sm text-text-muted">
            No approved hours to export for this week yet. Approve submitted
            entries in the queue first, then come back here.
          </p>
        )
      ) : (
        <p className="mt-3 text-sm text-text-muted">
          Export preview unavailable right now. You can still download the
          CSV from{" "}
          <a
            href={exportHref}
            className="underline decoration-accent-yellow decoration-2 underline-offset-4 hover:text-brand-navy"
          >
            the export endpoint
          </a>
          .
        </p>
      )}
    </Card>
  );
}

function QueueCard({
  label,
  count,
  tone,
  description,
  href,
}: {
  label: string;
  count: number;
  tone: "info" | "success" | "danger";
  description: string;
  href?: string;
}) {
  const inner = (
    <Card className="h-full">
      <div className="flex items-center justify-between gap-3">
        <span className="font-display text-xs uppercase tracking-widest text-text-muted">
          {label}
        </span>
        <Pill tone={tone}>{count}</Pill>
      </div>
      <CardDescription className="mt-3">{description}</CardDescription>
    </Card>
  );
  if (href === "/hours/approvals") {
    return (
      <Link href={href} className="block focus:outline-none">
        {inner}
      </Link>
    );
  }
  return inner;
}

interface LoadResult {
  pending: ReadonlyArray<TimeEntry>;
  approved: ReadonlyArray<TimeEntry>;
  rejected: ReadonlyArray<TimeEntry>;
  overview: TimeEntryOverviewResponse | null;
  exportPreview: PayrollExportPreviewResponse | null;
  pulse: TodayPulseResponse | null;
  errors: string[];
}

async function loadHours(
  cookieValue: string | undefined,
  weekStart: string,
  weekEnd: string,
  today: string,
  isAdmin: boolean
): Promise<LoadResult> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  const base = host ? `${proto}://${host}` : "http://localhost:3000";
  const headersInit = cookieValue ? { cookie: `${SESSION_COOKIE}=${cookieValue}` } : undefined;

  const [pendingRes, approvedRes, rejectedRes, overviewRes, exportRes, pulseRes] =
    await Promise.all([
      readList(base, headersInit, "submitted"),
      readList(base, headersInit, "approved"),
      readList(base, headersInit, "rejected"),
      readOverview(base, headersInit, weekStart, weekEnd),
      // Dry-run only — never stamps. Admin-only endpoint; skip for LHs.
      isAdmin
        ? readExportPreview(base, headersInit, weekStart, weekEnd)
        : Promise.resolve({ preview: null, error: null }),
      readPulse(base, headersInit, today),
    ]);

  const errors: string[] = [];
  if (pendingRes.error) errors.push(pendingRes.error);
  if (approvedRes.error) errors.push(approvedRes.error);
  if (rejectedRes.error) errors.push(rejectedRes.error);
  if (overviewRes.error) errors.push(overviewRes.error);
  if (exportRes.error) errors.push(exportRes.error);
  if (pulseRes.error) errors.push(pulseRes.error);

  return {
    pending: pendingRes.entries,
    approved: approvedRes.entries,
    rejected: rejectedRes.entries,
    overview: overviewRes.overview,
    exportPreview: exportRes.preview,
    pulse: pulseRes.pulse,
    errors,
  };
}

async function readList(
  base: string,
  headersInit: { cookie: string } | undefined,
  status: "submitted" | "approved" | "rejected"
): Promise<{ entries: ReadonlyArray<TimeEntry>; error: string | null }> {
  try {
    const res = await fetch(`${base}/api/time-entries?scope=approver&status=${status}`, {
      cache: "no-store",
      headers: headersInit,
    });
    if (!res.ok) return { entries: [], error: `Queue ${status}: API ${res.status}` };
    const parsed = TimeEntryListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { entries: [], error: `Queue ${status}: bad shape` };
    return { entries: parsed.data.entries, error: null };
  } catch (err) {
    return {
      entries: [],
      error: `Queue ${status}: ${err instanceof Error ? err.message : "network error"}`,
    };
  }
}

async function readOverview(
  base: string,
  headersInit: { cookie: string } | undefined,
  fromDate: string,
  toDate: string
): Promise<{ overview: TimeEntryOverviewResponse | null; error: string | null }> {
  try {
    const res = await fetch(
      `${base}/api/time-entries-overview?fromDate=${fromDate}&toDate=${toDate}`,
      { cache: "no-store", headers: headersInit }
    );
    if (!res.ok) return { overview: null, error: `Weekly rollup: API ${res.status}` };
    const parsed = TimeEntryOverviewResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { overview: null, error: "Weekly rollup: bad shape" };
    return { overview: parsed.data, error: null };
  } catch (err) {
    return {
      overview: null,
      error: `Weekly rollup: ${err instanceof Error ? err.message : "network error"}`,
    };
  }
}

async function readExportPreview(
  base: string,
  headersInit: { cookie: string } | undefined,
  fromDate: string,
  toDate: string
): Promise<{ preview: PayrollExportPreviewResponse | null; error: string | null }> {
  try {
    const res = await fetch(
      `${base}/api/time-entries-export?dryRun=1&format=json&fromDate=${fromDate}&toDate=${toDate}`,
      { cache: "no-store", headers: headersInit }
    );
    if (!res.ok) return { preview: null, error: `Export preview: API ${res.status}` };
    const parsed = PayrollExportPreviewResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { preview: null, error: "Export preview: bad shape" };
    return { preview: parsed.data, error: null };
  } catch (err) {
    return {
      preview: null,
      error: `Export preview: ${err instanceof Error ? err.message : "network error"}`,
    };
  }
}

async function readPulse(
  base: string,
  headersInit: { cookie: string } | undefined,
  date: string
): Promise<{ pulse: TodayPulseResponse | null; error: string | null }> {
  try {
    const res = await fetch(`${base}/api/today-pulse?date=${date}`, {
      cache: "no-store",
      headers: headersInit,
    });
    if (!res.ok) return { pulse: null, error: `Today's closeout: API ${res.status}` };
    const parsed = TodayPulseResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { pulse: null, error: "Today's closeout: bad shape" };
    return { pulse: parsed.data, error: null };
  } catch (err) {
    return {
      pulse: null,
      error: `Today's closeout: ${err instanceof Error ? err.message : "network error"}`,
    };
  }
}
