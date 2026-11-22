"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Pill } from "@/components/ui/Pill";
import {
  addVariation,
  billVariation,
  decideVariation,
  editVariation,
  removeVariation,
} from "@/domains/customer-invoices/client";
import {
  centsToInput,
  formatCents,
  formatDay,
  parseDollarsToCents,
  sydneyToday,
} from "@/domains/customer-invoices/format";
import type {
  JobInvoicingResponse,
  Variation,
  VariationInput,
} from "@/domains/customer-invoices/schema";
import type { HttpResult } from "@/lib/http";

type Mutation = Promise<HttpResult<JobInvoicingResponse>>;
type Run = (call: () => Mutation) => Promise<boolean>;

const INPUT =
  "h-10 w-full rounded-card border border-border bg-surface px-3 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy";
const SMALL =
  "h-8 rounded-card border border-border bg-surface px-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy";
const LABEL = "block text-sm font-medium text-text";

/** The typed variation form → what is sent, or what is wrong with it. Pure. */
export function buildVariationInput(form: {
  title: string;
  detail: string;
  requestedBy: string;
  requestedOn: string;
  price: string;
}): { ok: true; input: VariationInput } | { ok: false; message: string } {
  const title = form.title.trim();
  if (!title) return { ok: false, message: "Say what the variation is." };
  if (title.length > 200) return { ok: false, message: "Keep the name under 200 characters." };
  let quotedCents: number | null = null;
  if (form.price.trim() !== "") {
    quotedCents = parseDollarsToCents(form.price);
    if (quotedCents == null) return { ok: false, message: "Enter the price in dollars, e.g. 1200. Leave it blank if it isn't priced yet." };
  }
  if (form.requestedOn && !/^\d{4}-\d{2}-\d{2}$/.test(form.requestedOn)) return { ok: false, message: "Pick a valid date." };
  return {
    ok: true,
    input: {
      title,
      detail: form.detail.trim() || null,
      requestedBy: form.requestedBy.trim() || null,
      requestedOn: form.requestedOn || null,
      quotedCents,
    },
  };
}

/** The one line that says where a variation stands. */
export function variationStanding(v: Variation): { label: string; tone: "neutral" | "success" | "warning" | "danger" } {
  if (v.status === "declined") return { label: "Declined", tone: "neutral" };
  if (v.status === "proposed") return { label: v.quotedCents == null ? "Not priced" : "Waiting on approval", tone: "warning" };
  return v.billedOn ? { label: `On ${v.billedOn}`, tone: "success" } : { label: "Approved, not billed", tone: "warning" };
}

/**
 * The job's variations (#1163): what was asked for, by whom, the price put,
 * and whether it was approved. Approved variations add to the contract; an
 * approved one that isn't on an invoice yet says so, and can be put on a
 * planned stage or on an invoice of its own. A variation that is on an invoice
 * is settled and can't be changed here.
 */
