"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Seg } from "@/components/ui/Seg";
import { addStage, editStage, errorCodeOf } from "@/domains/customer-invoices/client";
import {
  bpToInput,
  centsToInput,
  errorMessage,
  formatBp,
  formatCents,
  parseDollarsToCents,
  parsePercentToBp,
} from "@/domains/customer-invoices/format";
import type {
  JobInvoicingResponse,
  Stage,
  StageInput,
} from "@/domains/customer-invoices/schema";

const MAX_EXTRA_LINES = 20;
const INPUT =
  "h-10 w-full rounded-card border border-border bg-surface px-3 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy";
const LABEL = "block text-sm font-medium text-text";

interface LineDraft {
  key: number;
  description: string;
  amount: string;
}

/** amount × bp / 10000, half-up to the cent — the same integer rounding the
 *  server uses (api/_lib/customer-invoices/amounts.js portionCents). */
export function portionCents(amountCents: number, bp: number): number {
  return Math.floor((amountCents * bp + 5000) / 10000);
}

/**
 * Turn the form's typed values into a StageInput, or name what is wrong.
 * Pure, so the render tests pin every refusal.
 */
export function buildStageInput(form: {
  title: string;
  basis: "amount" | "percent";
  amount: string;
  percent: string;
  lines: ReadonlyArray<{ description: string; amount: string }>;
  plannedDate: string;
  retentionBp: number | null;
  note: string | null;
}): { ok: true; input: StageInput } | { ok: false; field: string; message: string } {
  const title = form.title.trim();
  if (!title) return { ok: false, field: "title", message: "Give the stage a name." };
  if (title.length > 200) return { ok: false, field: "title", message: "Keep the name under 200 characters." };

  let amountCents: number | null = null;
  let percentBp: number | null = null;
  if (form.basis === "amount") {
    amountCents = parseDollarsToCents(form.amount);
    if (amountCents == null) {
      return { ok: false, field: "amount", message: "Enter the amount in dollars, e.g. 12000 or 12000.50." };
    }
  } else {
    percentBp = parsePercentToBp(form.percent);
    if (percentBp == null) {
      return { ok: false, field: "percent", message: "Enter a percentage between 0 and 100, e.g. 20." };
    }
  }

  const extraLines = [];
  for (const l of form.lines) {
    const description = l.description.trim();
    if (!description && !l.amount.trim()) continue; // an untouched blank row
    if (!description) return { ok: false, field: "lines", message: "Each extra line needs a description." };
    const cents = parseDollarsToCents(l.amount);
    if (cents == null) {
      return { ok: false, field: "lines", message: `Enter a dollar amount for "${description}".` };
    }
    extraLines.push({ description, amountCents: cents });
  }

  if (form.plannedDate && !/^\d{4}-\d{2}-\d{2}$/.test(form.plannedDate)) {
    return { ok: false, field: "plannedDate", message: "Pick a valid date." };
  }

  return {
    ok: true,
    input: {
      title,
      basis: form.basis,
      amountCents,
      percentBp,
      extraLines,
      retentionBp: form.retentionBp,
      plannedDate: form.plannedDate || null,
      note: form.note,
    },
  };
}

/**
 * Add or edit a PLANNED stage. The amount is dollars or a % of the contract;
 * extra lines carry things like an approved variation. A live line under the
 * form shows what the stage works out to before it is saved.
 */
