"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card, CardKicker } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { autoBookingReport } from "@/domains/invoices/client";
import type { ShadowReport } from "@/domains/invoices/schema";

/**
 * Task F (2026-09-27): the automatic-booking SHADOW REPORT. Every matched
 * invoice gets a would-book verdict even while automatic booking is off;
 * this compares those verdicts with what a person eventually did, names
 * every disagreement, and shows the release gate as a checklist. It reads;
 * it never changes a setting. Honesty rules: "no human outcome yet" is
 * unresolved (never correct or wrong); a verdict without a snapshot is
 * legacy/unknown (never agreement).
 */
const PERIODS = [30, 90, 180] as const;

const KIND_LABELS: Record<string, string> = {
  false_positive: "Would have booked — a person disagreed",
  false_negative: "Would have waited — a person booked it as-is",
  auto_booked_then_reversed: "Booked automatically, then reversed by a person",
};
const REASON_LABELS: Record<string, string> = {
  job_changed: "different job",
  figures_changed: "different figures",
  supplier_changed: "different supplier",
  excluded_by_person: "excluded by a person",
  reversed_by_person: "reversed by a person",
  marked_duplicate_by_person: "marked as a duplicate",
  archived_by_person: "archived",
  unspecified: "unspecified",
};
const reasonLabel = (r: string) => REASON_LABELS[r] ?? r.replace(/_/g, " ");
const GATE_LABELS: Record<string, string> = {
  sample_size: "Enough evaluated invoices",
  resolved_share: "Most of them have a human outcome",
  zero_wrong_job: "Zero would-have-booked with a different final job",
  zero_wrong_total: "Zero with different figures",
  zero_false_positives: "Zero false positives and zero reversed automatic bookings",
  no_legacy_only: "Verdicts carry a snapshot (not only legacy ones)",
};

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <div className="rounded-card border border-border p-2">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="font-display text-xl text-text tabular-nums">{value}</p>
      {hint ? <p className="text-[11px] leading-snug text-text-muted">{hint}</p> : null}
    </div>
  );
}

