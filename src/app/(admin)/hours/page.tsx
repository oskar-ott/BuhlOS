import Link from "next/link";
import type { Route } from "next";
import { notFound, redirect } from "next/navigation";
import { cookies, headers } from "next/headers";
import { ArrowLeft, ArrowRight, HardHat, UserX } from "lucide-react";
import { AdminShell } from "@/components/admin/AdminShell";
import { isFlagEnabled } from "../../../../api/_lib/feature-flags.js";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { isAdminRole } from "@/lib/auth/roles";
import {
  TimeEntryListResponseSchema,
  TimeEntryOverviewResponseSchema,
  PayrollExportPreviewResponseSchema,
  TodayPulseResponseSchema,
  LeaveListResponseSchema,
} from "@/domains/timesheets/schema";
import { UsersListResponseSchema } from "@/domains/users/schema";
import { LeaveApprovalsCard } from "@/components/admin/LeaveApprovalsCard";
import {
  BUSINESS_TIMEZONE,
  addDays,
  localDateString,
  summariseMissing,
  weekEndOf,
  weekStartOf,
} from "@/domains/timesheets/service";
import {
  formatDateLabel,
  formatHoursLabel,
  statusLabel,
  statusTone,
} from "@/domains/timesheets/format";
import {
  buildPersonOptions,
  filterTimeEntries,
  hoursEmptyStateMessage,
  parseHoursFilterParams,
  personDisplayName,
  type HoursListFilter,
  type PersonOption,
} from "@/domains/timesheets/list-filter";
import { HoursFilterBar } from "@/components/admin/HoursFilterBar";
import { HoursTabs } from "@/components/admin/HoursTabs";
import type {
  TimeEntry,
  TimeEntryOverviewResponse,
  PayrollExportPreviewResponse,
  TodayPulseResponse,
  LeaveRequest,
} from "@/domains/timesheets/types";

export const dynamic = "force-dynamic";

/**
 * /hours — admin hours overview.
 *
 * Four live blocks, all real data on the existing legacy endpoints — every
 * one is GET-only / read-only, so opening this page never mutates anything:
 *   1. Today's closeout — GET /api/today-pulse (live "is today accounted for?")
 *   2. Queue depth (pending / approved / rejected) — /api/time-entries?scope=approver
 *   3. This week's rollup — /api/time-entries-overview (totals by job/worker/
 *      status + the server's missing-hours list). Week-navigable via ?week=.
 *   4. Payroll export *preview* — a safe dry-run from /api/time-entries-export
 *      (?dryRun=1, never stamps). The committed export — which marks entries
 *      exported and locks them — deliberately stays on legacy /admin/hours;
 *      we do not trigger a payroll mutation from this surface.
 *
 * Genuinely-unbuilt flows (one-tap "approve the whole week", a direct Xero
 * push) are simply absent — CSV is the Xero path today; we never fake the
 * integration.
 *
 * Filters (#216): `?status=` + `?person=` narrow the ALREADY-LOADED queue
 * entries server-side (no new endpoints; the fetches are unchanged). The
 * client HoursFilterBar only writes the query string; week navigation
 * carries active filter params through. The deep-link contract for other
 * surfaces: /hours?status=submitted|approved|rejected&person=<userId>.
 */