export function StageEditor({
  jobId,
  contractCents,
  jobRetentionBp,
  stage,
  onClose,
  onSaved,
  onStale,
}: {
  jobId: string;
  contractCents: number | null;
  jobRetentionBp: number;
  /** null = adding a new stage. */
  stage: Stage | null;
  onClose: () => void;
  onSaved: (next: JobInvoicingResponse) => void;
  onStale: () => Promise<void> | void;
}) {
  const [title, setTitle] = useState(stage?.title ?? "");
  const [basis, setBasis] = useState<"amount" | "percent">(stage?.basis ?? "amount");
  const [amount, setAmount] = useState(centsToInput(stage?.amountCents));
  const [percent, setPercent] = useState(bpToInput(stage?.percentBp));
  const [lines, setLines] = useState<LineDraft[]>(
    (stage?.extraLines ?? []).map((l, i) => ({
      key: i,
      description: l.description,
      amount: centsToInput(l.amountCents),
    }))
  );
  const [nextKey, setNextKey] = useState((stage?.extraLines ?? []).length);
  const [plannedDate, setPlannedDate] = useState(stage?.plannedDate ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ field: string; message: string } | null>(null);

  // A stage keeps whatever retention override and note it already carries;
  // this form does not edit them, so it must not wipe them either.
  const retentionBp = stage ? stage.retentionBp : null;
  const built = buildStageInput({
    title,
    basis,
    amount,
    percent,
    lines,
    plannedDate,
    retentionBp,
    note: stage?.note ?? null,
  });

  // What it works out to, live — only when every typed figure is usable.
  let preview: { grossCents: number; retentionCents: number; netCents: number } | null = null;
  let needsContract = false;
  if (built.ok) {
    const i = built.input;
    const base =
      i.basis === "percent"
        ? contractCents == null
          ? null
          : portionCents(contractCents, i.percentBp ?? 0)
        : (i.amountCents ?? null);
    needsContract = i.basis === "percent" && contractCents == null;
    if (base != null) {
      const gross = base + (i.extraLines ?? []).reduce((s, l) => s + l.amountCents, 0);
      const effBp = retentionBp == null ? jobRetentionBp : retentionBp;
      const ret = portionCents(gross, effBp);
      preview = { grossCents: gross, retentionCents: ret, netCents: gross - ret };
    }
  }
  const effectiveRetentionBp = retentionBp == null ? jobRetentionBp : retentionBp;

  async function save() {
    if (!built.ok) {
      setProblem({ field: built.field, message: built.message });
      return;
    }
    setBusy(true);
    setProblem(null);
    const res = stage
      ? await editStage(stage.id, built.input, stage.version)
      : await addStage(jobId, built.input);
    setBusy(false);
    if (res.ok) {
      onSaved(res.data);
      return;
    }
    const code = errorCodeOf(res.error.body);
    setProblem({ field: "form", message: errorMessage(code, res.error.status) });
    if (code === "stale_version" || code === "stage_not_editable" || code === "stage_not_found") {
      await onStale();
    }
  }

  function setLine(key: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setProblem(null);
  }

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={stage ? "Edit stage" : "Add a stage"}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        data-testid="stage-editor"
      >
        <div>
          <label htmlFor="stage-title" className={LABEL}>
            What is this stage?
          </label>
          <input
            id="stage-title"
            className={`${INPUT} mt-1`}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setProblem(null);
            }}
            placeholder="e.g. Rough-in complete, or November claim"
            maxLength={200}
            disabled={busy}
          />
        </div>

        <div>
          <p className={LABEL}>How is the amount set?</p>
          <Seg
            aria-label="How the amount is set"
            className="mt-1"
            value={basis}
            onChange={(v) => {
              setBasis(v);
              setProblem(null);
            }}
            options={[
              { value: "amount", label: "Dollar amount" },
              { value: "percent", label: "% of contract" },
            ]}
          />
          {basis === "amount" ? (
            <div className="mt-2">
              <label htmlFor="stage-amount" className="text-xs text-text-muted">
                Amount ($ ex GST)
              </label>
              <input
                id="stage-amount"
                className={`${INPUT} mt-1`}
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setProblem(null);
                }}
                placeholder="12000"
                disabled={busy}
              />
            </div>
          ) : (
            <div className="mt-2">
              <label htmlFor="stage-percent" className="text-xs text-text-muted">
                Percentage of the contract
              </label>
              <input
                id="stage-percent"
                className={`${INPUT} mt-1`}
                inputMode="decimal"
                value={percent}
                onChange={(e) => {
                  setPercent(e.target.value);
                  setProblem(null);
                }}
                placeholder="20"
                disabled={busy}
              />
              <p className="mt-1 text-xs text-text-muted" data-testid="stage-contract-hint">
                {contractCents == null
                  ? "This job has no contract value yet, so the amount can't be worked out until one is set on the Money card."
                  : `Contract is ${formatCents(contractCents)} ex GST.`}
              </p>
            </div>
          )}
        </div>

        <div>
          <p className={LABEL}>Extra lines (optional)</p>
          <p className="text-xs text-text-muted">For anything on top of the stage, like an approved variation.</p>
          {lines.length > 0 ? (
            <ul className="mt-2 grid gap-2">
              {lines.map((l, i) => (
                <li key={l.key} className="flex items-center gap-2">
                  <input
                    aria-label={`Extra line ${i + 1} description`}
                    className={INPUT}
                    value={l.description}
                    onChange={(e) => setLine(l.key, { description: e.target.value })}
                    placeholder="Variation 3 — extra power points"
                    maxLength={500}
                    disabled={busy}
                  />
                  <input
                    aria-label={`Extra line ${i + 1} amount in dollars`}
                    className={`${INPUT} max-w-[7.5rem]`}
                    inputMode="decimal"
                    value={l.amount}
                    onChange={(e) => setLine(l.key, { amount: e.target.value })}
                    placeholder="1200"
                    disabled={busy}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setLines((prev) => prev.filter((x) => x.key !== l.key));
                      setProblem(null);
                    }}
                    disabled={busy}
                    aria-label={`Remove extra line ${i + 1}`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {lines.length < MAX_EXTRA_LINES ? (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={() => {
                setLines((prev) => [...prev, { key: nextKey, description: "", amount: "" }]);
                setNextKey((k) => k + 1);
              }}
              disabled={busy}
              data-testid="stage-add-line"
            >
              Add a line
            </Button>
          ) : null}
        </div>

        <div>
          <label htmlFor="stage-date" className={LABEL}>
            When do you expect to invoice it? (optional)
          </label>
          <input
            id="stage-date"
            type="date"
            className={`${INPUT} mt-1 max-w-[12rem]`}
            value={plannedDate}
            onChange={(e) => {
              setPlannedDate(e.target.value);
              setProblem(null);
            }}
            disabled={busy}
          />
        </div>

        <div
          className="rounded-card border border-border bg-surface-subtle px-3 py-2 text-sm"
          data-testid="stage-preview"
          aria-live="polite"
        >
          {preview ? (
            <>
              <p className="text-text">
                This stage comes to <span className="font-semibold">{formatCents(preview.grossCents)}</span> ex
                GST.
              </p>
              {preview.retentionCents > 0 ? (
                <p className="text-xs text-text-muted">
                  Less {formatBp(effectiveRetentionBp)} retention ({formatCents(preview.retentionCents)}),{" "}
                  {formatCents(preview.netCents)} would be invoiced.
                </p>
              ) : null}
            </>
          ) : needsContract ? (
            <p className="text-text-muted">The amount will fill in once the job has a contract value.</p>
          ) : (
            <p className="text-text-muted">Fill in the amount to see what this stage comes to.</p>
          )}
        </div>

        {problem ? (
          <p className="text-sm text-state-danger-subtle-text" role="alert" data-testid="stage-problem">
            {problem.message}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy} data-testid="stage-save">
            {busy ? "Saving…" : stage ? "Save changes" : "Add stage"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