export function VariationsSection({ data, run }: { data: JobInvoicingResponse; run: Run }) {
  const variations = data.variations ?? [];
  const [editor, setEditor] = useState<{ mode: "add" } | { mode: "edit"; variation: Variation } | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const [billing, setBilling] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const plannedStages = data.stages.filter((s) => s.kind === "stage" && s.state === "planned");

  async function act(id: string, call: () => Mutation) {
    setBusyId(id);
    await run(call);
    setBusyId(null);
    setApproving(null);
    setBilling(null);
    setRemoving(null);
  }

  return (
    <div className="border-t border-border px-4 py-3 sm:px-6" data-testid="gp-variations">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">Variations</p>
        <Button size="sm" variant="secondary" onClick={() => setEditor({ mode: "add" })} data-testid="gp-add-variation">
          Add variation
        </Button>
      </div>

      {variations.length === 0 ? (
        <p className="mt-1 text-sm text-text-muted" data-testid="gp-variations-empty">
          None on this job. Record a variation when it is asked for, before the work is done — approved
          ones add to the contract and show here until they are invoiced.
        </p>
      ) : (
        <ul className="mt-2 grid gap-3">
          {variations.map((v) => {
            const standing = variationStanding(v);
            const busy = busyId === v.id;
            const amount = v.status === "approved" ? v.approvedCents : v.quotedCents;
            return (
              <li key={v.id} className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4" data-testid={`gp-variation-${v.number}`}>
                <div className="min-w-0 sm:flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-text">{v.number}</span>
                    <span className="font-medium text-text">{v.title}</span>
                    <Pill tone={standing.tone} dot>
                      {standing.label}
                    </Pill>
                  </div>
                  {v.requestedBy || v.requestedOn || v.approvalRef ? (
                    <p className="mt-0.5 text-xs text-text-muted">
                      {[
                        v.requestedBy ? `Asked for by ${v.requestedBy}` : null,
                        v.requestedOn ? `on ${formatDay(v.requestedOn)}` : null,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      {v.status !== "proposed" && (v.approvalRef || v.decidedOn)
                        ? `${v.requestedBy || v.requestedOn ? " · " : ""}${v.status === "approved" ? "Approved" : "Declined"}${
                            v.decidedOn ? ` ${formatDay(v.decidedOn)}` : ""
                          }${v.approvalRef ? `: ${v.approvalRef}` : ""}`
                        : ""}
                    </p>
                  ) : null}
                  {v.detail ? <p className="mt-0.5 whitespace-pre-line text-xs text-text-muted">{v.detail}</p> : null}

                  {approving === v.id ? (
                    <ApproveForm
                      variation={v}
                      busy={busy}
                      onCancel={() => setApproving(null)}
                      onSave={(input) => void act(v.id, () => decideVariation(v.id, { status: "approved", ...input, expectedVersion: v.version }))}
                    />
                  ) : null}

                  {billing === v.id ? (
                    <div className="mt-2 grid gap-1.5" data-testid="gp-variation-bill">
                      <p className="text-xs text-text-muted">Where should {v.number} be invoiced?</p>
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="sm" onClick={() => void act(v.id, () => billVariation(v.id))} disabled={busy} data-testid="gp-variation-bill-own">
                          On an invoice of its own
                        </Button>
                        {plannedStages.map((s) => (
                          <Button
                            key={s.id}
                            size="sm"
                            variant="secondary"
                            onClick={() => void act(v.id, () => billVariation(v.id, { stageId: s.id, expectedStageVersion: s.version }))}
                            disabled={busy}
                          >
                            With &ldquo;{s.title}&rdquo;
                          </Button>
                        ))}
                        <Button size="sm" variant="ghost" onClick={() => setBilling(null)} disabled={busy}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="sm:text-right">
                  <p className={`font-display text-lg font-bold tabular-nums ${v.status === "declined" ? "text-text-muted line-through" : "text-text"}`}>
                    {amount == null ? "—" : formatCents(amount)}
                  </p>
                  {v.status === "approved" && v.quotedCents != null && v.quotedCents !== v.approvedCents ? (
                    <p className="text-xs text-text-muted">quoted {formatCents(v.quotedCents)}</p>
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 sm:justify-end">
                    {removing === v.id ? (
                      <>
                        <span className="w-full text-xs text-text-muted sm:w-auto">Remove {v.number}?</span>
                        <Button size="sm" variant="danger" onClick={() => void act(v.id, () => removeVariation(v.id, v.version))} disabled={busy}>
                          Yes, remove
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(null)} disabled={busy}>
                          Keep
                        </Button>
                      </>
                    ) : v.status === "proposed" ? (
                      <>
                        <Button size="sm" onClick={() => { setBilling(null); setApproving(v.id); }} disabled={busy} data-testid="gp-variation-approve">
                          Approved
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void act(v.id, () => decideVariation(v.id, { status: "declined", decidedOn: sydneyToday(), expectedVersion: v.version }))}
                          disabled={busy}
                        >
                          Declined
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditor({ mode: "edit", variation: v })} disabled={busy}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(v.id)} disabled={busy}>
                          Remove
                        </Button>
                      </>
                    ) : v.billedOn ? null : (
                      <>
                        {v.status === "approved" && (v.approvedCents ?? 0) > 0 ? (
                          <Button size="sm" onClick={() => { setApproving(null); setBilling(v.id); }} disabled={busy} data-testid="gp-variation-bill-open">
                            Put on an invoice
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void act(v.id, () => decideVariation(v.id, { status: "proposed", expectedVersion: v.version }))}
                          disabled={busy}
                        >
                          Back to proposed
                        </Button>
                        {v.status === "declined" ? (
                          <Button size="sm" variant="ghost" onClick={() => setRemoving(v.id)} disabled={busy}>
                            Remove
                          </Button>
                        ) : null}
                      </>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editor ? (
        <VariationEditor
          variation={editor.mode === "edit" ? editor.variation : null}
          onClose={() => setEditor(null)}
          onSave={async (input) => {
            const v = editor.mode === "edit" ? editor.variation : null;
            const ok = await run(() => (v ? editVariation(v.id, input, v.version) : addVariation(data.jobId, input)));
            if (ok) setEditor(null);
            return ok;
          }}
        />
      ) : null}
    </div>
  );
}

/** Marking a variation approved: how much, and how it was approved. */
function ApproveForm({
  variation,
  busy,
  onCancel,
  onSave,
}: {
  variation: Variation;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: { approvedCents: number; approvalRef: string | null; decidedOn: string }) => void;
}) {
  const [amount, setAmount] = useState(centsToInput(variation.quotedCents));
  const [ref, setRef] = useState("");
  const [day, setDay] = useState(sydneyToday());
  const [problem, setProblem] = useState<string | null>(null);

  function save() {
    const cents = parseDollarsToCents(amount);
    if (cents == null) return setProblem("Enter the approved amount in dollars.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return setProblem("Pick the date it was approved.");
    onSave({ approvedCents: cents, approvalRef: ref.trim() || null, decidedOn: day });
  }

  return (
    <div className="mt-2 grid gap-2 rounded-card border border-border bg-surface-subtle p-2" data-testid="gp-variation-approve-form">
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs text-text-muted">
          Approved amount ($ ex GST)
          <input
            className={`${SMALL} w-32`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => { setAmount(e.target.value); setProblem(null); }}
            disabled={busy}
          />
        </label>
        <label className="grid gap-1 text-xs text-text-muted">
          Approved on
          <input type="date" className={`${SMALL} w-40`} value={day} onChange={(e) => { setDay(e.target.value); setProblem(null); }} disabled={busy} />
        </label>
        <label className="grid min-w-[12rem] flex-1 gap-1 text-xs text-text-muted">
          How it was approved
          <input
            className={`${SMALL} w-full`}
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="e.g. email from the site manager, or SI-014"
            maxLength={300}
            disabled={busy}
          />
        </label>
      </div>
      {problem ? (
        <p className="text-xs text-state-danger-subtle-text" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" onClick={save} disabled={busy} data-testid="gp-variation-approve-save">
          {busy ? "Saving…" : "Mark approved"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function VariationEditor({
  variation,
  onClose,
  onSave,
}: {
  variation: Variation | null;
  onClose: () => void;
  onSave: (input: VariationInput) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(variation?.title ?? "");
  const [detail, setDetail] = useState(variation?.detail ?? "");
  const [requestedBy, setRequestedBy] = useState(variation?.requestedBy ?? "");
  const [requestedOn, setRequestedOn] = useState(variation?.requestedOn ?? "");
  const [price, setPrice] = useState(centsToInput(variation?.quotedCents));
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function save() {
    const built = buildVariationInput({ title, detail, requestedBy, requestedOn, price });
    if (!built.ok) return setProblem(built.message);
    setBusy(true);
    setProblem(null);
    const ok = await onSave(built.input);
    setBusy(false);
    // On failure the card shows why; the form stays open with what was typed.
    if (!ok) setProblem("That couldn't be saved. The reason is shown on the card behind this.");
  }

  return (
    <Modal open onClose={busy ? () => {} : onClose} title={variation ? `Edit ${variation.number}` : "Add a variation"}>
      <form
        className="grid gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        data-testid="variation-editor"
      >
        <div>
          <label htmlFor="variation-title" className={LABEL}>
            What is the variation?
          </label>
          <input
            id="variation-title"
            className={`${INPUT} mt-1`}
            value={title}
            onChange={(e) => { setTitle(e.target.value); setProblem(null); }}
            placeholder="e.g. Four extra power points in the kitchen"
            maxLength={200}
            disabled={busy}
          />
        </div>
        <div>
          <label htmlFor="variation-detail" className={LABEL}>
            Details (optional)
          </label>
          <textarea
            id="variation-detail"
            className={`${INPUT} mt-1 h-auto min-h-[4.5rem] py-2`}
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            maxLength={2000}
            disabled={busy}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="variation-by" className={LABEL}>
              Who asked for it? (optional)
            </label>
            <input
              id="variation-by"
              className={`${INPUT} mt-1`}
              value={requestedBy}
              onChange={(e) => setRequestedBy(e.target.value)}
              placeholder="e.g. the site manager"
              maxLength={200}
              disabled={busy}
            />
          </div>
          <div>
            <label htmlFor="variation-on" className={LABEL}>
              When? (optional)
            </label>
            <input
              id="variation-on"
              type="date"
              className={`${INPUT} mt-1`}
              value={requestedOn}
              onChange={(e) => { setRequestedOn(e.target.value); setProblem(null); }}
              disabled={busy}
            />
          </div>
        </div>
        <div>
          <label htmlFor="variation-price" className={LABEL}>
            Price ($ ex GST)
          </label>
          <input
            id="variation-price"
            className={`${INPUT} mt-1 max-w-[12rem]`}
            inputMode="decimal"
            value={price}
            onChange={(e) => { setPrice(e.target.value); setProblem(null); }}
            placeholder="1200"
            disabled={busy}
          />
          <p className="mt-1 text-xs text-text-muted">Leave it blank if it isn&rsquo;t priced yet.</p>
        </div>
        {problem ? (
          <p className="text-sm text-state-danger-subtle-text" role="alert" data-testid="variation-problem">
            {problem}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy} data-testid="variation-save">
            {busy ? "Saving…" : variation ? "Save changes" : "Add variation"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
