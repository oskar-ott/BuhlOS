import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { formatHoursLabel } from "@/domains/timesheets/format";
import type { PayPeriodRollup } from "@/domains/timesheets/pay-period-rollup";
import type { workerActionMap } from "@/domains/timesheets/pay-period-view";

/**
 * Per-worker pay-period table (owner redesign 2026-08-16) — the rollup table
 * extracted verbatim from the old page body so the redesigned layout can
 * place it under its own slim "By worker" heading. Columns and honesty rules
 * unchanged: full names, OT dashes when zero, unexported hours in amber, the
 * Xero-mapping dot, and per-worker readiness off the weekly closeouts.
 */

export function WorkerRollupTable({
  rollup,
  actions,
}: {
  rollup: PayPeriodRollup;
  actions: ReturnType<typeof workerActionMap>;
}) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-surface-subtle font-mono text-[10px] uppercase tracking-[.08em] text-text-muted">
            <th className="px-4 py-3 font-medium">Worker</th>
            <th className="px-2 py-3 text-right font-medium">Approved</th>
            <th className="px-2 py-3 text-right font-medium">Ord</th>
            <th className="px-2 py-3 text-right font-medium">OT</th>
            <th className="px-2 py-3 text-right font-medium">Not exp</th>
            <th className="px-2 py-3 font-medium">Xero</th>
            <th className="px-4 py-3 font-medium">Readiness</th>
          </tr>
        </thead>
        <tbody>
          {rollup.workers.map((w) => {
            const action = actions.get(w.workerId);
            const needsAction = action?.needsAction ?? false;
            return (
              <tr key={w.workerId} className="border-b border-border/60 last:border-b-0">
                <td className="px-4 py-3">
                  <span className="block font-display text-sm font-semibold text-text">
                    {w.workerName}
                  </span>
                  <span className="block text-[11px] text-text-muted">
                    {w.approvedDayCount} day(s)
                  </span>
                </td>
                <td className="px-2 py-3 text-right tabular-nums text-text">
                  {formatHoursLabel(w.approvedHours)}
                </td>
                <td className="px-2 py-3 text-right tabular-nums text-text-muted">
                  {formatHoursLabel(w.ordinaryHours)}
                </td>
                <td className="px-2 py-3 text-right tabular-nums text-text-muted">
                  {w.overtimeHours > 0 ? formatHoursLabel(w.overtimeHours) : "—"}
                </td>
                <td className="px-2 py-3 text-right tabular-nums">
                  {w.unexportedApprovedHours > 0 ? (
                    <span className="text-amber-900">
                      {formatHoursLabel(w.unexportedApprovedHours)}
                    </span>
                  ) : (
                    <span className="text-text-muted">0h</span>
                  )}
                </td>
                <td className="px-2 py-3">
                  {w.xeroMapped ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-emerald-800">
                      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-state-success" />
                      set
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-amber-900">
                      <span aria-hidden="true" className="h-2 w-2 rounded-full bg-state-warning" />
                      No Xero id
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
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
  );
}
