import Link from "next/link";
import { AlertTriangle, CheckCircle2, FileSignature, MapPin } from "lucide-react";
import { InboxStatStrip, type InboxStat } from "./InboxShell";
import type { DayworkRegisterSummary } from "@/domains/dayworks/types";
import type { DayworkRollupJobRow } from "@/server/dayworks/register";

/**
 * Cross-job daywork rollup (#370) — the office payment-risk view across every
 * job. Pure presenter (props in, JSX out) so it render-tests without a browser.
 * Ordered payment-risk-first: the jobs with the most unsigned-aging dockets sit
 * on top, each linking into its own register. Read-only.
 *
 * §6 inbox redesign: the glanceable header is the shared InboxStatStrip (the
 * same one the other four inboxes use), replacing the old DayworkSummaryBar
 * chip row here. Every tile is derived from the EXISTING rollup props (no new
 * fetch): the docket-status counts from `summary` + the real at-risk per-job
 * count from `byJob`. A zero reads calm/muted (the shell handles that).
 *
 * OMITTED vs the prototype: the "Unsigned value $X" exposure tile — the rollup
 * summary carries docket COUNTS only (no dollar/value field on
 * DayworkRegisterSummary), so a money figure would be fabricated. The per-job
 * DayworkRegister keeps its own DayworkSummaryBar (a different surface).
 */

interface Props {
  byJob: DayworkRollupJobRow[];
  summary: DayworkRegisterSummary;
}

export function DayworkRollup({ byJob, summary }: Props) {
  const jobsAtRisk = byJob.reduce((n, row) => (row.unsignedAging > 0 ? n + 1 : n), 0);
  const stats: InboxStat[] = [
    { key: "unsigned", label: "Unsigned", value: summary.unsigned, icon: FileSignature, tone: "warning" },
    { key: "aging", label: "Aging > 24h", value: summary.unsignedAging, icon: AlertTriangle, tone: "danger" },
    { key: "jobsAtRisk", label: "Jobs at risk", value: jobsAtRisk, icon: MapPin, tone: "danger" },
    { key: "signed", label: "Signed", value: summary.signed, icon: CheckCircle2, tone: "success" },
  ];

  return (
    <div className="space-y-4">
      <InboxStatStrip stats={stats} />
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
