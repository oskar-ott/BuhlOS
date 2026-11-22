"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { errorCodeOf, previewSend, sendStage } from "@/domains/customer-invoices/client";
import {
  blockerMessage,
  errorMessage,
  formatBp,
  formatCents,
  formatDay,
  sydneyToday,
} from "@/domains/customer-invoices/format";
import type {
  SendPreview,
  SendResponse,
  Stage,
} from "@/domains/customer-invoices/schema";

const INPUT =
  "h-10 w-full rounded-card border border-border bg-surface px-3 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy disabled:opacity-60";

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; preview: SendPreview };

/**
 * "Send to Xero" (#1150) — shows EXACTLY what will be created before anything
 * is sent: who it goes to, its number, date and due date, every line, the
 * retention taken off, and what Xero is expected to add as GST (an estimate,
 * said to be one — Xero's own figure replaces it once the invoice exists).
 *
 * Anything stopping the send is named with what fixes it, and the button is
 * not offered. The one button says what it does: it creates a DRAFT. Approval
 * and emailing stay in Xero.
 *
 * The date and the reference can be changed here; the preview is re-read so
 * what is shown is always what would be sent.
 */
export function SendToXeroPreview({
  stage,
  onClose,
  onSent,
  onProblem,
}: {
  stage: Stage;
  onClose: () => void;
  /** The send went to the server and came back — whatever the outcome. */
  onSent: (res: SendResponse) => void;
  /** The send couldn't be made at all (conflict, Xero unusable, network). */
  onProblem: (code: string | null, status: number) => Promise<void> | void;
}) {
  const [invoiceDate, setInvoiceDate] = useState(sydneyToday());
  const [reference, setReference] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  const read = useCallback(
    async (date: string, ref: string | null) => {
      const res = await previewSend(stage.id, { invoiceDate: date, ...(ref != null ? { reference: ref } : {}) });
      if (res.ok) setLoad({ kind: "ready", preview: res.data });
      else setLoad({ kind: "error", message: errorMessage(errorCodeOf(res.error.body), res.error.status) });
    },
    [stage.id]
  );

  useEffect(() => {
    void read(invoiceDate, null);
    // The first read only; later reads follow an explicit change below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read]);

  async function send() {
    setBusy(true);
    const res = await sendStage(stage.id, {
      expectedVersion: stage.version,
      invoiceDate,
      ...(reference != null && reference.trim() !== "" ? { reference: reference.trim() } : {}),
    });
    setBusy(false);
    if (res.ok) onSent(res.data);
    else await onProblem(errorCodeOf(res.error.body), res.error.status);
  }

  return (
    <Modal open onClose={busy ? () => {} : onClose} title="Send to Xero as a draft" className="max-w-xl">
      <div className="grid gap-4" data-testid="send-preview">
        {load.kind === "loading" ? (
          <p className="text-sm text-text-muted">Working out what will be sent…</p>
        ) : load.kind === "error" ? (
          <p className="text-sm text-state-danger-subtle-text" role="alert">
            {load.message}
          </p>
        ) : (
          <SendPreviewView
            preview={load.preview}
            invoiceDate={invoiceDate}
            reference={reference ?? load.preview.invoice?.reference ?? ""}
            busy={busy}
            onDate={(d) => {
              setInvoiceDate(d);
              if (/^\d{4}-\d{2}-\d{2}$/.test(d)) void read(d, reference);
            }}
            onReference={(r) => setReference(r)}
          />
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {load.kind === "ready" && load.preview.blockers.length === 0 && load.preview.invoice ? (
            <Button onClick={() => void send()} disabled={busy} data-testid="send-confirm">
              {busy ? "Sending to Xero…" : "Send to Xero as a draft"}
            </Button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}

/** The preview body — a pure function of the preview, so every state is pinned. */
export function SendPreviewView({
  preview,
  invoiceDate,
  reference,
  busy,
  onDate,
  onReference,
}: {
  preview: SendPreview;
  invoiceDate: string;
  reference: string;
  busy: boolean;
  onDate: (d: string) => void;
  onReference: (r: string) => void;
}) {
  const inv = preview.invoice;
  return (
    <>
      {preview.blockers.length > 0 ? (
        <div
          className="rounded-card border border-state-warning-subtle-border bg-state-warning-subtle-bg px-3 py-2"
          role="alert"
          data-testid="send-blockers"
        >
          <p className="text-sm font-medium text-state-warning-subtle-text">
            This can&rsquo;t be sent yet:
          </p>
          <ul className="mt-1 list-disc pl-5 text-sm text-state-warning-subtle-text">
            {preview.blockers.map((b) => (
              <li key={b.code}>{blockerMessage(b.code)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {inv ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-text-muted">To</dt>
            <dd className="text-text" data-testid="send-contact">
              {inv.contactName ?? "—"}
              {inv.organisationName ? (
                <span className="text-text-muted"> · in {inv.organisationName}</span>
              ) : null}
            </dd>
            <dt className="text-text-muted">Invoice number</dt>
            <dd className="font-mono text-text" data-testid="send-number">
              {inv.invoiceNumber}
            </dd>
            <dt className="text-text-muted">Due</dt>
            <dd className="text-text">{inv.dueDate ? formatDay(inv.dueDate) : "—"}</dd>
            <dt className="text-text-muted">Coded to</dt>
            <dd className="text-text">
              {inv.salesAccountCode} — {inv.salesAccountName ?? "sales account"} · {inv.taxName ?? "tax"}
              {inv.taxRateBp != null ? ` (${formatBp(inv.taxRateBp)})` : ""}
            </dd>
          </dl>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="send-date" className="block text-sm font-medium text-text">
                Invoice date
              </label>
              <input
                id="send-date"
                type="date"
                className={`${INPUT} mt-1`}
                value={invoiceDate}
                onChange={(e) => onDate(e.target.value)}
                disabled={busy}
              />
            </div>
            <div>
              <label htmlFor="send-reference" className="block text-sm font-medium text-text">
                Reference
              </label>
              <input
                id="send-reference"
                className={`${INPUT} mt-1`}
                value={reference}
                onChange={(e) => onReference(e.target.value)}
                maxLength={255}
                disabled={busy}
              />
              <p className="mt-1 text-xs text-text-muted">e.g. the builder&rsquo;s PO or claim number.</p>
            </div>
          </div>

          {/* Scrolls sideways on a phone rather than squeezing the amounts. */}
          <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="send-lines">
            <tbody>
              {inv.lines.map((l, i) => (
                <tr key={`${l.description}-${i}`} className="border-t border-border align-top">
                  <td className="whitespace-pre-line py-1.5 pr-3 text-text">{l.description}</td>
                  <td className="py-1.5 text-right tabular-nums text-text">{formatCents(l.amountCents)}</td>
                </tr>
              ))}
              <tr className="border-t border-border-strong">
                <td className="py-1.5 pr-3 font-medium text-text">Subtotal (ex GST)</td>
                <td className="py-1.5 text-right font-semibold tabular-nums text-text" data-testid="send-net">
                  {formatCents(inv.netCents)}
                </td>
              </tr>
              {inv.estimatedTaxCents != null && inv.estimatedTotalCents != null ? (
                <tr>
                  <td className="py-0.5 pr-3 text-text-muted">
                    GST Xero is expected to add, and the total (estimate)
                  </td>
                  <td className="py-0.5 text-right tabular-nums text-text-muted" data-testid="send-estimate">
                    {formatCents(inv.estimatedTaxCents)} · {formatCents(inv.estimatedTotalCents)}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          </div>

          <p className="text-xs text-text-muted">
            This creates a <span className="font-medium text-text">draft</span> invoice in Xero. The
            client sees nothing until you approve and email it from Xero. BuhlOS never approves or
            emails an invoice.
          </p>
        </>
      ) : preview.blockers.length === 0 ? (
        <p className="text-sm text-text-muted">There is nothing to show for this stage.</p>
      ) : null}
    </>
  );
}
