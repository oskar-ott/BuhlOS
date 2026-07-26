"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  Calendar,
  ChevronRight,
  ClipboardCheck,
  Inbox,
  Users,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { Drawer } from "@/components/ui/Drawer";
import { RefreshButton } from "@/components/ui/RefreshButton";
import type { ExceptionItem } from "@/domains/exceptions/types";
import { SEVERITY_TONE, sourceLabel } from "@/domains/exceptions/labels";
import { isActionable } from "@/domains/exceptions/service";
import type { TodayStripModel } from "@/domains/timesheets/today-strip";
import {
  approvalsBreakdownLabel,
  dailyApprovalsTotal,
  rankNeedsYou,
  type MobileTodayApprovals,
  type MobileTodayApprovalsEnabled,
} from "./mobile-today";

/**
 * Mobile Command Centre ("Today") — the calm phone home that answers
 * "what needs me first?" in one screen (the audit's single ranked list, not
 * nine equal cards). Rendered `md:hidden`; the desktop page is untouched.
 *
 * Every value is real or honestly absent (P7): the pulse + needs-you list +
 * approval counts are a simpler projection of the SAME loadSnapshot data the
 * desktop page uses. There is no fabricated presence, count or action.
 */

interface MobileTodayProps {
  /** "Morning, Oskar" — or just "Morning" when the name is unknown. */
  greeting: string;
  /** "Friday 26 June" (Sydney). */
  dateLabel: string;
  todayStrip: TodayStripModel | null;
  todayPulseError: string | null;
  /** Distinct jobs with logged activity today (from today-pulse) — null when the
   *  pulse failed. NOT the business-wide active-job count (P7: it must relate to
   *  the same "on the clock today" signal as crewCount). */
  jobsWithActivityToday: number | null;
  /** Hours submitted and awaiting approval (the weekly payroll closeout). */
  pendingHours: number;
  approvals: MobileTodayApprovals;
  /** Lean reset: which approvals sources are live. A dark source is never
   *  named; all three dark ⇒ no "to approve" pulse and no approvals row. */
  approvalsEnabled: MobileTodayApprovalsEnabled;
  /** The ranked exception list (already built + age-decorated by the page). */
  exceptions: ExceptionItem[];
  anySourceError: boolean;
  errorMessage: string | null;
  allClear: boolean;
}

const SEVERITY_RAIL: Record<ExceptionItem["severity"], string> = {
  critical: "border-l-state-danger",
  warning: "border-l-state-warning",
  info: "border-l-state-info",
};
const SEVERITY_ICON_WRAP: Record<ExceptionItem["severity"], string> = {
  critical: "bg-rose-50 text-rose-700",
  warning: "bg-amber-50 text-amber-800",
  info: "bg-sky-50 text-sky-700",
};

function severityIcon(item: ExceptionItem) {
  if (item.severity === "critical") return AlertOctagon;
  if (item.severity === "warning") return AlertTriangle;
  return Inbox;
}