export default async function HoursOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string; status?: string; person?: string }>;
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
  // #760: Hours is a CORE kill-switch — the owner can hide the office Hours
  // surface. Default ON. (Field hours logging + the time-entry APIs stay live —
  // shared infrastructure; the board warns before disabling a core feature.)
  if (!(await isFlagEnabled("hours", session))) notFound();
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

  // #216 — URL-driven status/person filters. Validated here (unknown values
  // degrade silently to "all") and threaded through every week-nav link so
  // ?week= navigation never drops an active filter.
  const filter = parseHoursFilterParams(sp);
  const filterQuery: Record<string, string> = {
    ...(filter.status ? { status: filter.status } : {}),
    ...(filter.person ? { person: filter.person } : {}),
  };

  const {
    pending,
    approved,
    rejected,
    overview,
    exportPreview,
    pulse,
    leave,
    leaveError,
    workers,
    errors,
  } = await loadHours(raw, weekStart, weekEnd, today, isAdmin);

  const missing = overview ? summariseMissing(overview.missing) : null;

  // Person options for the filter bar — built ONLY from data this viewer
  // already received (queues + rollup + missing list), so the picker can
  // never be wider than the viewer's tier-scoped visibility (#351).
  const personOptions = buildPersonOptions([
    pending,
    approved,
    rejected,
    overview?.totals.byUser ?? [],
    overview?.missing ?? [],
  ]);

  return (
    <AdminShell title="Hours">
      {/* Section tabs (#415 → lean-reset: Today · This week · Pay period). */}
      <HoursTabs />
      <div className="mx-auto max-w-4xl space-y-4">
        {/* ── Intro — the design's "Today · Friday 18 July" head. */}
        <div className="space-y-1">
          <h2 className="font-display text-base font-semibold text-text">
            Today · {todayHeading(today)}
          </h2>
          <p className="max-w-[72ch] text-sm text-text-muted">
            Who&rsquo;s on the clock and what the crew has logged this week.
            Sign off submitted days on This week, then close the week out for
            payroll.
          </p>
        </div>

        {errors.length > 0 ? (
          <Card className="border-amber-200 bg-amber-50" role="alert">
            <CardTitle>Some data couldn&rsquo;t load</CardTitle>
            <CardDescription className="text-amber-900">
              {errors.join(" · ")}. The rest of the page still reflects what
              loaded.
            </CardDescription>
          </Card>
        ) : null}

        {/* ── The design's four stat tiles — live pulse + queue depth. */}
        <DayStatTiles
          pulse={pulse}
          pendingCount={pending.length}
          rejectedCount={rejected.length}
        />

        {/* ── End-of-day closeout (today) ───────────────────────────── */}
        <TodayCloseout pulse={pulse} today={today} />

        {/* ── Recent activity — the queue entries for the viewed week,
               newest first (the design's activity card). */}
        <RecentActivityCard
          pending={pending}
          approved={approved}
          rejected={rejected}
          weekStart={weekStart}
          weekEnd={weekEnd}
          isCurrentWeek={isCurrentWeek}
        />

        {/* ── Filters (#216) — the bar writes ?status=/?person=; this
               server component re-renders with the narrowed view below. */}
        <HoursFilterBar personOptions={personOptions} />

        {filter.status || filter.person ? (
          <FilteredEntriesCard
            filter={filter}
            personOptions={personOptions}
            pending={pending}
            approved={approved}
            rejected={rejected}
            weekStart={weekStart}
            weekEnd={weekEnd}
            isCurrentWeek={isCurrentWeek}
          />
        ) : null}

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
            description="Workers see the reason in the field app and can edit + resubmit."
          />
        </div>

        {/* ── This week (the payroll ritual) — the design's pointer. ── */}
        <Card className="border-l-4 border-l-accent-yellow">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>This week</CardTitle>
              <CardDescription className="mt-1">
                Sign off submitted days worker by worker, then close the week
                out for payroll.
              </CardDescription>
            </div>
            <Link
              // `as Route` — typedRoutes' generated map is from the previous
              // build and can't see the route this PR adds (same pattern as
              // AdminSidebar's newer entries). Validated for real by `next build`.
              href={"/hours/weekly" as Route}
              className="inline-flex items-center rounded-card bg-brand-navy px-5 py-3 text-sm font-medium text-text-inverse hover:bg-accent-ink"
            >
              Open This week →
            </Link>
          </div>
        </Card>

        {/* ── Week rollup (named to not collide with the This-week tab). ── */}
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>{isCurrentWeek ? "This week's rollup" : "Week rollup"}</CardTitle>
              <CardDescription className="mt-1">
                {formatDateLabel(weekStart)} – {formatDateLabel(weekEnd)}
              </CardDescription>
            </div>
            <div className="flex items-center gap-1">
              {/* Week links carry the active filter params (#216) so paging
                  through weeks never drops the narrowed view. */}
              <WeekNavLink
                week={prevWeek}
                extraQuery={filterQuery}
                label="Previous week"
                icon={<ArrowLeft aria-hidden="true" className="h-4 w-4" />}
              />
              {!isCurrentWeek ? (
                <Link
                  href={{
                    pathname: "/hours",
                    query: { week: thisWeekStart, ...filterQuery },
                  }}
                  className="rounded-card border border-border px-3 py-2 text-xs font-medium text-text hover:border-brand-navy"
                >
                  This week
                </Link>
              ) : null}
              <WeekNavLink
                week={nextWeek}
                extraQuery={filterQuery}
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

        {/* ── Leave (admin only): approve requests + record on behalf.
               Approved days are exempt from missing-hours detection, so this
               sits right under the rollup where "missing" is reported. */}
        {isAdmin ? (
          <LeaveApprovalsCard
            initialRequests={leave}
            fetchError={leaveError}
            workers={workers}
          />
        ) : null}

        {/* ── Payroll export preview (admin only) ───────────────────── */}
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
      </div>
    </AdminShell>
  );
}

