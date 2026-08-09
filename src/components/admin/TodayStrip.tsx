import Link from "next/link";
import type { Route } from "next";
import { Sunrise } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { formatDateLabel } from "@/domains/timesheets/format";
import type { TodayStripModel } from "@/domains/timesheets/today-strip";

/**
 * "Today" strip leading /command-centre (#185) — the operational morning
 * view: who's on the clock, how today's hours are tracking, and the same
 * pending-approvals count the Hours queue card shows. A STRIP, not a hero —
 * one compact card so the needs-you queue cards stay above the fold.
 *
 * Purely presentational: the page's loadSnapshot fetches the pulse server-
 * side (same Promise.all as the queues), summariseTodayStrip() derives the
 * model, and this component just renders it.
 *
 * Props contract:
 *  - `model` — null when the pulse fetch failed/parsed badly → error chip,
 *    queues unaffected (the established per-source degradation pattern).
 *  - `pendingApprovals` — the SAME loadSnapshot value the Hours queue card
 *    counts (one number, one source; deliberately NOT pulse.hours.pendingCount,
 *    which is today-only).
 *
 * Honesty: crew figures are "logged hours today" — never "on site" (the
 * pulse has no GPS). Zero state before the crew clocks on is calm/neutral,
 * not a warning. Boundary: analytics tiles belong to #316, not here.
 */

interface TodayStripProps {
  model: TodayStripModel | null;
  /** Per-source error string from loadSnapshot, null when the pulse loaded. */
  pulseError: string | null;
  /** Same value the Hours queue card renders — spans all dates, not just today. */
  pendingApprovals: number;
}

export function TodayStrip({ model, pulseError, pendingApprovals }: TodayStripProps) {
  return (
    <Card className="border-l-4 border-l-brand-navy py-4">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-2">
          <Sunrise aria-hidden="true" className="h-5 w-5 text-brand-navy" />
          <div>
            <p className="font-display text-base font-semibold text-text">Today</p>
            <p className="text-xs text-text-muted">
              {model ? formatDateLabel(model.date) : "Live day snapshot"}
            </p>
          </div>
        </div>

        {pulseError ? (
          <div className="flex flex-wrap items-center gap-2" role="status">
            <Pill tone="warning">Today&rsquo;s pulse couldn&rsquo;t load</Pill>
            <span className="text-xs text-text-muted">
              {pulseError}. The queues below are unaffected.
            </span>
          </div>
        ) : model && !model.hasActivity ? (
          <p className="text-sm text-text-muted" role="status">
            No hours logged yet today — entries appear here as the crew logs
            them.
          </p>
        ) : model ? (
          <>
            {/* Today-scoped stats deep-link to the day view — /hours itself
                now lands on the weekly board (weekly-first directive). */}
            <StripStat
              value={String(model.crewCount)}
              label={model.crewLabel}
              hint="logged hours today"
              href={"/hours/today" as Route}
              ariaLabel={`${model.crewCount} on the clock — logged hours today`}
            />
            <StripStat
              value={model.loggedHoursLabel}
              label="logged today"
              hint={model.loggedHoursHint}
              href={"/hours/today" as Route}
              ariaLabel={`${model.loggedHoursLabel} logged today (${model.loggedHoursHint})`}
            />
          </>
        ) : null}

        {/* Pending approvals renders in every state — it comes from the
            hours-queue source, not the pulse, so a pulse failure never
            hides it. Same number as the Hours queue card. */}
        <StripStat
          value={String(pendingApprovals)}
          label="pending approval"
          hint="all dates"
          href={"/hours/approvals" as Route}
          ariaLabel={`Pending approval: ${pendingApprovals}`}
        />
      </div>
    </Card>
  );
}

function StripStat({
  value,
  label,
  hint,
  href,
  ariaLabel,
}: {
  value: string;
  label: string;
  hint: string;
  href: Route;
  ariaLabel: string;
}) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      className="group rounded-card focus:outline-none focus:ring-2 focus:ring-brand-navy"
    >
      <span className="flex items-baseline gap-2">
        <span className="font-display text-xl font-semibold text-text">
          {value}
        </span>
        <span className="text-sm text-text group-hover:underline">{label}</span>
      </span>
      <span className="block text-xs text-text-muted">{hint}</span>
    </Link>
  );
}
