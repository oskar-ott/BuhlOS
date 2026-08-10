"use client";

import { useCallback, useEffect, useState } from "react";
import type { Route } from "next";
import { Card, CardKicker } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { updateJob } from "@/domains/jobs/client";
import {
  formatMoneyCents,
  jobProfitability,
  type BudgetLine,
  type JobProfitabilityResponse,
} from "@/domains/jobs/profitability-client";

/**
 * The job hub's ONE money card — contract, labour, materials, margin, and the
 * budget-vs-actual variance lines beneath, all off a single
 * /api/job-profitability fetch.
 *
 * Replaces the #327 Profitability card + #341 Budget-vs-actual card, which
 * each fetched the same endpoint (2026-08-09 job-hub audit, finding A2: two
 * cards, one endpoint, twice the expensive approved-hours walk, and labour /
 * materials / contract each appearing twice on the page with no verdict).
 *
 * Honesty rules are unchanged from #327: a margin is never shown as more
 * certain than its inputs — unrated workers are named, proxy materials are
 * footnoted in plain language, a missing contract value reads "—" with an
 * inline way to add one (the biggest ask the old card made without offering
 * the affordance — audit finding B8). Contract value is the one editable
 * field here: the same dedicated PUT the builder's ClientContractSection
 * uses (dollars in; the server ×100s to cents), admin-gated server-side.
 *
 * Admin-tier only: the endpoint 403s otherwise and the card hides rather
 * than show an error to an LH who shouldn't see money.
 */

