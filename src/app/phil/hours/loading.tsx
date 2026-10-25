import { PhilShell } from "@/components/phil/PhilShell";
import { PhilSkeleton } from "@/components/phil/ui/PhilSkeleton";
import {
  BUSINESS_TIMEZONE,
  addDays,
  localDateString,
  weekStartOf,
} from "@/domains/timesheets/service";
import { weekRangeLabel, weekdayShort } from "@/domains/timesheets/hours-view";

/**
 * The Hours screen while its data loads (docs/phil-hours.md): the same navy
 * header, a skeleton summary bar, the week card with day names and grey bars,
 * and "Loading your hours…" where the panel will be. No numbers — nothing is
 * known yet. Loading, loaded-empty and failed are three different screens.
 */
export default function Loading() {
  const todayISO = localDateString(new Date(), BUSINESS_TIMEZONE);
  const monday = weekStartOf(todayISO);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return (
    <PhilShell title="Hours">
      <div
        className="flex min-h-full flex-col"
        aria-busy="true"
        aria-live="polite"
        data-testid="hours-view-loading"
      >
        <header className="-mx-4 -mt-4 bg-brand-navy px-4 pb-4 pt-3 text-white">
          <h1 className="font-display text-[22px] font-extrabold leading-tight tracking-[-0.02em]">
            This week
          </h1>
          <p className="mt-0.5 text-[14px] font-medium tabular-nums text-white/75">
            {weekRangeLabel(monday)}
          </p>
        </header>
        <div className="flex-1 space-y-3 pb-4 pt-4">
          <div className="flex items-center justify-between px-1">
            <PhilSkeleton className="h-5 w-40" />
            <PhilSkeleton className="h-5 w-24" />
          </div>
          <ul className="divide-y divide-[#eef2f6] overflow-hidden rounded-[16px] border border-border bg-surface shadow-card">
            {days.map((date) => (
              <li key={date} className="flex min-h-[64px] items-center gap-3 px-4 py-3">
                <span className="w-10 font-display text-[16px] font-bold text-text">
                  {weekdayShort(date)}
                </span>
                <PhilSkeleton className="h-4 flex-1" />
                <PhilSkeleton className="h-6 w-20 rounded-pill" />
              </li>
            ))}
          </ul>
        </div>
        <div className="sticky bottom-0 -mx-4 -mb-4 rounded-t-[20px] border-t border-border bg-surface px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-4 shadow-[0_-8px_24px_rgba(15,23,42,0.10)]">
          <PhilSkeleton className="h-14 w-full rounded-card" />
          <p className="mt-3 text-center text-[14px] text-text-muted">Loading your hours…</p>
        </div>
      </div>
    </PhilShell>
  );
}