/** "Friday 18 July" — the intro's long-form date, UTC-parsed like every other
 *  date label so the Sydney business date never shifts under the server TZ. */
function todayHeading(isoDate: string): string {
  return new Date(isoDate + "T00:00:00Z").toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  });
}

/**
 * The design's four stat tiles: ON THE CLOCK · LOGGED TODAY (live pulse) ·
 * AWAITING APPROVAL (amber) · REJECTED DAYS (red) — the last two from the
 * approver queues. HONESTY: a missing pulse renders "—", never a 0. "Logged
 * today" sums the pulse's submitted + approved hour totals — drafts are
 * counted (draftCount) but the pulse carries no draft hours, so they are
 * deliberately not guessed into the figure.
 */
function DayStatTiles({
  pulse,
  pendingCount,
  rejectedCount,
}: {
  pulse: TodayPulseResponse | null;
  pendingCount: number;
  rejectedCount: number;
}) {
  const h = pulse?.hours ?? null;
  const loggedToday = h ? formatHoursLabel(h.submittedTotal + h.approvedTotal) : "—";

  const tiles: Array<{ label: string; value: string; tone: "neutral" | "warning" | "danger" }> = [
    { label: "On the clock", value: h ? String(h.crewOnSite) : "—", tone: "neutral" },
    { label: "Logged today", value: loggedToday, tone: "neutral" },
    {
      label: "Awaiting approval",
      value: String(pendingCount),
      tone: pendingCount > 0 ? "warning" : "neutral",
    },
    { label: "Rejected days", value: String(rejectedCount), tone: "danger" },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {tiles.map((t) => (
        <div
          key={t.label}
          className={cn(
            "rounded-card border p-4",
            t.tone === "warning" && "border-amber-200 bg-amber-50",
            t.tone === "danger" && "border-rose-200 bg-rose-50",
            t.tone === "neutral" && "border-border bg-surface-raised shadow-card",
          )}
        >
          <p className="font-mono text-[11px] uppercase tracking-[.12em] text-text-muted">
            {t.label}
          </p>
          <p
            className={cn(
              "mt-1 font-display text-2xl font-semibold tabular-nums",
              t.tone === "warning" && "text-amber-700",
              t.tone === "danger" && "text-rose-700",
              t.tone === "neutral" && "text-text",
            )}
          >
            {t.value}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * The design's "Recent activity" card — every queue entry in the viewed week,
 * newest first: worker + date · job allocations · hours · status pill. Built
 * from the ALREADY-LOADED approver queues (no new fetch), bounded to the
 * viewed week so `?week=` navigation pages it like everything else.
 */
function RecentActivityCard({
  pending,
  approved,
  rejected,
  weekStart,
  weekEnd,
  isCurrentWeek,
}: {
  pending: ReadonlyArray<TimeEntry>;
  approved: ReadonlyArray<TimeEntry>;
  rejected: ReadonlyArray<TimeEntry>;
  weekStart: string;
  weekEnd: string;
  isCurrentWeek: boolean;
}) {
  const entries = [...pending, ...approved, ...rejected]
    .filter((e) => e.date >= weekStart && e.date <= weekEnd)
    .sort((a, b) => b.date.localeCompare(a.date));

  return (
    <Card>
      <CardTitle>Recent activity</CardTitle>
      <CardDescription className="mt-1">
        Every entry the crew has logged {isCurrentWeek ? "this week" : "in this week"}, newest
        first.
      </CardDescription>
      {entries.length === 0 ? (
        <p className="mt-3 rounded-card bg-surface-subtle px-3 py-2 text-sm text-text-muted">
          Nothing logged {isCurrentWeek ? "this week" : "in this week"} yet.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-border rounded-card border border-border">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-3.5 py-3">
              <div className="min-w-[120px]">
                <div className="font-display text-sm font-semibold text-text">
                  {e.userName ?? e.userId}
                </div>
                <div className="text-xs text-text-muted">{formatDateLabel(e.date)}</div>
              </div>
              <div className="min-w-0 flex-1 truncate text-[13px] text-text-muted">
                {allocationSummary(e)}
              </div>
              <div className="shrink-0 font-display text-sm font-semibold tabular-nums text-text">
                {formatHoursLabel(e.totalHours)}
              </div>
              <Pill tone={statusTone(e.status)} className="shrink-0">
                {statusLabel(e.status)}
              </Pill>
            </li>
          ))}
        </ul>
      )}
    </Card>
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
  extraQuery,
  label,
  icon,
}: {
  week: string;
  /** Active filter params (#216) — carried so week paging keeps the view. */
  extraQuery: Record<string, string>;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={{ pathname: "/hours", query: { week, ...extraQuery } }}
      aria-label={label}
      title={label}
      className="rounded-card border border-border p-2 text-text-muted hover:border-brand-navy hover:text-text"
    >
      {icon}
    </Link>
  );
}

/**
 * The filtered view itself (#216). Renders the already-loaded approver-queue
 * entries narrowed by `?status=` + `?person=` and bounded to the viewed week
 * (the queues are all-time; the week bound is what makes the filters compose
 * with `?week=` navigation). Server-rendered straight from the URL params,
 * so a shared link shows the identical view to anyone with the same
 * visibility — and a viewer with narrower visibility gets the named empty
 * state below, never a bare nothing-here.
 *
 * Renders only while a filter is active: with no params the page is
 * byte-identical to the unfiltered layout (no regression, no layout shift).
 */
function FilteredEntriesCard({
  filter,
  personOptions,
  pending,
  approved,
  rejected,
  weekStart,
  weekEnd,
  isCurrentWeek,
}: {
  filter: HoursListFilter;
  personOptions: ReadonlyArray<PersonOption>;
  pending: ReadonlyArray<TimeEntry>;
  approved: ReadonlyArray<TimeEntry>;
  rejected: ReadonlyArray<TimeEntry>;
  weekStart: string;
  weekEnd: string;
  isCurrentWeek: boolean;
}) {
  const source =
    filter.status === "submitted"
      ? pending
      : filter.status === "approved"
        ? approved
        : filter.status === "rejected"
          ? rejected
          : [...pending, ...approved, ...rejected];
  const entries = filterTimeEntries(source, filter, {
    fromDate: weekStart,
    toDate: weekEnd,
  });
  const personName = filter.person
    ? personDisplayName(filter.person, personOptions)
    : null;
  const weekLabel = isCurrentWeek
    ? "this week"
    : `in the week of ${formatDateLabel(weekStart)}`;
  const totalHours = entries.reduce((sum, e) => sum + e.totalHours, 0);

  const headline = [
    filter.status ? `${statusLabel(filter.status)} entries` : "All queue entries",
    personName ? `for ${personName}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Card className="border-l-4 border-l-brand-navy">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <CardTitle>Filtered entries</CardTitle>
          <CardDescription className="mt-1">
            {headline} · {formatDateLabel(weekStart)} – {formatDateLabel(weekEnd)}
          </CardDescription>
        </div>
        {entries.length > 0 ? (
          <Pill tone="navy">
            {entries.length} {entries.length === 1 ? "entry" : "entries"} ·{" "}
            {formatHoursLabel(totalHours)}
          </Pill>
        ) : null}
      </div>

      {entries.length === 0 ? (
        <p className="mt-4 rounded-card bg-surface-subtle px-3 py-2 text-sm text-text-muted">
          {hoursEmptyStateMessage(filter, personName, weekLabel)}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-card border border-border">
          {entries.map((e) => (
            <li
              key={e.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <Pill tone={statusTone(e.status)}>{statusLabel(e.status)}</Pill>
                <span className="font-medium text-text">{e.userName ?? e.userId}</span>
                <span className="text-text-muted">{formatDateLabel(e.date)}</span>
              </span>
              <span className="flex min-w-0 items-center gap-3">
                <span className="truncate text-xs text-text-muted">
                  {allocationSummary(e)}
                </span>
                <span className="shrink-0 font-medium tabular-nums text-text">
                  {formatHoursLabel(e.totalHours)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Job names on an entry's allocations, deduped — "No job assigned" keeps
 *  unattributed legacy allocations visible (same copy as the approvals queue). */
function allocationSummary(entry: TimeEntry): string {
  const names = entry.allocations.map((a) => {
    const name = (a.jobName ?? "").trim();
    if (name) return name;
    return a.jobId ? "Unnamed job" : "No job assigned";
  });
  return Array.from(new Set(names)).join(" · ");
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

/**
 * Payroll export — a read-only DRY-RUN preview only.
 *
 * Backed by GET /api/time-entries-export?dryRun=1&format=json, which never
 * stamps entries (the `if (!dryRun)` branch is skipped server-side). We show
 * the run's shape (row / hour / worker / job counts — no money figures) so the
 * admin can sanity-check the week before committing.
 *
 * We deliberately do NOT render a button to the committed (non-dryRun) export:
 * that endpoint mutates payroll state (marks entries exportedAt + exportId,
 * writes payroll-runs.json, locks the entries). Triggering a payroll mutation
 * is out of scope for this foundation, so the committed run lives on the
 * weekly closeout board (/hours/weekly), not here.
 */
function PayrollExportCard({
  preview,
  weekStart,
  weekEnd,
}: {
  preview: PayrollExportPreviewResponse | null;
  weekStart: string;
  weekEnd: string;
}) {
  const summary = preview?.summary ?? null;
  const hasRows = (summary?.rowCount ?? 0) > 0;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Payroll export preview</CardTitle>
        <Pill tone="neutral">Dry run · not pushed to Xero</Pill>
      </div>
      <CardDescription className="mt-1">
        Approved hours for {formatDateLabel(weekStart)} – {formatDateLabel(weekEnd)},
        one row per job allocation — the format Xero and most payroll systems
        import directly. This is a preview; nothing is marked exported.
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
            <p className="text-xs text-text-muted">
              Preview only — no entries have been marked exported. The committed
              payroll run (which stamps these entries as exported, locks them
              from edits and logs a content hash) isn&rsquo;t built on this
              surface yet; until it lands, payroll works from this preview.
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
          Export preview unavailable right now. Check the connection and
          reload; the committed payroll run isn&rsquo;t built on this surface
          yet.
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
  leave: ReadonlyArray<LeaveRequest>;
  leaveError: string | null;
  workers: ReadonlyArray<{ id: string; username: string }>;
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

  const [
    pendingRes,
    approvedRes,
    rejectedRes,
    overviewRes,
    exportRes,
    pulseRes,
    leaveRes,
    workersRes,
  ] = await Promise.all([
    readList(base, headersInit, "submitted"),
    readList(base, headersInit, "approved"),
    readList(base, headersInit, "rejected"),
    readOverview(base, headersInit, weekStart, weekEnd),
    // Dry-run only — never stamps. Admin-only endpoint; skip for LHs.
    isAdmin
      ? readExportPreview(base, headersInit, weekStart, weekEnd)
      : Promise.resolve({ preview: null, error: null }),
    readPulse(base, headersInit, today),
    // Leave queue + the on-behalf worker picker are admin-only widgets;
    // their failures stay on the card (leaveError), not the page banner.
    isAdmin
      ? readLeave(base, headersInit)
      : Promise.resolve({ requests: [] as LeaveRequest[], error: null }),
    isAdmin
      ? readWorkers(base, headersInit)
      : Promise.resolve({ workers: [] as Array<{ id: string; username: string }> }),
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
    leave: leaveRes.requests,
    leaveError: leaveRes.error,
    workers: workersRes.workers,
    errors,
  };
}

async function readLeave(
  base: string,
  headersInit: { cookie: string } | undefined
): Promise<{ requests: LeaveRequest[]; error: string | null }> {
  try {
    const res = await fetch(`${base}/api/leave`, {
      cache: "no-store",
      headers: headersInit,
    });
    if (!res.ok) return { requests: [], error: `Leave queue: API ${res.status}` };
    const parsed = LeaveListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { requests: [], error: "Leave queue: bad shape" };
    return { requests: parsed.data.requests, error: null };
  } catch (err) {
    return {
      requests: [],
      error: `Leave queue: ${err instanceof Error ? err.message : "network error"}`,
    };
  }
}

/**
 * Worker directory for the record-on-behalf picker. listTradies returns
 * exactly the leave-trackable population (field tier + leading hands,
 * never disabled/archived). Fail-soft: an empty picker just means the
 * admin can't record on behalf until reload — approvals still work.
 */
async function readWorkers(
  base: string,
  headersInit: { cookie: string } | undefined
): Promise<{ workers: Array<{ id: string; username: string }> }> {
  try {
    const res = await fetch(`${base}/api/users?action=listTradies`, {
      cache: "no-store",
      headers: headersInit,
    });
    if (!res.ok) return { workers: [] };
    const parsed = UsersListResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { workers: [] };
    return {
      workers: parsed.data.users.map((u) => ({ id: u.id, username: u.username })),
    };
  } catch {
    return { workers: [] };
  }
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
