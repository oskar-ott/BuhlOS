"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Card, CardKicker } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { dollarsToCents } from "@/domains/cost-rates/schema";
import { formatDateLabel } from "@/domains/timesheets/format";
import { formatMoneyCents } from "@/domains/jobs/profitability-client";
import {
  addMaterialsLine,
  announceJobMoneyChanged,
  jobMaterials,
  removeMaterialsLine,
  type MaterialsLine,
} from "@/domains/jobs/job-materials-client";

/**
 * Admin Job hub — Materials spend ledger (owner pull 2026-08-23: "see all the
 * materials being used on a job and the value of all of that").
 *
 * The office's per-job record of what was bought: one line per docket or
 * invoice — date, supplier, what for, amount ex GST — over /api/job-materials.
 * The Money card's Materials figure is the SAME ledger read server-side
 * (materialSource 'ledger'), so the two never disagree; after a write this
 * card announces JOB_MONEY_CHANGED_EVENT and the Money card refetches.
 *
 * Admin-tier only and flag-gated (job_materials_spend): the page renders it
 * only when both hold, and the card hides itself on a 403/404 rather than show
 * a money surface to a leading hand. Removing a line is a soft delete on the
 * server (attributable), confirmed inline — no browser confirm().
 *
 * Honest by construction: an empty ledger says what will appear and how, never
 * a fake "$0"; every amount shown was typed by a named person on a date.
 */

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

interface FormState {
  date: string;
  supplier: string;
  description: string;
  amount: string; // dollars, e.g. "184.50"
}

