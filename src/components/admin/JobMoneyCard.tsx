"use client";

import { useCallback, useEffect, useId, useState } from "react";
import type { Route } from "next";
import { Card, CardKicker } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { updateJob } from "@/domains/jobs/client";
import { formatHoursLabel } from "@/domains/timesheets/format";
import { JOB_MONEY_CHANGED_EVENT } from "@/domains/jobs/job-materials-client";
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
 * each fetched the same endpoint (2026-08-09 job-hub audit, finding A2).
 *
 * Honesty rules (2026-08-23 audit, findings L2/U2/U4 — the card used to say
 * "no hours yet" over 252 approved hours, hide its own "labour is understated"
 * note behind a variance table no job could reach, and link "Add an estimate"
 * to a builder with no estimate field):
 *   - Every caption states what is TRUE: "252h approved · no cost rates set",
 *     never "no hours yet" when hours exist.
 *   - The completeness notes (unrated workers — linked to the employee record
 *     the rate is set on — materials source, charge-out value) render in EVERY
 *     state, not only under the variance table.
 *   - Estimates are set INLINE here (the same admin-only PUT the contract
 *     value uses); the variance table appears the moment one exists.
 *   - A margin is never more certain than its inputs: uncosted labour is named
 *     beside it.
 *   - A failed read says so and offers a retry; only a 401/403 (a viewer who
 *     mustn't see money) hides the card.
 *
 * Contract value is edited inline (ContractFigure): the same dedicated PUT the
 * builder's ClientContractSection uses (dollars in; the server ×100s to cents),
 * admin-gated server-side.
 *
 * Admin-tier only: the endpoint 403s otherwise and the card hides rather than
 * show an error to an LH who shouldn't see money. The sibling Materials card
 * announces ledger writes on `window` (JOB_MONEY_CHANGED_EVENT); this card
 * refetches so the Materials figure follows without a reload.
 */

export function JobMoneyCard({
  jobId,
  materialsLedgerEnabled = false,
}: {
  jobId: string;
  /** The job_materials_spend flag, resolved by the server page — shapes the
   *  Materials caption ("nothing recorded yet" vs "not tracked yet"). */
  materialsLedgerEnabled?: boolean;
}) {
  const [data, setData] = useState<JobProfitabilityResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await jobProfitability(jobId);
    if (!res.ok) {
      // 401/403 (non-admin) → hide rather than leak a money surface. Anything
      // else is a real failure the owner should see — not a vanished card.
      if (res.error.status === 403 || res.error.status === 401) {
        setState("hidden");
        return false;
      }
      setErrorMessage(
        res.error.status > 0
          ? `API returned ${res.error.status}`
          : res.error.message || "network error"
      );
      setState((prev) => (prev === "ready" ? prev : "error"));
      return false;
    }
    setData(res.data);
    setErrorMessage(null);
    setState("ready");
    return true;
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onChanged = (ev: Event) => {
      const detail = (ev as CustomEvent<{ jobId?: string }>).detail;
      if (!detail?.jobId || detail.jobId === jobId) void load();
    };
    window.addEventListener(JOB_MONEY_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(JOB_MONEY_CHANGED_EVENT, onChanged);
  }, [jobId, load]);

  if (state === "hidden") return null;

  return (
    <Card role="region" aria-label="Money" className="p-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
        <CardKicker>Money</CardKicker>
        <p className="text-xs text-text-muted">
          All figures ex GST · labour at internal cost rates, office-only
        </p>
      </div>

      {state === "error" ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-4 sm:px-6">
          <p className="text-sm text-text-muted" role="alert">
            Couldn&rsquo;t load the money figures ({errorMessage ?? "unknown error"}).
          </p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : state === "loading" || !data ? (
        <MoneySkeleton />
      ) : (
        <JobMoneyFigures
          jobId={jobId}
          data={data}
          materialsLedgerEnabled={materialsLedgerEnabled}
          onSaved={load}
        />
      )}
    </Card>
  );
}

// Money-strip cell borders: 2×2 on the phone, one divided row from sm up.
const CELLS = [
  "border-b border-r border-border sm:border-b-0 sm:border-r-0",
  "border-b border-border sm:border-b-0 sm:border-l",
  "border-r border-border sm:border-r-0 sm:border-l",
  "border-border sm:border-l",
];

function MoneySkeleton() {
  // 2c: shimmer at the EXACT final heights so nothing jumps when data lands.
  return (
    <div data-testid="money-skeleton" aria-hidden="true">
      <div className="mt-4 grid grid-cols-2 border-t border-border sm:grid-cols-4">
        {["w-28", "w-24", "w-24", "w-20"].map((w, i) => (
          <div key={w + i} className={cn("px-4 py-3 sm:px-6 sm:py-4", CELLS[i])}>
            <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
              {["Contract", "Labour", "Materials", "Margin"][i]}
            </p>
            <div className={cn("sk mt-1 h-[26px]", w)} />
            <div className="sk mt-1.5 h-3.5 w-24" />
          </div>
        ))}
      </div>
      <div className="border-t border-border px-4 py-4 sm:px-6">
        <div className="grid gap-2.5">
          <div className="sk h-3.5 w-72 max-w-full" />
          <div className="sk h-3.5 w-56 max-w-full" />
        </div>
      </div>
    </div>
  );
}