export function JobMoneyCard({ jobId }: { jobId: string }) {
  const [data, setData] = useState<JobProfitabilityResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden">("loading");

  const load = useCallback(async () => {
    const res = await jobProfitability(jobId);
    if (!res.ok) {
      // 403 (non-admin) or any error → hide the card rather than leak a money
      // surface or show a scary error on a read-only summary.
      setState("hidden");
      return false;
    }
    setData(res.data);
    setState("ready");
    return true;
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "hidden") return null;

  const materialNone = data?.completeness.material === "none";
  // 2d "Absence is designed": zero labour cost means no costed hours yet — an
  // em-dash + a sentence about what will appear, never a fake "$0" figure.
  const labourNone = data != null && (data.labourCostCents == null || data.labourCostCents === 0);
  // No estimate anywhere → one designed sentence instead of an all-dash table.
  const noEstimates =
    data != null &&
    data.variance.labour.budgetCents == null &&
    data.variance.material.budgetCents == null &&
    data.variance.total.budgetCents == null;

  // Money-strip cell borders: 2×2 on the phone, one divided row from sm up.
  const CELLS = [
    "border-b border-r border-border sm:border-b-0 sm:border-r-0",
    "border-b border-border sm:border-b-0 sm:border-l",
    "border-r border-border sm:border-r-0 sm:border-l",
    "border-border sm:border-l",
  ];

  return (
    <Card role="region" aria-label="Money" className="p-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
        <CardKicker>Money</CardKicker>
        <p className="text-xs text-text-muted">
          All figures ex GST · labour at internal cost rates, office-only
        </p>
      </div>

      {state === "loading" || !data ? (
        // 2c: shimmer at the EXACT final heights so nothing jumps when data lands.
        <div data-testid="money-skeleton" aria-hidden="true">
          <div className="mt-4 grid grid-cols-2 border-t border-border sm:grid-cols-4">
            {["w-28", "w-24", "w-24", "w-20"].map((w, i) => (
              <div key={w + i} className={cn("px-4 py-3 sm:px-6 sm:py-4", CELLS[i])}>
                <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
                  {["Contract", "Labour", "Materials", "Margin"][i]}
                </p>
                <div className={cn("sk mt-1 h-[26px]", w)} />
              </div>
            ))}
          </div>
          <div className="border-t border-border px-4 py-4 sm:px-6">
            <div className="flex justify-between">
              <div className="sk h-3.5 w-32" />
              <div className="sk h-3.5 w-56" />
            </div>
            <div className="mt-3 grid gap-2.5">
              <div className="sk h-4 w-full" />
              <div className="sk h-4 w-full" />
              <div className="sk h-4 w-[72%]" />
            </div>
          </div>
        </div>
      ) : (
        <>
          <dl className="mt-4 grid grid-cols-2 border-t border-border sm:grid-cols-4">
            <div className={cn("px-4 py-3 sm:px-6 sm:py-4", CELLS[0])}>
              <ContractFigure jobId={jobId} data={data} onSaved={load} />
            </div>
            <div className={cn("px-4 py-3 sm:px-6 sm:py-4", CELLS[1])}>
              <Figure
                label="Labour"
                value={labourNone ? "—" : formatMoneyCents(data.labourCostCents)}
                muted={labourNone}
                caption={labourNone ? "no hours yet" : undefined}
              />
            </div>
            <div className={cn("px-4 py-3 sm:px-6 sm:py-4", CELLS[2])}>
              <Figure
                label="Materials"
                value={materialNone ? "—" : formatMoneyCents(data.materialCostCents)}
                muted={materialNone}
                caption={materialNone ? "no orders yet" : undefined}
              />
            </div>
            <div
              className={cn(
                "px-4 py-3 sm:px-6 sm:py-4",
                CELLS[3],
                // The margin cell is the only tinted one — and only when the
                // numbers are real (2f §02).
                data.marginCents != null &&
                  (data.marginCents < 0 ? "bg-state-danger-subtle-bg" : "bg-state-success-subtle-bg")
              )}
            >
              <Figure
                label={data.marginPct == null ? "Margin" : `Margin · ${data.marginPct}%`}
                value={formatMoneyCents(data.marginCents)}
                muted={data.marginCents == null}
                tone={
                  data.marginCents == null ? undefined : data.marginCents < 0 ? "bad" : "good"
                }
              />
            </div>
          </dl>

          {noEstimates ? (
            <div className="border-t border-border px-4 py-5 sm:px-6">
              <p className="text-sm text-text-muted">
                No estimate on this job.{" "}
                <a
                  href={`/v2/jobs/${encodeURIComponent(jobId)}/builder` as Route}
                  className="font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
                >
                  Add an estimate
                </a>{" "}
                and actual-vs-estimate variance appears here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto border-t border-border px-4 py-4 sm:px-6">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
                    <th className="pb-1.5 pr-2 font-medium">Against estimate</th>
                    <th className="pb-1.5 pr-2 text-right font-medium">Actual</th>
                    <th className="pb-1.5 pr-2 text-right font-medium">Estimate</th>
                    <th className="pb-1.5 text-right font-medium">Variance</th>
                  </tr>
                </thead>
                <tbody>
                  <VarianceRow label="Labour" line={data.variance.labour} />
                  <VarianceRow label="Materials" line={data.variance.material} />
                  <VarianceRow label="Total vs contract" line={data.variance.total} bold />
                </tbody>
              </table>

              {/* Plain-language honesty footnotes — replaces the old "·proxy" /
                  "·understated" markers nobody outside the codebase could read. */}
              <div className="mt-3 space-y-1">
                {data.completeness.unratedWorkers.length > 0 ? (
                  <p className="text-xs text-text-muted">
                    Labour is understated — no cost rate set for{" "}
                    {data.completeness.unratedWorkers.join(", ")}. Add rates in the employee drawer
                    to include their hours.
                  </p>
                ) : null}
                {data.completeness.material === "received_proxy" ? (
                  <p className="text-xs text-text-muted">
                    Materials counts supplier orders received on this job — actual usage
                    isn&rsquo;t tracked yet.
                  </p>
                ) : null}
                {materialNone ? (
                  <p className="text-xs text-text-muted">No materials recorded on this job yet.</p>
                ) : null}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Contract figure with the inline add/edit affordance. Dollars in the input —
 * the same unit ClientContractSection uses; the server converts for the
 * cents-based views. Saving PUTs just { id, contractValue } (a patch PUT —
 * other fields untouched), then reloads the profitability read so margin and
 * total-variance pick the new value up server-side.
 */
function ContractFigure({
  jobId,
  data,
  onSaved,
}: {
  jobId: string;
  data: JobProfitabilityResponse;
  onSaved: () => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const has = data.contractValueCents != null;

  function beginEdit() {
    setValue(has ? String(data.contractValueCents! / 100) : "");
    setError(null);
    setEditing(true);
  }

  async function save() {
    const dollars = Number(value);
    if (!Number.isFinite(dollars) || dollars < 0) {
      setError("Enter the value in dollars.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await updateJob({ id: jobId, contractValue: dollars });
    if (!result.ok) {
      setBusy(false);
      setError("Couldn't save — try again.");
      return;
    }
    await onSaved();
    setBusy(false);
    setEditing(false);
  }

  if (editing) {
    return (
      <div>
        <label
          htmlFor="contract-value-input"
          className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted"
        >
          Contract ($ ex GST)
        </label>
        <div className="mt-0.5 flex items-center gap-1.5">
          <input
            id="contract-value-input"
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={busy}
            className="h-8 w-28 rounded-card border border-border bg-surface px-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy"
            // eslint-disable-next-line jsx-a11y/no-autofocus -- the field only exists after an explicit edit click
            autoFocus
          />
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
        {error ? (
          <p className="mt-1 text-xs text-state-danger-subtle-text" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <dt className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
        Contract
      </dt>
      <dd className="mt-1 flex items-baseline gap-2">
        <span
          className={cn(
            "font-display text-[26px] font-bold tabular-nums leading-none",
            has ? "text-text" : "text-text-muted"
          )}
        >
          {formatMoneyCents(data.contractValueCents)}
        </span>
        <button
          type="button"
          onClick={beginEdit}
          className="text-xs font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          {has ? "Edit" : "Set value"}
        </button>
      </dd>
    </div>
  );
}

function Figure({
  label,
  value,
  muted,
  tone,
  caption,
}: {
  label: string;
  value: string;
  muted?: boolean;
  tone?: "bad" | "good";
  caption?: string;
}) {
  return (
    <div>
      <dt
        className={cn(
          "font-mono text-xs font-medium uppercase tracking-[0.14em]",
          tone === "good"
            ? "text-state-success-subtle-text"
            : tone === "bad"
              ? "text-state-danger-subtle-text"
              : "text-text-muted"
        )}
      >
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 font-display text-[26px] font-bold tabular-nums leading-none",
          tone === "good"
            ? "text-state-success-subtle-text"
            : tone === "bad"
              ? "text-state-danger-subtle-text"
              : muted
                ? "text-text-muted"
                : "text-text"
        )}
      >
        {value}
      </dd>
      {caption ? <p className="mt-1 text-xs text-text-muted">{caption}</p> : null}
    </div>
  );
}

function VarianceRow({ label, line, bold }: { label: string; line: BudgetLine; bold?: boolean }) {
  const over = line.varianceCents != null && line.varianceCents > 0;
  return (
    <tr className="border-t border-border">
      <td className={`py-1.5 pr-2 ${bold ? "font-semibold text-text" : "text-text"}`}>{label}</td>
      <td className="py-1.5 pr-2 text-right tabular-nums">{formatMoneyCents(line.actualCents)}</td>
      <td className="py-1.5 pr-2 text-right tabular-nums text-text-muted">
        {line.budgetCents == null ? "No estimate" : formatMoneyCents(line.budgetCents)}
      </td>
      <td
        className={`py-1.5 text-right tabular-nums ${
          line.varianceCents == null
            ? "text-text-muted"
            : over
              ? "text-state-danger-subtle-text"
              : "text-state-success-subtle-text"
        }`}
      >
        {line.varianceCents == null
          ? "—"
          : `${over ? "+" : ""}${formatMoneyCents(line.varianceCents)}${
              line.variancePct != null
                ? ` (${line.variancePct > 0 ? "+" : ""}${line.variancePct}%)`
                : ""
            }`}
      </td>
    </tr>
  );
}
