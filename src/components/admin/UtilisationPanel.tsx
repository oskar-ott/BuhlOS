"use client";

import { useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { fetchUtilisation, type UtilisationResponse } from "@/domains/analytics/utilisation-client";

/**
 * Crew utilisation panel (#342) on /reports. Multi-week utilisation per worker
 * against REAL expected hours (7.6h × Mon–Fri = 38h), plus a crew capacity
 * roll-up ("can we take this job"). Reads the admin-only endpoint; excluded
 * weeks (before a worker existed) render "—", never a fake 0%.
 */
export function UtilisationPanel() {
  const [data, setData] = useState<UtilisationResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchUtilisation(8);
      if (cancelled) return;
      if (!res.ok) {
        setState("error");
        return;
      }
      setData(res.data);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card role="region" aria-label="Crew utilisation">
      <CardTitle>Crew utilisation</CardTitle>
      <CardDescription className="mt-1">
        Logged vs expected hours (7h36 × working days), trailing 8 weeks. Approved
        + submitted; weeks before a worker started are excluded, not shown as 0%.
      </CardDescription>

      {state === "loading" ? (
        <p className="mt-3 text-sm text-text-muted">Loading…</p>
      ) : state === "error" || !data ? (
        <p className="mt-3 text-sm text-text-muted">Couldn&rsquo;t load utilisation.</p>
      ) : (
        <>
          <div className="mt-3 rounded-card border border-border bg-surface px-3 py-2" data-testid="utilisation-crew">
            <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              Crew capacity this week ({data.crew.workers} tracked)
            </div>
            <div className="mt-0.5 text-sm text-text">
              {data.crew.approvedHours + data.crew.submittedHours} / {data.crew.expectedHours}h ·{" "}
              <span className={data.crew.spareHours < 0 ? "text-rose-700" : "text-emerald-700"}>
                {data.crew.spareHours < 0
                  ? `${Math.abs(data.crew.spareHours)}h over`
                  : `${data.crew.spareHours}h spare`}
              </span>
            </div>
          </div>

          {data.workers.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">No hours-tracked workers.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase tracking-wider text-text-muted">
                    <th className="pb-1 pr-2 font-normal">Worker</th>
                    {data.weeks.map((w) => (
                      <th key={w} className="pb-1 px-1 text-right font-normal">
                        {w.slice(5)}
                      </th>
                    ))}
                    <th className="pb-1 pl-2 text-right font-normal">Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {data.workers.map((worker) => (
                    <tr key={worker.userId} className="border-t border-border">
                      <td className="py-1.5 pr-2 text-text">{worker.name}</td>
                      {worker.weeks.map((wk) => (
                        <td
                          key={wk.weekStart}
                          className={`py-1.5 px-1 text-right tabular-nums ${
                            wk.pct == null ? "text-text-muted" : wk.pct < 60 ? "text-amber-700" : "text-text"
                          }`}
                        >
                          {wk.pct == null ? "—" : `${wk.pct}%`}
                        </td>
                      ))}
                      <td className="py-1.5 pl-2 text-right font-semibold tabular-nums text-text">
                        {worker.avgPct == null ? "—" : `${worker.avgPct}%`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
