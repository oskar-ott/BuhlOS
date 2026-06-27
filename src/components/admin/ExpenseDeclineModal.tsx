"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { EXPENSE_NOTE_MAX, formatAud } from "@/domains/expenses/schema";
import type { ExpenseItem } from "@/domains/expenses/types";

interface Props {
  open: boolean;
  item: ExpenseItem | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}

/**
 * Decline-with-reason modal for a reimbursement claim (#536) — the same
 * required-reason pattern as EvidenceRejectModal:
 *   - required textarea, ≤ EXPENSE_NOTE_MAX, counter visible;
 *   - submit blocked until the trimmed reason is non-empty;
 *   - the reason is stored as the expense reviewNote and shown to the worker.
 *
 * A claim is money out of the worker's pocket — declining it without a reason
 * is exactly the silent failure the truth-over-theatre rule forbids.
 */
export function ExpenseDeclineModal({ open, item, busy, onClose, onSubmit }: Props) {
  const [reason, setReason] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setReason("");
      const t = window.setTimeout(() => textareaRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open, item?.id]);

  const trimmed = reason.trim();
  const canSubmit = !busy && trimmed.length > 0 && trimmed.length <= EXPENSE_NOTE_MAX;

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={item ? `Decline ${formatAud(item.amountCents)} claim` : "Decline claim"}
    >
      <div className="space-y-4">
        {item ? (
          <p className="text-sm text-text-muted">
            {item.submittedByName}&rsquo;s {item.category} claim. The reason is recorded on the claim
            and visible to the worker — they re-claim by submitting again.
          </p>
        ) : null}
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-text">Reason (required)</span>
          <textarea
            ref={textareaRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            rows={4}
            maxLength={EXPENSE_NOTE_MAX}
            placeholder="e.g. No receipt attached — please re-submit with the tax invoice"
            className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60"
          />
          <p className="mt-1 text-right text-xs text-text-muted">
            {trimmed.length} / {EXPENSE_NOTE_MAX}
          </p>
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!canSubmit} onClick={() => onSubmit(trimmed)}>
            {busy ? "Declining…" : "Decline with reason"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
