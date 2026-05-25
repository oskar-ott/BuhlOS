"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { SNAG_REJECTION_REASON_MAX } from "@/domains/snags/schema";
import type { SnagItem } from "@/domains/snags/types";

interface Props {
  open: boolean;
  snag: SnagItem | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}

/**
 * Reject-with-reason modal for snags (Phase D.5).
 *
 *   - Required textarea, ≤500 chars, counter visible.
 *   - Submit blocked until trimmed reason is non-empty.
 *   - Cancel returns to drawer / queue with no state change.
 *
 * Reuses the shared <Modal> primitive; same shape as
 * EvidenceRejectModal (the field worker UX between rejected evidence
 * and rejected snag should feel identical — "admin pushed back, here's
 * why, fix or escalate").
 */
export function SnagRejectModal({
  open,
  snag,
  busy,
  onClose,
  onSubmit,
}: Props) {
  const [reason, setReason] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) {
      setReason("");
      const t = window.setTimeout(() => textareaRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open, snag?.id]);

  const trimmed = reason.trim();
  const canSubmit =
    !busy && trimmed.length > 0 && trimmed.length <= SNAG_REJECTION_REASON_MAX;

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={snag ? `Reject "${snag.title.slice(0, 60)}"` : "Reject snag"}
    >
      <div className="space-y-4">
        {snag ? (
          <p className="text-sm text-text-muted">
            Raised by {snag.createdByName} on {formatAt(snag.createdAt)}.
            The reason is recorded on the snag and visible to the worker on
            their next refresh.
          </p>
        ) : null}
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-text">
            Reason (required)
          </span>
          <textarea
            ref={textareaRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            rows={4}
            maxLength={SNAG_REJECTION_REASON_MAX}
            placeholder="e.g. Duplicate of sn_99999999 — please use that snag instead."
            className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60"
          />
          <p className="mt-1 text-right text-xs text-text-muted">
            {trimmed.length} / {SNAG_REJECTION_REASON_MAX}
          </p>
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!canSubmit}
            onClick={() => onSubmit(trimmed)}
          >
            {busy ? "Rejecting…" : "Reject with reason"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function formatAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("en-AU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Australia/Sydney",
    });
  } catch {
    return "";
  }
}
