"use client";

import { useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui/Card";
import {
  formatMoneyCents,
  jobProfitability,
  type BudgetLine,
  type JobProfitabilityResponse,
} from "@/domains/jobs/profitability-client";

/**
 * Per-job budget variance (#341) on the admin job hub: labour / materials / total
 * spend, each as actual vs budget with the variance $ and %. Reuses the #327
 * profitability endpoint (margin and variance are two views of the same money
 * module). Complements the Labour card (pending-approval framing) — this is
 * $-vs-budget. Admin-tier only; hidden for an LH viewer. A line with no budget
 * reads "no estimate set", never a fabricated 0-variance.
 */
export function JobBudgetVarianceCard({ jobId }: { jobId: string }) {
  const [data, setData] = useState<JobProfitabilityResponse | null>(null);
  const [view, setView] = useState<"loading" | "ready" | "hidden">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await jobProfitability(jobId);
      if (cancelled) return;
      if (!res.ok) {
        setView("hidden");
        return;
      }
      setData(res.data);
      setView("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (view === "hidden") return null;

  return (
    <Card role="region" aria-label="Budget variance">
      <div className="flex items-center justify-between gap-2">
        <CardTitle>Budget vs actual</CardTitle>
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">ex GST</span>
      </div>
      {view === "loading" || !data ? (
        <p className="mt-2 text-sm text-text-muted">Loading…</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase tracking-wider text-text-muted">
                <th className="pb-1 pr-2 font-normal">Line</th>
                <th className="pb-1 pr-2 text-right font-normal">Actual</th>
                <th className="pb-1 pr-2 text-right font-normal">Budget</th>
                <th className="pb-1 text-right font-normal">Variance</th>
              </tr>
            </thead>
            <tbody>
              <Row label="Labour" line={data.variance.labour} understated={data.completeness.labour === "understated"} />
              <Row label="Materials" line={data.variance.material} proxy={data.completeness.material === "received_proxy"} noData={data.completeness.material === "none"} />
              <Row label="Total vs contract" line={data.variance.total} bold />
            </tbody>
          </table>
          {data.completeness.unratedWorkers.length > 0 ? (
            <p className="mt-2 text-xs text-text-muted">
              Labour understated — no cost rate for {data.completeness.unratedWorkers.join(", ")}.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function Row({
  label,
  line,
  bold,
  understated,
  proxy,
  noData,
}: {
  label: string;
  line: BudgetLine;
  bold?: boolean;
  understated?: boolean;
  proxy?: boolean;
  noData?: boolean;
}) {
  const over = line.varianceCents != null && line.varianceCents > 0;
  const note = understated ? " ·understated" : proxy ? " ·proxy" : noData ? " ·no data" : "";
  return (
    <tr className="border-t border-border">
      <td className={`py-1.5 pr-2 ${bold ? "font-semibold text-text" : "text-text"}`}>
        {label}
        {note ? <span className="font-mono text-[10px] text-text-muted">{note}</span> : null}
      </td>
      <td className="py-1.5 pr-2 text-right tabular-nums">{formatMoneyCents(line.actualCents)}</td>
      <td className="py-1.5 pr-2 text-right tabular-nums text-text-muted">
        {line.budgetCents == null ? "no estimate set" : formatMoneyCents(line.budgetCents)}
      </td>
      <td className={`py-1.5 text-right tabular-nums ${line.varianceCents == null ? "text-text-muted" : over ? "text-rose-700" : "text-emerald-700"}`}>
        {line.varianceCents == null
          ? "—"
          : `${over ? "+" : ""}${formatMoneyCents(line.varianceCents)}${line.variancePct != null ? ` (${line.variancePct > 0 ? "+" : ""}${line.variancePct}%)` : ""}`}
      </td>
    </tr>
  );
}
