import Link from "next/link";
import { DayworkSummaryBar } from "./DayworkRegister";
import type { DayworkRegisterSummary } from "@/domains/dayworks/types";
import type { DayworkRollupJobRow } from "@/server/dayworks/register";

/**
 * Cross-job daywork rollup (#370) — the office payment-risk view across every
 * job. Pure presenter (props in, JSX out) so it render-tests without a browser.
 * Ordered payment-risk-first: the jobs with the most unsigned-aging dockets sit
 * on top, each linking into its own register. Read-only.
 */

interface Props {
  byJob: DayworkRollupJobRow[];
  summary: DayworkRegisterSummary;
}

export function DayworkRollup({ byJob, summary }: Props) {
  return (
    <div className="space-y-4">
      <DayworkSummaryBar summary={summary} />
      {byJob.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
          No daywork dockets across any job yet.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {byJob.map((row) => (
            <li key={row.jobId} className="flex flex-wrap items-center gap-3 p-4">
              <Link
                href={`/v2/jobs/${encodeURIComponent(row.jobId)}/dayworks`}
                className="font-medium text-slate-900 underline decoration-accent-yellow decoration-2 underline-offset-2"
              >
                {row.jobName || row.jobId}
              </Link>
              <span className="text-xs text-slate-500">
                {row.total} {row.total === 1 ? "docket" : "dockets"} · {row.unsigned} unsigned ·{" "}
                {row.signed} signed · {row.invoiced} invoiced
              </span>
              {row.unsignedAging > 0 ? (
                <span className="ml-auto rounded-full bg-red-100 px-3 py-1 text-xs font-semibold text-red-900">
                  {row.unsignedAging} aging — payment risk
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