export function MobileToday(props: MobileTodayProps) {
  const {
    greeting,
    dateLabel,
    todayStrip,
    todayPulseError,
    jobsWithActivityToday,
    pendingHours,
    approvals,
    approvalsEnabled,
    exceptions,
    anySourceError,
    errorMessage,
    allClear,
  } = props;

  const { top, remaining, all } = rankNeedsYou(exceptions, 4);
  const dailyApprovals = dailyApprovalsTotal(approvals);
  // null ⇔ every approvals source is dark (lean reset) — render no "to
  // approve" pulse segment and no approvals strip card at all.
  const approvalsSub = approvalsBreakdownLabel(approvals, approvalsEnabled);
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<ExceptionItem | null>(null);
  const visible = showAll ? all : top;

  return (
    <div className="space-y-5 pb-4">
      {/* Greeting */}
      <header className="pt-1">
        <h1 className="font-display text-2xl font-bold tracking-tight text-text">{greeting}</h1>
        <p className="mt-1 text-sm text-text-muted">{dateLabel} · here&rsquo;s what needs you</p>
      </header>

      {/* Pulse — one calm navy row, three tappable segments */}
      <div className="flex items-stretch overflow-hidden rounded-card bg-brand-navy shadow-card">
        <PulseSegment href="/hours" value={todayStrip ? String(todayStrip.crewCount) : "—"} label="on the clock" />
        <PulseSegment href="/hours" value={todayStrip ? todayStrip.loggedHoursLabel : "—"} label="logged today" />
        {approvalsSub !== null ? (
          <PulseSegment
            href={"/hours/approvals" as Route}
            value={String(dailyApprovals)}
            label="to approve"
            hot
          />
        ) : null}
      </div>
      {todayPulseError ? (
        <p className="-mt-3 px-1 text-xs text-text-muted">
          Live pulse couldn&rsquo;t load — counts may be incomplete.
        </p>
      ) : null}

      {/* Source error — never block the page (per-source degradation) */}
      {anySourceError ? (
        <Card className="border-amber-200 bg-amber-50 p-4" role="alert">
          <p className="font-display text-sm font-semibold text-amber-900">
            Couldn&rsquo;t load every queue
          </p>
          <p className="mt-1 text-xs text-amber-900">
            {errorMessage}. Counts shown may be incomplete.
          </p>
          <div className="mt-3">
            <RefreshButton />
          </div>
        </Card>
      ) : null}

      {allClear ? (
        <Card className="border-emerald-200 bg-emerald-50 p-4" role="status">
          <p className="font-display text-sm font-semibold text-emerald-900">All clear</p>
          <p className="mt-1 text-xs text-emerald-900">
            Nothing needs you right now. New submissions land here as they come in.
          </p>
        </Card>
      ) : null}

      {/* Needs you — the single ranked list */}
      {all.length > 0 ? (
        <section>
          <SectionLabel meta={`${all.length} open`}>Needs you</SectionLabel>
          <Card className="mt-2 overflow-hidden p-0">
            {visible.map((item) => {
              const Icon = severityIcon(item);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelected(item)}
                  className={cn(
                    "flex w-full items-start gap-3 border-l-[3px] border-t border-border px-4 py-3 text-left first:border-t-0 hover:bg-surface-subtle",
                    SEVERITY_RAIL[item.severity],
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-card",
                      SEVERITY_ICON_WRAP[item.severity],
                    )}
                  >
                    <Icon aria-hidden="true" className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-mono text-[10px] uppercase tracking-wider text-text-muted">
                      {item.sourceLabel ?? sourceLabel(item.source)}
                    </span>
                    <span className="mt-0.5 block font-display text-sm font-semibold leading-snug text-text">
                      {item.title}
                    </span>
                    {item.jobName ? (
                      <span className="mt-1 block font-mono text-[10px] text-text-muted">
                        {item.jobName}
                      </span>
                    ) : null}
                  </span>
                  {item.ageLabel ? (
                    <span className="shrink-0 pt-0.5 font-mono text-[10px] text-text-muted">
                      {item.ageLabel}
                    </span>
                  ) : null}
                </button>
              );
            })}
            {remaining > 0 && !showAll ? (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="flex w-full items-center justify-center gap-1 border-t border-border px-4 py-3 text-sm font-semibold text-state-info hover:bg-surface-subtle"
              >
                View all {all.length} items
                <ChevronRight aria-hidden="true" className="h-4 w-4" />
              </button>
            ) : null}
          </Card>
        </section>
      ) : null}

      {/* Waiting on you — day-to-day approvals (hours are a weekly closeout).
          The breakdown names only LIVE sources; with every approvals source
          dark the section carries hours alone, so the meta counts those. */}
      {dailyApprovals > 0 || pendingHours > 0 ? (
        <section>
          <SectionLabel meta={`${approvalsSub !== null ? dailyApprovals : pendingHours} to action`}>
            Waiting on you
          </SectionLabel>
          <div className="mt-2 space-y-2">
            {dailyApprovals > 0 && approvalsSub !== null ? (
              <StripCard
                href={"/hours/approvals" as Route}
                icon={<ClipboardCheck aria-hidden="true" className="h-5 w-5" />}
                title="Approvals queue"
                sub={approvalsSub}
                count={dailyApprovals}
              />
            ) : null}
            {pendingHours > 0 ? (
              <StripCard
                href={"/hours/weekly" as Route}
                icon={<Calendar aria-hidden="true" className="h-5 w-5" />}
                title="Hours for payroll"
                sub={`${pendingHours} timesheet${pendingHours === 1 ? "" : "s"} awaiting weekly approval`}
                count={pendingHours}
                tone="yellow"
              />
            ) : null}
          </div>
        </section>
      ) : null}

      {/* On the clock now (no facepile — today-pulse is a count, not a roster) */}
      {todayStrip && todayStrip.crewCount > 0 ? (
        <section>
          <SectionLabel link="See hours" href="/hours">
            On the clock now
          </SectionLabel>
          <Link href="/hours" className="mt-2 block">
            <Card className="flex items-center gap-3 p-4 hover:bg-surface-subtle">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-surface-subtle text-text-muted">
                <Users aria-hidden="true" className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-display text-sm font-semibold text-text">
                  {todayStrip.crewCount} {todayStrip.crewLabel}
                </span>
                <span className="block text-xs text-text-muted">
                  {jobsWithActivityToday != null && jobsWithActivityToday > 0
                    ? `across ${jobsWithActivityToday} job${jobsWithActivityToday === 1 ? "" : "s"} today`
                    : "hours logged today"}
                </span>
              </span>
              <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            </Card>
          </Link>
        </section>
      ) : null}

      {/* Detail sheet */}
      <Drawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected?.title ?? ""}
        subtitle={selected ? (selected.sourceLabel ?? sourceLabel(selected.source)) : undefined}
        footer={
          selected && isActionable(selected) && selected.actionHref ? (
            <Link
              href={selected.actionHref as Route}
              onClick={() => setSelected(null)}
              className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-card bg-brand-navy px-4 text-sm font-medium text-text-inverse hover:bg-accent-ink"
            >
              {selected.actionLabel ?? "Open"}
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </Link>
          ) : null
        }
      >
        {selected ? (
          <div className="space-y-4">
            <Pill tone={SEVERITY_TONE[selected.severity]}>{selected.severity}</Pill>
            {selected.summary ? (
              <p className="rounded-card bg-surface-subtle p-3 text-sm text-text">{selected.summary}</p>
            ) : null}
            <dl className="grid grid-cols-2 gap-3 text-sm">
              {selected.jobName ? (
                <Field label="Job">{selected.jobName}</Field>
              ) : null}
              {selected.ageLabel ? <Field label="Age">{selected.ageLabel}</Field> : null}
            </dl>
            {!isActionable(selected) && selected.actionReason ? (
              <p className="text-xs text-text-muted">{selected.actionReason}</p>
            ) : null}
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}

function PulseSegment({
  href,
  value,
  label,
  hot,
}: {
  href: Route;
  value: string;
  label: string;
  hot?: boolean;
}) {
  return (
    <Link
      href={href}
      className="relative flex flex-1 flex-col gap-0.5 px-3 py-3 text-left first:pl-4 [&+a]:before:absolute [&+a]:before:left-0 [&+a]:before:top-3 [&+a]:before:bottom-3 [&+a]:before:w-px [&+a]:before:bg-white/15"
    >
      <span
        className={cn(
          "font-display text-xl font-bold leading-none tracking-tight",
          hot ? "text-accent-yellow" : "text-text-inverse",
        )}
      >
        {value}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-white/60">{label}</span>
    </Link>
  );
}

function StripCard({
  href,
  icon,
  title,
  sub,
  count,
  tone = "navy",
}: {
  href: Route;
  icon: React.ReactNode;
  title: string;
  sub: string;
  count: number;
  tone?: "navy" | "yellow";
}) {
  return (
    <Link href={href} className="block">
      <Card className="flex items-center gap-3 p-4 hover:bg-surface-subtle">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-card",
            tone === "yellow" ? "bg-accent-yellow text-brand-navy" : "bg-brand-navy text-accent-yellow",
          )}
        >
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-display text-sm font-semibold text-text">{title}</span>
          <span className="block text-xs text-text-muted">{sub}</span>
        </span>
        <span className="flex h-7 min-w-[28px] shrink-0 items-center justify-center rounded-pill bg-accent-yellow px-2 font-display text-sm font-bold text-brand-navy">
          {count}
        </span>
        <ChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
      </Card>
    </Link>
  );
}

function SectionLabel({
  children,
  meta,
  link,
  href,
}: {
  children: React.ReactNode;
  meta?: string;
  link?: string;
  href?: Route;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 px-1">
      <h2 className="font-mono text-[11px] font-semibold uppercase tracking-widest text-text-muted">
        {children}
      </h2>
      {link && href ? (
        <Link href={href} className="text-xs font-semibold text-state-info">
          {link}
        </Link>
      ) : meta ? (
        <span className="font-mono text-[10px] text-text-muted">{meta}</span>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className="mt-0.5 text-text">{children}</dd>
    </div>
  );
}
