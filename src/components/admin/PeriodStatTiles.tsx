import { cn } from "@/lib/cn";
import { formatHoursLabel } from "@/domains/timesheets/format";

/**
 * Pay-period stat tiles (owner redesign 2026-08-16, "BuhlOS Hours Replica") —
 * the period's four headline numbers as tiles instead of a metrics card.
 * A tile runs "hot" (amber) when it deserves a look: any overtime, or
 * approved hours not yet snapshotted into a payroll run.
 */

interface Summary {
  approvedHours: number;
  ordinaryHours: number;
  overtimeHours: number;
  unexportedApprovedHours: number;
}

export function PeriodStatTiles({ summary }: { summary: Summary }) {
  const tiles = [
    { label: "Approved hours", value: formatHoursLabel(summary.approvedHours), hot: false },
    { label: "Ordinary", value: formatHoursLabel(summary.ordinaryHours), hot: false },
    { label: "Overtime", value: formatHoursLabel(summary.overtimeHours), hot: summary.overtimeHours > 0 },
    {
      label: "Not in a run yet",
      value: formatHoursLabel(summary.unexportedApprovedHours),
      hot: summary.unexportedApprovedHours > 0,
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="period-stat-tiles">
      {tiles.map((t) => (
        <div
          key={t.label}
          className={cn(
            "rounded-card border p-4",
            t.hot ? "border-amber-200 bg-amber-50" : "border-border bg-surface-raised shadow-card",
          )}
        >
          <p className="font-mono text-[11px] uppercase tracking-[.12em] text-text-muted">{t.label}</p>
          <p
            className={cn(
              "mt-1 font-display text-2xl font-semibold tabular-nums",
              t.hot ? "text-amber-700" : "text-text",
            )}
          >
            {t.value}
          </p>
        </div>
      ))}
    </div>
  );
}