/**
 * The loaded card body — a pure function of the profitability payload, so the
 * render tests pin every state (the prod state the audit found included).
 */
export function JobMoneyFigures({
  jobId,
  data,
  materialsLedgerEnabled = false,
  onSaved,
}: {
  jobId: string;
  data: JobProfitabilityResponse;
  materialsLedgerEnabled?: boolean;
  onSaved: () => Promise<boolean>;
}) {
  const approvedHours = data.hoursTotal;
  const labourZero = data.labourCostCents <= 0;
  const labourUnderstated = data.completeness.labour === "understated";
  const materialSource = data.completeness.material;
  const materialNone = materialSource === "none";
  const hasEstimates =
    data.budget.labourEstimateCents != null || data.budget.materialEstimateCents != null;

  const labourCaption = labourZero
    ? approvedHours > 0
      ? `${formatHoursLabel(approvedHours)} approved · no cost rates set`
      : "no approved hours yet"
    : labourUnderstated
      ? `${formatHoursLabel(approvedHours)} approved · some hours uncosted`
      : `${formatHoursLabel(approvedHours)} approved`;

  const materialCaption =
    materialSource === "ledger"
      ? "from the spend ledger"
      : materialSource === "received_proxy"
        ? "supplier orders received · proxy"
        : materialSource === "consumption"
          ? "actual usage"
          : materialsLedgerEnabled
            ? "nothing recorded yet"
            : "not tracked yet";

  const marginCaption =
    data.marginCents != null && (labourUnderstated || (labourZero && approvedHours > 0))
      ? "before uncosted labour"
      : undefined;

  return (
    <>
      <dl className="mt-4 grid grid-cols-2 border-t border-border sm:grid-cols-4">
        <div className={cn("px-4 py-3 sm:px-6 sm:py-4", CELLS[0])}>
          <ContractFigure jobId={jobId} data={data} onSaved={onSaved} />
        </div>
        <div className={cn("px-4 py-3 sm:px-6 sm:py-4", CELLS[1])}>
          <Figure
            label="Labour"
            value={labourZero ? "—" : formatMoneyCents(data.labourCostCents)}
            muted={labourZero}
            caption={labourCaption}
          />
        </div>
        <div className={cn("px-4 py-3 sm:px-6 sm:py-4", CELLS[2])}>
          <Figure
            label="Materials"
            value={materialNone ? "—" : formatMoneyCents(data.materialCostCents)}
            muted={materialNone}
            caption={materialCaption}
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
            tone={data.marginCents == null ? undefined : data.marginCents < 0 ? "bad" : "good"}
            caption={marginCaption}
          />
        </div>
      </dl>

      {/* Completeness notes — ALWAYS rendered (audit L2): the reader must never
          take a figure as more certain than its inputs. */}
      <div className="space-y-1 border-t border-border px-4 py-3 sm:px-6" data-testid="money-notes">
        {data.unratedWorkerRefs.length > 0 ? (
          <p className="text-xs text-text-muted">
            Labour is understated — no cost rate set for{" "}
            <UnratedWorkerLinks refs={data.unratedWorkerRefs} />. Set each rate on the
            worker&rsquo;s employee record and their hours are costed from the day the rate starts.
          </p>
        ) : null}
        {data.labourChargeOutCents != null ? (
          <p className="text-xs text-text-muted">
            {`At charge-out rates this labour is worth ${formatMoneyCents(data.labourChargeOutCents)}${
              data.chargeOutHours < approvedHours
                ? ` (${formatHoursLabel(data.chargeOutHours)} of ${formatHoursLabel(approvedHours)} carry a charge-out rate)`
                : ""
            }.`}
          </p>
        ) : null}
        {materialSource === "ledger" ? (
          <p className="text-xs text-text-muted">
            Materials are this job&rsquo;s recorded spend — every docket in the Materials card
            below.
          </p>
        ) : materialSource === "received_proxy" ? (
          <p className="text-xs text-text-muted">
            Materials counts supplier orders received on this job — actual usage isn&rsquo;t
            tracked.
          </p>
        ) : materialNone ? (
          <p className="text-xs text-text-muted">
            {materialsLedgerEnabled
              ? "No materials spend recorded on this job yet — add dockets in the Materials card below."
              : "Materials spend isn't tracked on this job yet."}
          </p>
        ) : null}
      </div>

      {hasEstimates ? (
        <VarianceTable jobId={jobId} data={data} onSaved={onSaved} />
      ) : (
        <EstimatesPrompt jobId={jobId} data={data} onSaved={onSaved} />
      )}
    </>
  );
}

