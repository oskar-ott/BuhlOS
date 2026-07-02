"use client";

import { useEffect, useState } from "react";
import {
  completeWorkbookReview,
  confirmWorkbookClassification,
  fetchQuoteWorkbookImport,
  resolveWorkbookFinding,
} from "@/domains/job-doc-import/client";
import {
  WORKBOOK_CLASSIFICATIONS,
  WORKBOOK_CLASSIFICATION_LABEL,
  WORKBOOK_FINDING_LABEL,
  type WorkbookClassification,
  type WorkbookImportRecord,
} from "@/domains/job-doc-import/schema";

/**
 * #365 — the quote's workbook-import review card (flag-dark: the page mounts
 * this only when `job_doc_import` is on and the viewer is admin-tier).
 *
 * Hidden-until-real: renders NOTHING for a quote with no import. Otherwise it
 * shows the honest review state — "imported — N findings, M unconfirmed
 * classifications" — with every named finding (cell provenance included)
 * resolve/waive-able, every classification default human-confirmable, the
 * superseded-upload history, and the mark-review-complete action. There is no
 * fake clean state: completing review stamps the counts at completion.
 */
export function QuoteWorkbookImportCard({ quoteId }: { quoteId: string }) {
  const [record, setRecord] = useState<WorkbookImportRecord | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchQuoteWorkbookImport(quoteId).then((r) => {
      if (!alive) return;
      setRecord(r.workbookImport);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, [quoteId]);

  if (!loaded || !record) return null;
  return <QuoteWorkbookImportBody record={record} onRecord={setRecord} />;
}

function money(n: number | null): string {
  if (n == null) return "—";
  return "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The rendered body (exported for the SSR render test). */
export function QuoteWorkbookImportBody({
  record,
  onRecord,
}: {
  record: WorkbookImportRecord;
  onRecord: (r: WorkbookImportRecord) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { current, status, review } = record;
  const parse = current.parse;
  const confirmedByLine = new Map(record.confirmations.map((c) => [c.lineId, c]));
  const resolutionByFinding = new Map(record.resolutions.map((r) => [r.findingId, r]));

  async function run(fn: () => Promise<WorkbookImportRecord>) {
    setErr(null);
    setBusy(true);
    try {
      onRecord(await fn());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      data-testid="quote-workbook-import-card"
      className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">Imported workbook</h2>
        {review.status === "complete" ? (
          <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-800">
            review complete — {review.completedBy} ({review.openFindingsAtCompletion ?? 0} findings,{" "}
            {review.unconfirmedAtCompletion ?? 0} unconfirmed at sign-off)
          </span>
        ) : (
          <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-900">
            imported — {status.openFindings} finding{status.openFindings === 1 ? "" : "s"},{" "}
            {status.unconfirmedClassifications} unconfirmed classification
            {status.unconfirmedClassifications === 1 ? "" : "s"}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {current.fileName ?? "workbook"} · {parse.counts.lines} line
        {parse.counts.lines === 1 ? "" : "s"} · imported by {current.importedByName}
        {record.superseded.length > 0 &&
          ` · supersedes ${record.superseded.length} earlier upload${record.superseded.length === 1 ? "" : "s"}`}
      </p>

      {/* Totals: base NEVER includes alternates/exclusions/PC/by-others. */}
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <div className="rounded-md border border-slate-200 p-2">
          <div className="text-xs text-slate-500">Base total (confirmed scope)</div>
          <div className="text-lg font-semibold tabular-nums text-slate-900">
            {money(parse.totals.base)}
          </div>
        </div>
        <div className="rounded-md border border-slate-200 p-2">
          <div className="text-xs text-slate-500">All lines</div>
          <div className="text-lg font-semibold tabular-nums text-slate-900">
            {money(parse.totals.all)}
          </div>
        </div>
        <div className="rounded-md border border-slate-200 p-2">
          <div className="text-xs text-slate-500">Workbook states</div>
          <div className="text-lg font-semibold tabular-nums text-slate-900">
            {money(parse.totals.stated)}
            {parse.totals.reconciles === false && parse.totals.delta != null && (
              <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                off by {money(Math.abs(parse.totals.delta))}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Named findings with cell provenance — each resolve/waive-able. */}
      {parse.findings.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm font-semibold text-slate-800">Health findings</h3>
          <ul className="mt-2 space-y-2">
            {parse.findings.map((f) => {
              const resolution = resolutionByFinding.get(f.id);
              return (
                <li
                  key={f.id}
                  className={`rounded-md border p-2 text-sm ${
                    resolution
                      ? "border-slate-200 bg-slate-50 text-slate-500"
                      : f.severity === "error"
                        ? "border-red-200 bg-red-50 text-red-900"
                        : "border-amber-200 bg-amber-50 text-amber-900"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded bg-white/70 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide">
                      {WORKBOOK_FINDING_LABEL[f.kind] ?? f.kind}
                    </span>
                    <span className="font-mono text-xs">{f.cellRef}</span>
                    {resolution && (
                      <span className="text-xs">
                        {resolution.action} by {resolution.by}
                        {resolution.reason ? ` — ${resolution.reason}` : ""}
                      </span>
                    )}
                  </div>
                  <p className={`mt-1 ${resolution ? "line-through" : ""}`}>{f.message}</p>
                  {!resolution && (
                    <div className="mt-1.5 flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run(() => resolveWorkbookFinding(record.quoteId, f.id, "resolved"))
                        }
                        className="rounded bg-slate-900 px-2 py-1 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
                      >
                        Resolved
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run(() => resolveWorkbookFinding(record.quoteId, f.id, "waived"))
                        }
                        className="rounded border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                      >
                        Waive
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Lines: classification defaults, each human-confirmable. */}
      <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">Cell</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Rate</th>
              <th className="px-3 py-2 text-right">Subtotal</th>
              <th className="px-3 py-2">Classification</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {parse.lines.map((l) => {
              const confirmed = confirmedByLine.get(l.id);
              const effective = confirmed ? confirmed.classification : l.classification;
              return (
                <tr key={l.id} className={confirmed ? undefined : "bg-amber-50/40"}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-500">
                    {l.sheet}!{l.cells.description.split("!")[1] ?? l.cells.description}
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    <span className="line-clamp-2">{l.description}</span>
                    {l.section && <span className="block text-xs text-slate-400">{l.section}</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{l.qty ?? "—"}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(l.rate)}</td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {money(l.subtotal ?? l.lineTotal)}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <select
                        aria-label={`Classification for ${l.description.slice(0, 40)}`}
                        value={effective}
                        disabled={busy}
                        onChange={(e) =>
                          run(() =>
                            confirmWorkbookClassification(
                              record.quoteId,
                              l.id,
                              e.target.value as WorkbookClassification
                            )
                          )
                        }
                        className="rounded border border-slate-300 px-1.5 py-1 text-xs"
                      >
                        {WORKBOOK_CLASSIFICATIONS.map((c) => (
                          <option key={c} value={c}>
                            {WORKBOOK_CLASSIFICATION_LABEL[c]}
                          </option>
                        ))}
                      </select>
                      {confirmed ? (
                        <span className="text-xs text-emerald-700">✓ {confirmed.by}</span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            run(() =>
                              confirmWorkbookClassification(record.quoteId, l.id, effective)
                            )
                          }
                          className="rounded border border-slate-300 px-1.5 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
                        >
                          Confirm
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Superseded uploads — the kept record, never a silent second copy. */}
      {record.superseded.length > 0 && (
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
          <span className="font-medium">Superseded uploads:</span>{" "}
          {record.superseded
            .map(
              (s) =>
                `${s.fileName ?? "workbook"} (${s.lineCount} lines, ${s.findingCount} findings, by ${s.importedByName})`
            )
            .join(" · ")}
        </div>
      )}

      {err && (
        <div className="mt-3 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-800" role="alert">
          {err}
        </div>
      )}

      {review.status !== "complete" && (
        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="text-xs text-slate-500">
            The quote stays &ldquo;imported — findings pending&rdquo; until an admin completes the
            review. Completing it stamps the open counts — nothing is silently cleared.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => completeWorkbookReview(record.quoteId))}
            className="shrink-0 rounded-md bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            Mark review complete
          </button>
        </div>
      )}
    </section>
  );
}
