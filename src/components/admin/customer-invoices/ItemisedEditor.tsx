"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { addItemised, editItemised, errorCodeOf, jobBillable } from "@/domains/customer-invoices/client";
import { errorMessage, formatBp, formatCents } from "@/domains/customer-invoices/format";
import {
  MAX_ITEMS,
  blankLine,
  blankNote,
  buildItemisedInput,
  draftAmountCents,
  draftRefKeys,
  draftSummary,
  draftsFromItems,
  marginOf,
  type ItemDraft,
} from "@/domains/customer-invoices/itemised";
import type { BillableResponse, JobInvoicingResponse, Stage, XeroContact } from "@/domains/customer-invoices/schema";
import { portionCents } from "./StageEditor";
import { AddFromJob, type AddFromJobTab } from "./AddFromJob";
import { XeroContactSearch } from "./XeroClientLine";

const INPUT =
  "h-10 w-full rounded-card border border-border bg-surface px-3 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy disabled:bg-surface-subtle disabled:text-text-muted";
const LABEL = "block text-sm font-medium text-text";

/** What a line pulled from the job says about itself, under its inputs. */
export function sourceCaption(d: ItemDraft, amountCents: number | null): string | null {
  if (d.type !== "line" || d.refs.length === 0) return null;
  if (d.source === "variation") return "An approved variation, billed at the approved amount.";
  const n = d.refs.length;
  const cost = d.costCents;
  if (d.source === "labour") {
    const from = `From ${n} ${n === 1 ? "day" : "days"} of approved hours`;
    return cost == null ? `${from}. Cost not known: a worker has no cost rate.` : `${from}. Cost ${formatCents(cost)}.`;
  }
  const from = `From ${n} supplier ${n === 1 ? "item" : "items"}`;
  if (cost == null) return `${from}.`;
  const markup =
    amountCents != null && cost > 0 ? ` Markup ${formatBp(Math.round(((amountCents - cost) * 10000) / cost))}.` : "";
  return `${from}. Cost ${formatCents(cost)}.${markup}`;
}

/**
 * Add or edit a PLANNED itemised invoice (#1161 / #1162): what the work was,
 * then the charges — each a description, a quantity and a unit price — and
 * any wording-only notes. "Add from this job" pulls in the job's own hours and
 * materials that aren't on an invoice yet, at prices the office sets.
 *
 * The total is live. The cost and margin underneath are for the office only:
 * the box says so, and they are never sent to Xero.
 *
 * With `noJob` (#1166) it edits an invoice that is NOT tied to a job: the
 * client is chosen here, from the connected Xero organisation's contacts, and
 * every line is typed — there is no job to pull hours or materials from.
 */