function UnratedWorkerLinks({ refs }: { refs: JobProfitabilityResponse["unratedWorkerRefs"] }) {
  return (
    <>
      {refs.map((w, i) => (
        <span key={w.userId}>
          {i > 0 ? ", " : ""}
          {w.employeeId ? (
            <a
              href={`/employees/${encodeURIComponent(w.employeeId)}` as Route}
              className="font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
            >
              {w.name}
            </a>
          ) : (
            <span className="font-medium text-text">{w.name}</span>
          )}
        </span>
      ))}
    </>
  );
}

function VarianceTable({
  jobId,
  data,
  onSaved,
}: {
  jobId: string;
  data: JobProfitabilityResponse;
  onSaved: () => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="overflow-x-auto border-t border-border px-4 py-4 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
          Against estimate
        </p>
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
          >
            Edit estimates
          </button>
        ) : null}
      </div>
      {editing ? (
        <EstimatesEditor
          jobId={jobId}
          data={data}
          onSaved={onSaved}
          onClose={() => setEditing(false)}
        />
      ) : (
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
              <th className="pb-1.5 pr-2 font-medium">Line</th>
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
      )}
    </div>
  );
}

function EstimatesPrompt({
  jobId,
  data,
  onSaved,
}: {
  jobId: string;
  data: JobProfitabilityResponse;
  onSaved: () => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="border-t border-border px-4 py-4 sm:px-6">
      {editing ? (
        <EstimatesEditor
          jobId={jobId}
          data={data}
          onSaved={onSaved}
          onClose={() => setEditing(false)}
        />
      ) : (
        <p className="text-sm text-text-muted">
          No estimates on this job.{" "}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
          >
            Set labour and materials estimates
          </button>{" "}
          and actual-vs-estimate variance appears here.
        </p>
      )}
    </div>
  );
}

/**
 * Inline labour / materials estimate editor (audit U2 — "Add an estimate" used
 * to link to a builder with no such field). Dollars in, like the contract
 * value; the same admin-only patch PUT; blank = clear (null). Reloads the
 * profitability read on save so the variance lines pick the values up.
 */
function EstimatesEditor({
  jobId,
  data,
  onSaved,
  onClose,
}: {
  jobId: string;
  data: JobProfitabilityResponse;
  onSaved: () => Promise<boolean>;
  onClose: () => void;
}) {
  const ids = useId();
  const [labour, setLabour] = useState(
    data.budget.labourEstimateCents != null ? String(data.budget.labourEstimateCents / 100) : ""
  );
  const [material, setMaterial] = useState(
    data.budget.materialEstimateCents != null ? String(data.budget.materialEstimateCents / 100) : ""
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function parseDollars(raw: string): number | null | undefined {
    const t = raw.trim();
    if (!t) return null;
    const n = Number(t.replace(/^\$/, ""));
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }

  async function save() {
    const labourEstimate = parseDollars(labour);
    const materialEstimate = parseDollars(material);
    if (labourEstimate === undefined || materialEstimate === undefined) {
      setError("Enter each estimate in dollars, or leave it blank.");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await updateJob({ id: jobId, labourEstimate, materialEstimate });
    if (!result.ok) {
      setBusy(false);
      setError("Couldn't save — try again.");
      return;
    }
    await onSaved();
    setBusy(false);
    onClose();
  }

  const inputClass =
    "h-8 w-full rounded-card border border-border bg-surface px-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy";

  return (
    <div className="mt-2 grid gap-2" data-testid="estimates-editor">
      <div className="grid grid-cols-2 gap-2">
        <label
          htmlFor={`${ids}-labour`}
          className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted"
        >
          Labour estimate ($ ex GST)
          <input
            id={`${ids}-labour`}
            type="text"
            inputMode="decimal"
            value={labour}
            onChange={(e) => setLabour(e.target.value)}
            disabled={busy}
            placeholder="12000"
            className={cn(inputClass, "mt-1 font-sans normal-case tracking-normal")}
          />
        </label>
        <label
          htmlFor={`${ids}-material`}
          className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted"
        >
          Materials estimate ($ ex GST)
          <input
            id={`${ids}-material`}
            type="text"
            inputMode="decimal"
            value={material}
            onChange={(e) => setMaterial(e.target.value)}
            disabled={busy}
            placeholder="8000"
            className={cn(inputClass, "mt-1 font-sans normal-case tracking-normal")}
          />
        </label>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="sm" onClick={() => void save()} disabled={busy}>
          Save estimates
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
      {error ? (
        <p className="text-xs text-state-danger-subtle-text" role="alert">
          {error}
        </p>
      ) : null}
    </div>
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
      {!has ? <p className="mt-1 text-xs text-text-muted">no contract value yet</p> : null}
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
