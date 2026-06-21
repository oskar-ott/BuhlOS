import { dayworkStatusLabel, dayworkLineSummary } from "@/domains/dayworks/format";
import { isUnsignedAging } from "@/domains/dayworks/service";
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
 */

const STATUS_CLASS: Record<string, string> = {
  unsigned: "bg-amber-100 text-amber-900",
  signed: "bg-emerald-100 text-emerald-900",
  invoiced: "bg-slate-200 text-slate-700",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        STATUS_CLASS[status] ?? "bg-slate-100 text-slate-700"
      }`}
    >
      {dayworkStatusLabel(status as Daywork["status"])}
    </span>
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
          className="inline-flex items-center rounded-full bg-red-100 px-3 py-1 font-semibold text-red-900"
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
    <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-slate-700">
      <span className="font-semibold text-slate-900">{value}</span>
      <span>{label}</span>
    </span>
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
        <p className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-500">
          No daywork dockets on this job yet. They&rsquo;re raised from site in Phil and signed by the
          builder&rsquo;s supervisor — unsigned ones show here as payment risk.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {dockets.map((d) => {
            const aging = isUnsignedAging(d, nowMs);
            return (
              <li key={d.id} className="flex flex-col gap-1 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold text-slate-900">{d.ref}</span>
                  <StatusPill status={d.status} />
                  {aging ? (
                    <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-900">
                      Aging — chase the signature
                    </span>
                  ) : null}
                  {d.amended ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      Amended
                    </span>
                  ) : null}
                  {d.amendmentOfId ? (
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      Amendment
                    </span>
                  ) : null}
                  <span className="ml-auto text-xs text-slate-500">{String(d.date).slice(0, 10)}</span>
                </div>
                <p className="text-sm text-slate-800">{d.description}</p>
                <p className="text-xs text-slate-500">{dayworkLineSummary(d)}</p>
                {d.signature ? (
                  <p className="text-xs text-slate-500">
                    Signed by {d.signature.supervisorName} · {String(d.signature.signedAt).slice(0, 10)}
                  </p>
                ) : null}
                {d.status === "invoiced" && d.invoiceRef ? (
                  <p className="text-xs text-slate-500">Invoice {d.invoiceRef}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
