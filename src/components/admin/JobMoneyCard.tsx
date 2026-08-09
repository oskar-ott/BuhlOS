"use client";

import { useCallback, useEffect, useState } from "react";
import { Pencil } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
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

  return (
    <Card role="region" aria-label="Money">
      <div className="flex items-center justify-between gap-2">
        <CardTitle>Money</CardTitle>
        <span className="text-xs text-text-muted">All figures ex GST</span>
      </div>
      <CardDescription className="mt-1">
        Labour is costed at internal cost rates, office-only.
      </CardDescription>

      {state === "loading" || !data ? (
        <div className="mt-4 space-y-2.5" data-testid="money-skeleton" aria-hidden="true">
          <div className="h-9 w-3/4 animate-pulse rounded-card bg-surface-subtle" />
          <div className="h-4 w-1/2 animate-pulse rounded-card bg-surface-subtle" />
          <div className="h-16 animate-pulse rounded-card bg-surface-subtle" />
        </div>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <ContractFigure jobId={jobId} data={data} onSaved={load} />
            <Figure label="Labour" value={formatMoneyCents(data.labourCostCents)} />
            <Figure
              label="Materials"
              value={materialNone ? "—" : formatMoneyCents(data.materialCostCents)}
              muted={materialNone}
            />
            <Figure
              label={data.marginPct == null ? "Margin" : `Margin (${data.marginPct}%)`}
              value={formatMoneyCents(data.marginCents)}
              muted={data.marginCents == null}
              tone={data.marginCents != null && data.marginCents < 0 ? "bad" : undefined}
            />
          </dl>

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left font-mono text-xs uppercase tracking-wider text-text-muted">
                  <th className="pb-1 pr-2 font-normal">Against estimate</th>
                  <th className="pb-1 pr-2 text-right font-normal">Actual</th>
                  <th className="pb-1 pr-2 text-right font-normal">Estimate</th>
                  <th className="pb-1 text-right font-normal">Variance</th>
                </tr>
              </thead>
              <tbody>
                <VarianceRow label="Labour" line={data.variance.labour} />
                <VarianceRow label="Materials" line={data.variance.material} />
                <VarianceRow label="Total vs contract" line={data.variance.total} bold />
              </tbody>
            </table>
          </div>

          {/* Plain-language honesty footnotes — replaces the old "·proxy" /
              "·understated" markers nobody outside the codebase could read. */}
          <div className="mt-3 space-y-1">
            {data.completeness.unratedWorkers.length > 0 ? (
              <p className="text-xs text-text-muted">
                Labour is understated — no cost rate set for{" "}
                {data.completeness.unratedWorkers.join(", ")}. Add rates in the employee drawer to
                include their hours.
              </p>
            ) : null}
            {data.completeness.material === "received_proxy" ? (
              <p className="text-xs text-text-muted">
                Materials counts supplier orders received on this job — actual usage isn&rsquo;t
                tracked yet.
              </p>
            ) : null}
            {materialNone ? (
              <p className="text-xs text-text-muted">No materials recorded on this job yet.</p>
            ) : null}
          </div>
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
      <div className="col-span-2 sm:col-span-1">
        <label
          htmlFor="contract-value-input"
          className="font-mono text-xs uppercase tracking-wider text-text-muted"
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
      <dt className="font-mono text-xs uppercase tracking-wider text-text-muted">Contract</dt>
      <dd className="mt-0.5 flex items-center gap-1.5">
        <span className={`text-base font-semibold ${has ? "text-text" : "text-text-muted"}`}>
          {formatMoneyCents(data.contractValueCents)}
        </span>
        <button
          type="button"
          onClick={beginEdit}
          className="inline-flex items-center gap-1 rounded-card px-1 py-0.5 text-xs font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          {has ? <Pencil aria-hidden="true" className="h-3 w-3" /> : null}
          {has ? "Edit" : "Add"}
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
}: {
  label: string;
  value: string;
  muted?: boolean;
  tone?: "bad";
}) {
  return (
    <div>
      <dt className="font-mono text-xs uppercase tracking-wider text-text-muted">{label}</dt>
      <dd
        className={`mt-0.5 text-base font-semibold ${
          tone === "bad" ? "text-state-danger" : muted ? "text-text-muted" : "text-text"
        }`}
      >
        {value}
      </dd>
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
