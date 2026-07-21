import Link from "next/link";
import type { Route } from "next";
import { dayworkStatusLabel, dayworkLineSummary } from "@/domains/dayworks/format";
import { isUnsignedAging } from "@/domains/dayworks/service";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import type { Daywork, DayworkRegisterSummary } from "@/domains/dayworks/types";

/**
 * Read-only admin daywork register (#370). Pure presenter — props in, JSX out —
 * so it render-tests without a browser. The live data is loaded server-side by
 * src/server/dayworks/register.ts and the writes happen through api/dayworks.js;
 * this surface only SHOWS the dockets and the payment risk. Site language (P11):
 * "Unsigned", "Aging — chase the signature", plain words a supervisor reads.
 *
 * `nowMs` is passed in (not read here) so the aging marks are deterministic and
 * match the server's summary.
 *
 * §6 inbox redesign: brand tokens throughout (text-text / border-border /
 * rounded-card / shared StatusChip), matching the other four inboxes — the old
 * raw slate/red Tailwind palette is gone. The docket row is exported as
 * `DayworkDocketRow` so the cross-job rollup (DayworkRollup) renders the SAME
 * row treatment, optionally with a job link.
 */

const STATUS_TONE: Record<Daywork["status"], StatusTone> = {
  unsigned: "warning",
  signed: "success",
  invoiced: "neutral",
};

function StatusPill({ status }: { status: Daywork["status"] }) {
  return (
    <StatusChip tone={STATUS_TONE[status] ?? "neutral"} uppercase={false}>
      {dayworkStatusLabel(status)}
    </StatusChip>
  );
}

/** The payment-risk summary bar — shared by the per-job register and the rollup. */
export function DayworkSummaryBar({ summary }: { summary: DayworkRegisterSummary }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="daywork-summary">
      <Chip label="Dockets" value={summary.total} />
      <Chip label="Unsigned" value={summary.unsigned} />
      <Chip label="Signed" value={summary.signed} />
      <Chip label="Invoiced" value={summary.invoiced} />
      {summary.unsignedAging > 0 ? (
        <span
          className="inline-flex items-center rounded-pill bg-rose-50 px-3 py-1 font-semibold text-rose-800"
          role="status"
        >
          {summary.unsignedAging} aging &gt; 24h — payment risk
        </span>
      ) : null}
    </div>
  );
}

function Chip({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-pill bg-surface-subtle px-3 py-1 text-text-muted">
      <span className="font-semibold text-text">{value}</span>
      <span>{label}</span>
    </span>
  );
}

/**
 * One docket row — the shared treatment for the per-job register and the
 * cross-job rollup. Shows ref · (optional job) · description · hours · status ·
 * date · aging badge. NO money: the Daywork schema carries labour HOURS only
 * (no rate), so a $ figure would be fabricated (P7) — hours is the honest record.
 *
 * `jobHref`/`jobName` are set only by the rollup (so the row links into the
 * job's own register); the per-job register omits them.
 */
export function DayworkDocketRow({
  docket: d,
  nowMs,
  jobName,
  jobHref,
}: {
  docket: Daywork;
  nowMs: number;
  jobName?: string | null;
  jobHref?: string;
}) {
  const aging = isUnsignedAging(d, nowMs);
  return (
    <li className="flex flex-col gap-1 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm font-semibold text-text">{d.ref}</span>
        {jobName !== undefined ? (
          jobHref ? (
            <Link
              href={jobHref as Route}
              className="font-medium text-text underline decoration-accent-yellow decoration-2 underline-offset-2"
            >
              {jobName || d.jobId}
            </Link>
          ) : (
            <span className="font-medium text-text">{jobName || d.jobId}</span>
          )
        ) : null}
        <StatusPill status={d.status} />
        {aging ? (
          <span className="rounded-pill bg-rose-50 px-2 py-0.5 text-xs font-semibold text-rose-800">
            Aging — chase the signature
          </span>
        ) : null}
        {d.amended ? (
          <span className="rounded-pill bg-surface-subtle px-2 py-0.5 text-xs text-text-muted">
            Amended
          </span>
        ) : null}
        {d.amendmentOfId ? (
          <span className="rounded-pill bg-surface-subtle px-2 py-0.5 text-xs text-text-muted">
            Amendment
          </span>
        ) : null}
        <span className="ml-auto font-mono text-xs text-text-muted">{String(d.date).slice(0, 10)}</span>
      </div>
      <p className="text-sm text-text">{d.description}</p>
      <p className="text-xs text-text-muted">{dayworkLineSummary(d)}</p>
      {d.signature ? (
        <p className="text-xs text-text-muted">
          Signed by {d.signature.supervisorName} · {String(d.signature.signedAt).slice(0, 10)}
        </p>
      ) : null}
      {d.status === "invoiced" && d.invoiceRef ? (
        <p className="text-xs text-text-muted">Invoice {d.invoiceRef}</p>
      ) : null}
    </li>
  );
}

interface Props {
  dockets: Daywork[];
  summary: DayworkRegisterSummary;
  nowMs: number;
}

export function DayworkRegister({ dockets, summary, nowMs }: Props) {
  return (
    <div className="space-y-4">
      <DayworkSummaryBar summary={summary} />
      {dockets.length === 0 ? (
        <p className="rounded-card border border-dashed border-border bg-surface p-6 text-sm text-text-muted">
          No daywork dockets on this job yet. They&rsquo;re raised from site in the field app and signed by the
          builder&rsquo;s supervisor — unsigned ones show here as payment risk.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border bg-surface">
          {dockets.map((d) => (
            <DayworkDocketRow key={d.id} docket={d} nowMs={nowMs} />
          ))}
        </ul>
      )}
    </div>
  );
}
