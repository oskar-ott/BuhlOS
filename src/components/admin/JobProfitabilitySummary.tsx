"use client";

import { useEffect, useState } from "react";
import { Card, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import {
  formatMoneyCents,
  jobProfitability,
  type JobProfitabilityResponse,
} from "@/domains/jobs/profitability-client";

/**
 * Per-job profitability card (#327) on the admin job hub. Revenue − labour −
 * material = margin, with an HONEST completeness statement — a margin is never
 * shown as more certain than its inputs (unrated workers named, materials
 * labelled a proxy, no contract value stated rather than faked).
 *
 * Admin-tier only (the endpoint 403s otherwise → the card shows nothing rather
 * than an error to an LH who shouldn't see money). Fetches lazily on mount so
 * the expensive per-job hours walk never blocks the hub's server render.
 */

export function JobProfitabilitySummary({ jobId }: { jobId: string }) {
  const [data, setData] = useState<JobProfitabilityResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await jobProfitability(jobId);
      if (cancelled) return;
      if (!res.ok) {
        // 403 (non-admin) or any error → hide the card rather than leak a money
        // surface or show a scary error on a read-only summary.
        setState("hidden");
        return;
      }
      setData(res.data);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (state === "hidden") return null;

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <CardTitle>Profitability</CardTitle>
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          cost-rate based · ex GST
        </span>
      </div>

      {state === "loading" || !data ? (
        <p className="mt-2 text-sm text-text-muted">Loading…</p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Figure label="Contract" value={formatMoneyCents(data.contractValueCents)} muted={data.contractValueCents == null} />
            <Figure label="Labour" value={formatMoneyCents(data.labourCostCents)} />
            <Figure label="Materials" value={data.completeness.material === "none" ? "—" : formatMoneyCents(data.materialCostCents)} muted={data.completeness.material === "none"} />
            <Figure
              label={data.marginPct == null ? "Margin" : `Margin (${data.marginPct}%)`}
              value={formatMoneyCents(data.marginCents)}
              muted={data.marginCents == null}
              tone={data.marginCents != null && data.marginCents < 0 ? "bad" : undefined}
            />
          </dl>

          <div className="mt-3 flex flex-wrap gap-1.5">
            {data.badges.map((b) => (
              <Pill key={b} tone={b.includes("unrated") || b.includes("no contract") ? "warning" : "neutral"}>
                {b}
              </Pill>
            ))}
          </div>

          {data.completeness.unratedWorkers.length > 0 ? (
            <p className="mt-2 text-xs text-text-muted">
              Labour understated — no cost rate for{" "}
              {data.completeness.unratedWorkers.join(", ")}. Set a rate in the
              employee drawer to include their hours.
            </p>
          ) : null}
          {data.contractValueCents == null ? (
            <p className="mt-2 text-xs text-text-muted">
              No contract value set — add one on the job to see margin.
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

function Figure({
  label,
  value,
  muted,
  tone,
}: {
  label: string;
  value: string;
  muted?: boolean;
  tone?: "bad";
}) {
  return (
    <div>
      <dt className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</dt>
      <dd className={`mt-0.5 text-base font-semibold ${tone === "bad" ? "text-rose-700" : muted ? "text-text-muted" : "text-text"}`}>
        {value}
      </dd>
    </div>
  );
}
