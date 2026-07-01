import Link from "next/link";
import type { Route } from "next";
import { AlertTriangle, CheckCircle2, FileSignature, MapPin } from "lucide-react";
import { InboxStatStrip, type InboxStat } from "./InboxShell";
import { DayworkDocketRow } from "./DayworkRegister";
import type { Daywork, DayworkRegisterSummary } from "@/domains/dayworks/types";
import type { DayworkRollupJobRow } from "@/server/dayworks/register";

/**
 * Cross-job daywork rollup (#370) — the office payment-risk view across every
 * job. Pure presenter (props in, JSX out) so it render-tests without a browser.
 * Read-only.
 *
 * §6 inbox redesign: the glanceable header is the shared InboxStatStrip (the
 * same one the other four inboxes use). Below it sits a per-job summary band
 * (each job links into its own register, payment-risk-first) and then the
 * EVERY-DOCKET list — exception-first across all jobs — rendering the SAME
 * `DayworkDocketRow` the per-job register uses, with a job link on each row.
 * Brand tokens throughout (no raw slate/red palette).
 *
 * The server loader (loadDayworkRollup) already computes `dockets` (exception-
 * first) and `byJob`; the page passes both plus `nowMs` so the aging marks are
 * deterministic and match the server summary.
 *
 * OMITTED vs the prototype: any "$ value / unsigned exposure" figure — the
 * Daywork schema carries labour HOURS only (no rate on a labour line), so a
 * dollar figure would be fabricated (P7, no invented numbers). Hours is the
 * honest record and the rows show it.
 */

interface Props {
  /** Per-job summary band (payment-risk-first). */
  byJob: DayworkRollupJobRow[];
  /** Every docket across all jobs, exception-first (the server's ordering). */
  dockets: Daywork[];
  /** Aggregate payment-risk summary across all jobs. */
  summary: DayworkRegisterSummary;
  /** Injected so aging marks match the server summary deterministically. */
  nowMs: number;
}

export function DayworkRollup({ byJob, dockets, summary, nowMs }: Props) {
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
        <p className="rounded-card border border-dashed border-border bg-surface p-6 text-sm text-text-muted">
          No daywork dockets across any job yet. They&rsquo;re raised from site in Phil and signed by
          the builder&rsquo;s supervisor — unsigned ones show here as payment risk.
        </p>
      ) : (
        <>
          {/* Per-job summary band — the at-a-glance "which jobs carry risk", each
              a link into that job's own register. */}
          <div className="rounded-card border border-border bg-surface">
            <p className="border-b border-border px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
              By job
            </p>
            <ul className="divide-y divide-border">
              {byJob.map((row) => (
                <li key={row.jobId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Link
                    href={`/v2/jobs/${encodeURIComponent(row.jobId)}/dayworks` as Route}
                    className="font-medium text-text underline decoration-accent-yellow decoration-2 underline-offset-2"
                  >
                    {row.jobName || row.jobId}
                  </Link>
                  <span className="text-xs text-text-muted">
                    {row.total} {row.total === 1 ? "docket" : "dockets"} · {row.unsigned} unsigned ·{" "}
                    {row.signed} signed · {row.invoiced} invoiced
                  </span>
                  {row.unsignedAging > 0 ? (
                    <span className="ml-auto rounded-pill bg-rose-50 px-3 py-1 text-xs font-semibold text-rose-800">
                      {row.unsignedAging} aging — payment risk
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>

          {/* Every docket across all jobs, exception-first — the same row the
              per-job register uses, with a job link. */}
          <ul className="divide-y divide-border rounded-card border border-border bg-surface" data-testid="daywork-rollup-dockets">
            {dockets.map((d) => (
              <DayworkDocketRow
                key={d.id}
                docket={d}
                nowMs={nowMs}
                jobName={d.jobName ?? null}
                jobHref={`/v2/jobs/${encodeURIComponent(d.jobId)}/dayworks`}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