export function JobMaterialsCard({ jobId }: { jobId: string }) {
  const ids = useId();
  const [lines, setLines] = useState<MaterialsLine[]>([]);
  const [totalCents, setTotalCents] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await jobMaterials(jobId);
    if (!res.ok) {
      if (res.error.status === 403 || res.error.status === 404 || res.error.status === 401) {
        setState("hidden");
        return;
      }
      setErrorMessage(
        res.error.status > 0
          ? `API returned ${res.error.status}`
          : res.error.message || "network error"
      );
      setState("error");
      return;
    }
    setLines(res.data.lines);
    setTotalCents(res.data.totalCents);
    setErrorMessage(null);
    setState("ready");
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state === "hidden") return null;

  async function save() {
    if (!form) return;
    const supplier = form.supplier.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.date)) {
      setFormError("Pick the date on the docket.");
      return;
    }
    if (!supplier) {
      setFormError("Who was it bought from?");
      return;
    }
    const amountCents = dollarsToCents(form.amount);
    if (amountCents == null) {
      setFormError("Enter the amount ex GST in dollars, like 184.50.");
      return;
    }
    setBusy(true);
    setFormError(null);
    const res = await addMaterialsLine(jobId, {
      date: form.date,
      supplier,
      description: form.description.trim() || null,
      amountCents,
    });
    setBusy(false);
    if (!res.ok) {
      setFormError(res.error.message || "Couldn't save — try again.");
      return;
    }
    setLines(res.data.lines);
    setTotalCents(res.data.totalCents);
    setForm(null);
    announceJobMoneyChanged(jobId);
  }

  async function remove(lineId: string) {
    setBusy(true);
    setActionError(null);
    const res = await removeMaterialsLine(jobId, lineId);
    setBusy(false);
    setConfirmId(null);
    if (!res.ok) {
      setActionError(res.error.message || "Couldn't remove that line — try again.");
      return;
    }
    setLines(res.data.lines);
    setTotalCents(res.data.totalCents);
    announceJobMoneyChanged(jobId);
  }

  const inputClass =
    "h-9 w-full rounded-card border border-border bg-surface px-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy";
  const labelClass = "block text-xs text-text-muted";

  return (
    <Card id="materials" role="region" aria-label="Materials">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardKicker>Materials</CardKicker>
        <div className="flex items-center gap-3">
          {state === "ready" && lines.length > 0 ? (
            <span className="font-display text-base font-bold tabular-nums text-text">
              {formatMoneyCents(totalCents)}{" "}
              <span className="font-sans text-xs font-normal text-text-muted">ex GST</span>
            </span>
          ) : null}
          {state === "ready" ? (
            <Button
              size="sm"
              variant={form ? "ghost" : "secondary"}
              onClick={() => {
                setFormError(null);
                setForm(
                  form ? null : { date: localToday(), supplier: "", description: "", amount: "" }
                );
              }}
              disabled={busy}
              data-testid="materials-add-open"
            >
              {form ? "Cancel" : "Add spend"}
            </Button>
          ) : null}
        </div>
      </div>

      {state === "loading" ? (
        <div className="mt-4 grid gap-2" data-testid="materials-skeleton" aria-hidden="true">
          <div className="sk h-4 w-full" />
          <div className="sk h-4 w-[80%]" />
          <div className="sk h-4 w-[60%]" />
        </div>
      ) : state === "error" ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-text-muted" role="alert">
            Couldn&rsquo;t load the materials ledger ({errorMessage ?? "unknown error"}).
          </p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          {form ? (
            <div
              className="mt-4 grid gap-2 rounded-card border border-border p-3"
              data-testid="materials-form"
            >
              <div className="grid gap-2 sm:grid-cols-[150px_1fr]">
                <label htmlFor={`${ids}-date`} className={labelClass}>
                  Date on docket
                  <input
                    id={`${ids}-date`}
                    type="date"
                    value={form.date}
                    onChange={(e) => setForm({ ...form, date: e.target.value })}
                    className={inputClass}
                    disabled={busy}
                  />
                </label>
                <label htmlFor={`${ids}-supplier`} className={labelClass}>
                  Supplier
                  <input
                    id={`${ids}-supplier`}
                    type="text"
                    value={form.supplier}
                    onChange={(e) => setForm({ ...form, supplier: e.target.value })}
                    placeholder="e.g. Lawrence & Hanson"
                    className={inputClass}
                    disabled={busy}
                    maxLength={120}
                  />
                </label>
              </div>
              <div className="grid gap-2 sm:grid-cols-[1fr_150px]">
                <label htmlFor={`${ids}-desc`} className={labelClass}>
                  What for (optional)
                  <input
                    id={`${ids}-desc`}
                    type="text"
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="e.g. 2.5mm TPS, GPOs for level 1"
                    className={inputClass}
                    disabled={busy}
                    maxLength={300}
                  />
                </label>
                <label htmlFor={`${ids}-amount`} className={labelClass}>
                  Amount ex GST ($)
                  <input
                    id={`${ids}-amount`}
                    type="text"
                    inputMode="decimal"
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    placeholder="184.50"
                    className={inputClass}
                    disabled={busy}
                  />
                </label>
              </div>
              {formError ? (
                <p className="text-xs text-state-danger-subtle-text" role="alert">
                  {formError}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setForm(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => void save()}
                  disabled={busy}
                  data-testid="materials-save"
                >
                  Save line
                </Button>
              </div>
            </div>
          ) : null}

          {actionError ? (
            <p className="mt-3 text-xs text-state-danger-subtle-text" role="alert">
              {actionError}
            </p>
          ) : null}

          {lines.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">
              Nothing recorded yet. Add each docket or invoice — supplier, date, amount ex GST — and
              the Money card&rsquo;s Materials figure fills in from this ledger.
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm" data-testid="materials-lines">
                <thead>
                  <tr className="text-left font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
                    <th className="pb-1.5 pr-2 font-medium">Date</th>
                    <th className="pb-1.5 pr-2 font-medium">Supplier</th>
                    <th className="pb-1.5 pr-2 font-medium">What for</th>
                    <th className="pb-1.5 pr-2 text-right font-medium">Amount</th>
                    <th className="pb-1.5 text-right font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id} className="border-t border-border align-top">
                      <td className="whitespace-nowrap py-1.5 pr-2 tabular-nums text-text-muted">
                        {formatDateLabel(l.date)}
                      </td>
                      <td className="py-1.5 pr-2 font-medium text-text">{l.supplier}</td>
                      <td className="py-1.5 pr-2 text-text-muted">{l.description ?? "—"}</td>
                      <td className="whitespace-nowrap py-1.5 pr-2 text-right tabular-nums text-text">
                        {formatMoneyCents(l.amountCents)}
                      </td>
                      <td className="whitespace-nowrap py-1.5 text-right">
                        {confirmId === l.id ? (
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <span className="text-text-muted">Remove?</span>
                            <button
                              type="button"
                              onClick={() => void remove(l.id)}
                              disabled={busy}
                              className="font-medium text-state-danger-subtle-text underline decoration-2 underline-offset-2 focus:outline-none focus:ring-2 focus:ring-brand-navy"
                            >
                              Yes
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmId(null)}
                              disabled={busy}
                              className="font-medium text-text underline decoration-accent-yellow decoration-2 underline-offset-2 focus:outline-none focus:ring-2 focus:ring-brand-navy"
                            >
                              Keep
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmId(l.id)}
                            disabled={busy}
                            className={cn(
                              "text-xs font-medium text-text-muted underline decoration-2 underline-offset-2 hover:text-text focus:outline-none focus:ring-2 focus:ring-brand-navy"
                            )}
                            aria-label={`Remove ${l.supplier} ${formatMoneyCents(l.amountCents)}`}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border-strong">
                    <td className="pt-2 pr-2 font-semibold text-text" colSpan={3}>
                      Total · {lines.length} line{lines.length === 1 ? "" : "s"}
                    </td>
                    <td className="pt-2 pr-2 text-right font-semibold tabular-nums text-text">
                      {formatMoneyCents(totalCents)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <p className="mt-3 text-xs text-text-muted">
            Office-only ledger of what was bought for this job, ex GST. Feeds the Money card&rsquo;s
            Materials figure; removed lines stay on record.
          </p>
        </>
      )}
    </Card>
  );
}