export function ItemisedEditor({
  jobId,
  jobRetentionBp,
  stage,
  noJob,
  onClose,
  onSaved,
  onStale,
  searchContacts,
}: {
  jobId: string;
  jobRetentionBp: number;
  /** null = a new invoice. */
  stage: Stage | null;
  /** Set for an invoice with no job. `canChoose` is false while Xero isn't
   *  connected with permission for invoices: there is nothing to search. */
  noJob?: { organisationName: string | null; canChoose: boolean };
  onClose: () => void;
  onSaved: (next: JobInvoicingResponse) => void;
  onStale: () => Promise<void> | void;
  /** Injectable for tests (the contact search). */
  searchContacts?: Parameters<typeof XeroContactSearch>[0]["search"];
}) {
  const [title, setTitle] = useState(stage?.title ?? "");
  // The client chosen on an invoice with no job. A client picked in another
  // Xero organisation is not carried over: it has to be chosen again.
  const [client, setClient] = useState<{ id: string; name: string } | null>(() =>
    stage?.clientContactId && stage.clientContactName && !stage.clientOtherOrganisation
      ? { id: stage.clientContactId, name: stage.clientContactName }
      : null
  );
  const [picking, setPicking] = useState(false);
  const [rows, setRows] = useState<ItemDraft[]>(() =>
    stage?.items && stage.items.length > 0 ? draftsFromItems(stage.items) : [blankLine()]
  );
  const [plannedDate, setPlannedDate] = useState(stage?.plannedDate ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ field: string; key?: string; message: string } | null>(null);
  const [adding, setAdding] = useState<AddFromJobTab | null>(null);
  const [billable, setBillable] = useState<BillableResponse | null>(null);
  const [billableState, setBillableState] = useState<"idle" | "loading" | "error">("idle");

  // A stage keeps whatever retention override and note it already carries.
  const retentionBp = stage ? stage.retentionBp : null;
  const effectiveRetentionBp = retentionBp == null ? jobRetentionBp : retentionBp;
  const summary = draftSummary(rows);
  const retentionCents = effectiveRetentionBp > 0 && summary.totalCents > 0 ? portionCents(summary.totalCents, effectiveRetentionBp) : 0;
  const margin = marginOf(summary.costedSellCents, summary.costCents);

  function patchRow(key: string, patch: Partial<ItemDraft>) {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setProblem(null);
  }

  async function openAdd(tab: AddFromJobTab) {
    setAdding(tab);
    setProblem(null);
    if (billable || billableState === "loading") return;
    setBillableState("loading");
    const res = await jobBillable(jobId, stage?.id ?? null);
    if (res.ok) {
      setBillable(res.data);
      setBillableState("idle");
    } else {
      setBillableState("error");
    }
  }

  function addLines(lines: ItemDraft[]) {
    setRows((prev) => {
      // A single untouched blank row is only there to type into: drop it.
      const kept = prev.filter(
        (r) => !(r.type === "line" && r.refs.length === 0 && !r.description.trim() && !r.price.trim())
      );
      return [...kept, ...lines];
    });
    setAdding(null);
    setProblem(null);
  }

  async function save() {
    const built = buildItemisedInput({ title, items: rows, plannedDate, retentionBp, note: stage?.note ?? null });
    if (!built.ok) {
      setProblem({ field: built.field, key: built.key, message: built.message });
      return;
    }
    setBusy(true);
    setProblem(null);
    // Only an invoice with no job says who it is for; a job's invoice uses
    // the job's linked client and never sends one.
    const input = noJob ? { ...built.input, contactId: client ? client.id : null } : built.input;
    const res = stage ? await editItemised(stage.id, input, stage.version) : await addItemised(jobId, input);
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
    // What is free to bill has changed under us: read it again next time.
    if (code === "already_billed" || code === "ref_not_found") setBillable(null);
  }

  const atLimit = rows.length >= MAX_ITEMS;

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={noJob ? (stage ? "Edit invoice" : "New invoice") : stage ? "Edit itemised invoice" : "Add an itemised invoice"}
      className="max-h-[92vh] max-w-4xl overflow-y-auto p-4 sm:p-6"
    >
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        data-testid="itemised-editor"
      >
        {noJob ? (
          <div data-testid="itemised-client">
            <p className={LABEL}>Who is it for?</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className={client ? "text-sm text-text" : "text-sm text-text-muted"} data-testid="itemised-client-name">
                {client ? client.name : "No client chosen yet"}
              </span>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setProblem(null);
                  setPicking(true);
                }}
                disabled={busy || !noJob.canChoose}
                data-testid="itemised-choose-client"
              >
                {client ? "Change client" : "Choose client"}
              </Button>
            </div>
            <p className="mt-1 text-xs text-text-muted">
              {noJob.canChoose
                ? "Chosen from your Xero contacts. You can save without one and choose it before sending."
                : "Xero isn't connected for invoices, so there are no contacts to choose from yet. You can save the invoice and choose the client later."}
            </p>
            {picking ? (
              <div className="mt-2 grid gap-3 rounded-card border border-border p-3" data-testid="itemised-client-search">
                <XeroContactSearch
                  initialQuery=""
                  organisationName={noJob.organisationName}
                  busy={busy}
                  pickLabel="Choose"
                  onPick={(contact: XeroContact) => {
                    setClient({ id: contact.id, name: contact.name });
                    setPicking(false);
                  }}
                  {...(searchContacts ? { search: searchContacts } : {})}
                />
                <div className="flex justify-end">
                  <Button size="sm" variant="ghost" onClick={() => setPicking(false)} disabled={busy}>
                    Close search
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <div>
          <label htmlFor="itemised-title" className={LABEL}>
            {noJob ? "What is this invoice for?" : "What was the work?"}
          </label>
          <input
            id="itemised-title"
            className={`${INPUT} mt-1`}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              setProblem(null);
            }}
            placeholder={noJob ? "e.g. Progress claim, November 2026" : "e.g. Replace switchboard and test"}
            maxLength={200}
            disabled={busy}
          />
          <p className="mt-1 text-xs text-text-muted">
            {noJob
              ? "This heads the invoice. It is also the invoice's reference in Xero unless you type another when you send it."
              : "This heads the invoice, with the job\u2019s name and address under it."}
          </p>
        </div>

        <div>
          <p className={LABEL}>Lines</p>
          <p className="text-xs text-text-muted">
            Prices are ex GST. Use a minus price for a discount.
          </p>
          <div
            className="mt-2 hidden gap-2 px-3 text-xs font-medium text-text-muted sm:grid sm:grid-cols-[minmax(0,1fr)_4.5rem_4rem_6.5rem_6.5rem_4.5rem]"
            aria-hidden="true"
          >
            <span>Description</span>
            <span>Qty</span>
            <span>Unit</span>
            <span>Unit price</span>
            <span className="text-right">Total</span>
            <span />
          </div>
          <ul className="mt-1 grid gap-2" data-testid="itemised-rows">
            {rows.map((r, i) => {
              const amount = draftAmountCents(r);
              const locked = r.source === "variation" && r.refs.length > 0;
              const wrong = problem?.key === r.key;
              const caption = sourceCaption(r, amount);
              return (
                <li
                  key={r.key}
                  className={`rounded-card border p-2 sm:p-3 ${wrong ? "border-state-danger-subtle-border" : "border-border"}`}
                  data-testid={`itemised-row-${i}`}
                >
                  {r.type === "note" ? (
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_4.5rem] sm:items-start">
                      <textarea
                        aria-label={`Note ${i + 1}`}
                        className={`${INPUT} h-auto min-h-[4.5rem] py-2`}
                        value={r.description}
                        onChange={(e) => patchRow(r.key, { description: e.target.value })}
                        placeholder="Wording only, e.g. what was done or what was found. No amount."
                        maxLength={2000}
                        disabled={busy}
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setRows((prev) => prev.filter((x) => x.key !== r.key));
                          setProblem(null);
                        }}
                        disabled={busy}
                        aria-label={`Remove note ${i + 1}`}
                      >
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_4.5rem_4rem_6.5rem_6.5rem_4.5rem] sm:items-center">
                      <input
                        aria-label={`Line ${i + 1} description`}
                        className={INPUT}
                        value={r.description}
                        onChange={(e) => patchRow(r.key, { description: e.target.value })}
                        placeholder="e.g. Supply and fit double power point"
                        maxLength={1000}
                        disabled={busy}
                      />
                      <div className="grid grid-cols-[4.5rem_4rem_minmax(0,1fr)] gap-2 sm:contents">
                        <input
                          aria-label={`Line ${i + 1} quantity`}
                          className={INPUT}
                          inputMode="decimal"
                          value={r.quantity}
                          onChange={(e) => patchRow(r.key, { quantity: e.target.value })}
                          placeholder="Qty"
                          disabled={busy || locked}
                        />
                        <input
                          aria-label={`Line ${i + 1} unit`}
                          className={INPUT}
                          value={r.unit}
                          onChange={(e) => patchRow(r.key, { unit: e.target.value })}
                          placeholder="Unit"
                          maxLength={12}
                          disabled={busy}
                        />
                        <input
                          aria-label={`Line ${i + 1} unit price in dollars`}
                          className={INPUT}
                          inputMode="decimal"
                          value={r.price}
                          onChange={(e) => patchRow(r.key, { price: e.target.value })}
                          placeholder="Price"
                          disabled={busy || locked}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 sm:contents">
                        <p
                          className="text-sm font-semibold tabular-nums text-text sm:text-right"
                          data-testid={`itemised-row-total-${i}`}
                        >
                          {amount == null ? "—" : formatCents(amount)}
                        </p>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setRows((prev) => prev.filter((x) => x.key !== r.key));
                            setProblem(null);
                          }}
                          disabled={busy}
                          aria-label={`Remove line ${i + 1}`}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  )}
                  {caption ? (
                    <p className="mt-1.5 text-xs text-text-muted" data-testid={`itemised-row-source-${i}`}>
                      {caption}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {!atLimit ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setRows((prev) => [...prev, blankLine()])}
                disabled={busy}
                data-testid="itemised-add-line"
              >
                Add a line
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setRows((prev) => [...prev, blankNote()])}
                disabled={busy}
                data-testid="itemised-add-note"
              >
                Add a note
              </Button>
              {noJob ? null : (
                <Button
                  size="sm"
                  onClick={() => void openAdd(adding ?? "hours")}
                  disabled={busy}
                  data-testid="itemised-add-from-job"
                >
                  Add from this job
                </Button>
              )}
            </div>
          ) : (
            <p className="mt-2 text-xs text-text-muted">An invoice can have up to {MAX_ITEMS} lines.</p>
          )}
        </div>

        {adding ? (
          <AddFromJob
            tab={adding}
            onTab={setAdding}
            state={billableState}
            billable={billable}
            usedKeys={draftRefKeys(rows)}
            room={MAX_ITEMS - rows.length}
            onAdd={addLines}
            onPrefs={(prefs) => setBillable((b) => (b ? { ...b, prefs } : b))}
            onClose={() => setAdding(null)}
            onRetry={() => {
              setBillable(null);
              setBillableState("idle");
              void openAdd(adding);
            }}
          />
        ) : null}

        <div>
          <label htmlFor="itemised-date" className={LABEL}>
            When do you expect to invoice it? (optional)
          </label>
          <input
            id="itemised-date"
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
          data-testid="itemised-summary"
          aria-live="polite"
        >
          {summary.pricedCount > 0 ? (
            <>
              <p className="text-text">
                This invoice comes to{" "}
                <span className="font-semibold tabular-nums" data-testid="itemised-total">
                  {formatCents(summary.totalCents)}
                </span>{" "}
                ex GST.
              </p>
              {retentionCents > 0 ? (
                <p className="text-xs text-text-muted">
                  Less {formatBp(effectiveRetentionBp)} retention ({formatCents(retentionCents)}),{" "}
                  {formatCents(summary.totalCents - retentionCents)} would be invoiced.
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-text-muted">Add a line with a price to see what this invoice comes to.</p>
          )}
          {summary.costedSellCents > 0 || !summary.costKnown ? (
            <p className="mt-1 border-t border-border pt-1 text-xs text-text-muted" data-testid="itemised-margin">
              <span className="font-medium text-text">Office only, never sent to Xero:</span>{" "}
              {summary.costKnown ? (
                <>
                  the lines with a cost come to {formatCents(summary.costedSellCents)} and cost{" "}
                  {formatCents(summary.costCents)}, a margin of{" "}
                  <span
                    className={
                      margin.marginCents < 0
                        ? "font-semibold text-state-danger-subtle-text"
                        : "font-semibold text-text"
                    }
                  >
                    {formatCents(margin.marginCents)}
                  </span>
                  {margin.marginBp != null ? ` (${formatBp(margin.marginBp)} of the sale)` : ""}.
                </>
              ) : (
                <>the margin isn&rsquo;t shown, because a worker on this invoice has no cost rate.</>
              )}
            </p>
          ) : null}
        </div>

        {problem ? (
          <p className="text-sm text-state-danger-subtle-text" role="alert" data-testid="itemised-problem">
            {problem.message}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy} data-testid="itemised-save">
            {busy ? "Saving…" : stage ? "Save changes" : "Add invoice"}
          </Button>
        </div>
      </form>

    </Modal>
  );
}