export function ShadowReportView({ report }: { report: ShadowReport }) {
  const wb = report.wouldHaveBooked;
  const ww = report.wouldHaveWaited;
  const reasonList = (m: Record<string, number>) =>
    Object.entries(m)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${reasonLabel(k)} ×${n}`)
      .join(", ");
  return (
    <div className="space-y-4" data-testid="shadow-report">
      <p className="text-sm text-text-muted">
        {report.period.from} → {report.period.to} · {report.invoicesInPeriod} invoices captured · automatic booking is{" "}
        <strong className="text-text">{report.autoBookingEnabled ? "ON" : "OFF"}</strong>
        {report.legacyVerdicts ? ` · ${report.legacyVerdicts} verdicts predate the snapshot (job and figures judged from history where possible, otherwise counted as unknown)` : ""}
      </p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="shadow-report-headline">
        <Stat label="Evaluated" value={report.sampleSize} hint="matched invoices with a verdict" />
        <Stat label="No human outcome yet" value={report.unresolved} hint="unresolved — never counted as right or wrong" />
        <Stat label="Never evaluated" value={report.neverEvaluated} hint="went straight to review" />
        <Stat label="Set aside" value={report.setAside} hint="dockets, orders — not invoices" />
        <Stat label="Would have booked" value={wb.count} hint={`${wb.agreed} agreed · ${wb.falsePositives} false positives · ${wb.unresolved} unresolved`} />
        <Stat label="False positives" value={wb.falsePositives + wb.autoBookedThenReversed} hint={reasonList(wb.falsePositiveReasons) || "none"} />
        <Stat label="Would have waited" value={ww.count} hint={`${ww.correct} correct · ${ww.falseNegatives} booked as-is by a person · ${ww.unresolved} unresolved`} />
        <Stat label="False negatives" value={ww.falseNegatives} hint={reasonList(ww.falseNegativeReasons) || "none"} />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="shadow-report-agreement">
          <thead>
            <tr className="text-left font-mono text-xs uppercase tracking-[0.14em] text-text-muted">
              <th className="pb-1 pr-2 font-medium">Agreement (resolved only)</th>
              <th className="pb-1 pr-2 font-medium">Agree</th>
              <th className="pb-1 pr-2 font-medium">Differ</th>
              <th className="pb-1 font-medium">Unknown</th>
            </tr>
          </thead>
          <tbody>
            {(["job", "supplier", "figures"] as const).map((dim) => (
              <tr key={dim} className="border-t border-border">
                <td className="py-1 pr-2 text-text">{dim === "figures" ? "Ex-GST amount" : dim === "job" ? "Exact job" : "Supplier"}</td>
                <td className="py-1 pr-2 tabular-nums">{report.agreement[dim].agree}</td>
                <td className="py-1 pr-2 tabular-nums">{report.agreement[dim].differ}</td>
                <td className="py-1 tabular-nums">{report.agreement[dim].unknown}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div data-testid="shadow-report-gate">
        <p className="text-sm font-semibold text-text">
          Release gate: {report.gate.pass ? "every check passes — the decision to turn automatic booking on is still yours" : "not yet"}
        </p>
        <ul className="mt-1 space-y-0.5 text-xs text-text-muted">
          {report.gate.checks.map((c) => (
            <li key={c.code}>
              <span className={c.ok ? "text-text" : ""}>{c.ok ? "✓" : "✗"}</span> {GATE_LABELS[c.code] ?? c.code} — {c.detail}
            </li>
          ))}
        </ul>
        <p className="mt-1 text-xs text-text-muted">
          Suppliers with enough clean, resolved evidence for a supplier-by-supplier start:{" "}
          {report.gate.suppliersReady.length ? report.gate.suppliersReady.filter(Boolean).join(", ") : "none yet"}. Enabling per supplier is not a switch BuhlOS has today — this list is the evidence for that decision.
        </p>
      </div>

      {report.bySupplier.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="shadow-report-suppliers">
            <thead>
              <tr className="text-left font-mono text-xs uppercase tracking-[0.14em] text-text-muted">
                <th className="pb-1 pr-2 font-medium">Supplier</th>
                <th className="pb-1 pr-2 font-medium">Evaluated</th>
                <th className="pb-1 pr-2 font-medium">Would book</th>
                <th className="pb-1 pr-2 font-medium">Agreed</th>
                <th className="pb-1 pr-2 font-medium">False +</th>
                <th className="pb-1 pr-2 font-medium">False −</th>
                <th className="pb-1 pr-2 font-medium">Unresolved</th>
                <th className="pb-1 font-medium">Auto-booked (reversed)</th>
              </tr>
            </thead>
            <tbody>
              {report.bySupplier.map((s) => (
                <tr key={s.supplierKey ?? "unknown"} className="border-t border-border">
                  <td className="py-1 pr-2 text-text">{s.supplierName ?? "(unknown supplier)"}</td>
                  <td className="py-1 pr-2 tabular-nums">{s.sample}</td>
                  <td className="py-1 pr-2 tabular-nums">{s.wouldHaveBooked}</td>
                  <td className="py-1 pr-2 tabular-nums">{s.agreed}</td>
                  <td className="py-1 pr-2 tabular-nums">{s.falsePositives}</td>
                  <td className="py-1 pr-2 tabular-nums">{s.falseNegatives}</td>
                  <td className="py-1 pr-2 tabular-nums">{s.unresolved}</td>
                  <td className="py-1 tabular-nums">
                    {s.autoBooked} ({s.autoBookedThenReversed})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {report.disagreements.length ? (
        <ul className="space-y-1 text-sm" data-testid="shadow-report-disagreements">
          {report.disagreements.map((d) => (
            <li key={d.invoiceId} className="flex flex-wrap items-baseline gap-x-2">
              <Link href={`/invoices/${encodeURIComponent(d.invoiceId)}` as Route} className="underline decoration-accent-yellow decoration-2 underline-offset-2">
                {d.supplierName ?? "Unknown supplier"}
                {d.supplierInvoiceNumber ? ` #${d.supplierInvoiceNumber}` : ""}
              </Link>
              <span className="text-text-muted">{KIND_LABELS[d.kind] ?? d.kind}</span>
              <span className="text-xs text-text-muted">({d.reasons.map(reasonLabel).join(", ") || "no reason recorded"})</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-text-muted">No disagreements in this period.</p>
      )}
    </div>
  );
}

export function AutoBookingShadowCard() {
  const [days, setDays] = useState<(typeof PERIODS)[number]>(90);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [report, setReport] = useState<ShadowReport | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setState("loading");
    const res = await autoBookingReport(days);
    if (!res.ok) {
      setState(res.error.status === 401 || res.error.status === 403 || res.error.status === 404 ? "hidden" : "error");
      return;
    }
    setReport(res.data);
    setState("ready");
  }, [days]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  if (state === "hidden") return null;
  return (
    <Card data-testid="auto-booking-shadow-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardKicker>Automatic booking — shadow report</CardKicker>
        <div className="flex items-center gap-1">
          {open
            ? PERIODS.map((p) => (
                <Button key={p} size="sm" variant={p === days ? "primary" : "ghost"} onClick={() => setDays(p)} data-testid={`shadow-period-${p}`}>
                  {p} days
                </Button>
              ))
            : null}
          <Button size="sm" variant="secondary" onClick={() => setOpen((o) => !o)} data-testid="shadow-report-toggle">
            {open ? "Hide" : "Show"}
          </Button>
        </div>
      </div>
      <p className="mt-1 text-xs text-text-muted">
        Every matched invoice gets a would-book verdict even while automatic booking is off. This compares those verdicts with what a
        person did, so the decision to turn it on can rest on evidence. It changes nothing.
      </p>
      {open ? (
        state === "loading" ? (
          <div className="mt-3 h-10 animate-pulse rounded bg-surface-subtle" data-testid="shadow-report-skeleton" />
        ) : state === "error" ? (
          <p className="mt-3 text-sm text-text-muted">Could not load the report just now.</p>
        ) : report ? (
          <div className="mt-3">
            <ShadowReportView report={report} />
          </div>
        ) : null
      ) : null}
    </Card>
  );
}
