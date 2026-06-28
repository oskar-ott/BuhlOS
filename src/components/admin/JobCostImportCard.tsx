"use client";

import { useEffect, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { fetchJobCostImport } from "@/domains/job-doc-import/client";
import type { CostImportSummary } from "@/domains/job-doc-import/schema";

/**
 * Job-hub cost-basis card (#365). When a job was created from a BOQ import, the
 * priced bill is attached as its cost basis — this surfaces the headline so the
 * import visibly pays off: the imported total, line/package counts, whether the
 * lines reconcile to the stated total (the discrepancy is shown, never hidden),
 * and the provenance (which workbook, who imported it).
 *
 * Hidden-until-real: a job that wasn't BOQ-imported renders NOTHING (most jobs).
 * Self-fetches like JobBudgetVarianceCard; the page gates the mount on the
 * `job_doc_import` flag + admin tier, and the GET endpoint 404s when the flag is
 * dark — so the card is doubly invisible until the feature goes live.
 *
 * Money is whole dollars (2dp), matching what the BOQ parser emits — this bill
 * is a supplier/tender figure, not the integer-cents money module.
 */
export function JobCostImportCard({ jobId }: { jobId: string }) {
  const [costImport, setCostImport] = useState<CostImportSummary | null>(null);
  const [view, setView] = useState<"loading" | "ready" | "hidden">("loading");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetchJobCostImport(jobId);
      if (cancelled) return;
      if (!res.ok || !res.costImport) {
        setView("hidden");
        return;
      }
      setCostImport(res.costImport);
      setView("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  // Render nothing while loading too — an optional card shouldn't flash a
  // skeleton on the many jobs that have no import; it just appears when real.
  if (view !== "ready" || !costImport) return null;
  return <CostImportCardBody costImport={costImport} />;
}

/** Presentational body (exported for render tests) — given the summary, no fetch. */
export function CostImportCardBody({ costImport }: { costImport: CostImportSummary }) {
  const { total, lines, sections, reconciles, delta, stated, fileName, importedByName, importedAt } =
    costImport;
  return (
    <Card role="region" aria-label="Imported cost estimate">
      <div className="flex items-center justify-between gap-2">
        <CardTitle>Imported cost estimate</CardTitle>
        <ReconcileChip reconciles={reconciles} delta={delta} />
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums text-text">{money(total)}</p>
      <CardDescription>
        {lines} priced line{lines === 1 ? "" : "s"} across {sections} package
        {sections === 1 ? "" : "s"}
        {stated != null ? ` · stated ${money(stated)}` : ""}
      </CardDescription>
      {fileName || importedByName ? (
        <p className="mt-2 text-xs text-text-muted">
          {[
            fileName ? `from ${fileName}` : null,
            importedByName ? `imported by ${importedByName}` : null,
            importedAt ? prettyDate(importedAt) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
    </Card>
  );
}

function ReconcileChip({
  reconciles,
  delta,
}: {
  reconciles: boolean | null;
  delta: number | null;
}) {
  if (reconciles == null) {
    return (
      <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
        no stated total
      </span>
    );
  }
  if (reconciles) {
    return (
      <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">reconciles</span>
    );
  }
  return (
    <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
      off by {money(delta == null ? null : Math.abs(delta))}
    </span>
  );
}

/** Whole-dollar (2dp) money — the BOQ parser's unit, NOT integer cents. */
function money(n: number | null): string {
  if (n == null) return "—";
  return "$" + n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** ISO timestamp → "1 Aug 2026" (UTC, so SSR + client agree). */
function prettyDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
