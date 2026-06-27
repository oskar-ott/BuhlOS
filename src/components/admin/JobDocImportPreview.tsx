"use client";

import { useState, type ChangeEvent } from "react";
import { requestBoqImportPreview } from "@/domains/job-doc-import/client";
import {
  BOQ_FLAG_LABEL,
  type BoqFlagKind,
  type BoqImportPreview,
  type BoqRecon,
} from "@/domains/job-doc-import/schema";

/**
 * #365 — read-only pricing/BOQ workbook import preview.
 *
 * Pick a .xlsx pricing sheet → see it parsed into packages, priced lines, a
 * commercial reconciliation (do the lines sum to the stated total?) and an
 * ambiguities list (supplied-by-others, VE, PC-sums, "needs clarification",
 * long-lead, excluded). NOTHING is saved — this is a review surface only.
 */
export function JobDocImportPreview() {
  const [preview, setPreview] = useState<BoqImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setLoading(true);
    setPreview(null);
    try {
      setPreview(await requestBoqImportPreview(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the workbook");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>Read-only preview.</strong> Nothing here is saved. Review the lines and the flags
        below before any of it becomes job data.
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium text-slate-700">
          Pricing / BOQ workbook (.xlsx)
        </span>
        <input
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={onPick}
          className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-700"
        />
      </label>

      {loading && <p className="text-sm text-slate-500">Reading {fileName}…</p>}
      {error && (
        <div
          className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          role="alert"
        >
          {error}
        </div>
      )}

      {preview && <PreviewBody preview={preview} fileName={fileName} />}
    </div>
  );
}

function money(n: number | null): string {
  if (n == null) return "—";
  return "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function ReconBadge({ recon }: { recon: BoqRecon }) {
  if (recon.reconciles == null) {
    return (
      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
        no stated total
      </span>
    );
  }
  if (recon.reconciles) {
    return (
      <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">
        reconciles
      </span>
    );
  }
  return (
    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
      off by {money(recon.delta)}
    </span>
  );
}

function PreviewBody({
  preview,
  fileName,
}: {
  preview: BoqImportPreview;
  fileName: string | null;
}) {
  const flagKinds = Object.keys(preview.counts.byFlag) as BoqFlagKind[];
  return (
    <div className="space-y-5">
      <p className="text-sm text-slate-500">
        {fileName} · {preview.counts.lines} priced line{preview.counts.lines === 1 ? "" : "s"}{" "}
        across {preview.sections.length} package{preview.sections.length === 1 ? "" : "s"}
      </p>

      {/* Commercial reconciliation */}
      <div className="grid gap-3 sm:grid-cols-3">
        {preview.sections.map((s) => (
          <div key={s.key} className="rounded-lg border border-slate-200 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium capitalize text-slate-800">{s.key}</span>
              <ReconBadge recon={s} />
            </div>
            <div className="mt-1 text-lg font-semibold text-slate-900">{money(s.computed)}</div>
            <div className="text-xs text-slate-500">
              {s.lineCount} lines · stated {money(s.stated)}
            </div>
          </div>
        ))}
        <div className="rounded-lg border border-slate-300 bg-slate-50 p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-800">Grand total</span>
            <ReconBadge recon={preview.totals} />
          </div>
          <div className="mt-1 text-lg font-semibold text-slate-900">
            {money(preview.totals.computed)}
          </div>
          <div className="text-xs text-slate-500">stated {money(preview.totals.stated)}</div>
        </div>
      </div>

      {/* Ambiguities to resolve */}
      {flagKinds.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-3">
          <h3 className="text-sm font-semibold text-slate-800">
            Needs a human before it becomes scope
          </h3>
          <div className="mt-2 flex flex-wrap gap-2">
            {flagKinds.map((k) => (
              <span
                key={k}
                className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700"
              >
                {BOQ_FLAG_LABEL[k] ?? k}: {preview.counts.byFlag[k]}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Lines */}
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-2">Code</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Supply</th>
              <th className="px-3 py-2 text-right">Install</th>
              <th className="px-3 py-2 text-right">Line total</th>
              <th className="px-3 py-2">Flags</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {preview.lines.map((l, i) => (
              <tr key={i} className={l.flags.length ? "bg-amber-50/40" : undefined}>
                <td className="px-3 py-2 font-mono text-xs text-slate-700">{l.code ?? "—"}</td>
                <td className="px-3 py-2 text-slate-700">
                  <span className="line-clamp-2">{l.description}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{l.qty}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(l.supplyAmount)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(l.installAmount)}</td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">
                  {money(l.lineTotal)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {l.flags.map((f) => (
                      <span
                        key={f}
                        className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-900"
                      >
                        {BOQ_FLAG_LABEL[f as BoqFlagKind] ?? f}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
