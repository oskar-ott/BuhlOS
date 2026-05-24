"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { REJECTION_REASON_MAX } from "@/domains/evidence/schema";
import type { EvidenceItem } from "@/domains/evidence/types";

interface Props {
  open: boolean;
  item: EvidenceItem | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}

/**
 * Reject-with-reason modal (doc 30 §6.3).
 *
 *   - Required textarea, ≤500 chars, counter visible.
 *   - Submit blocked until trimmed reason is non-empty.
 *   - Cancel returns to drawer with no state change.
 *   - No confirm() / alert() — modal is the only confirmation.
 *
 * Reuses the shared <Modal> primitive from src/components/ui/Modal.tsx
 * (same pattern as the Phase B reject modal in HoursApprovalsQueue).
 */
export function EvidenceRejectModal({
  open,
  item,
  busy,
  onClose,
  onSubmit,
}: Props) {
  const [reason, setReason] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset the reason when the modal opens for a fresh target — keeps
  // the input clean between reviews.
  useEffect(() => {
    if (open) {
      setReason("");
      // Focus the textarea so the admin can start typing immediately.
      const t = window.setTimeout(() => textareaRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open, item?.id]);

  const trimmed = reason.trim();
  const canSubmit = !busy && trimmed.length > 0 && trimmed.length <= REJECTION_REASON_MAX;

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={
        item
          ? `Reject ${item.capturedByName ?? "this capture"}'s evidence`
          : "Reject evidence"
      }
    >
      <div className="space-y-4">
        {item ? (
          <p className="text-sm text-text-muted">
            {item.kind === "photo" ? "Photo" : "Note"} captured{" "}
            {formatCapturedAt(item.capturedAt)}. The reason is recorded with
            the rejection and visible to the worker on their next Phil
            refresh.
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
            maxLength={REJECTION_REASON_MAX}
            placeholder="e.g. Wrong area — please re-capture in Kitchen"
            className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60"
          />
          <p className="mt-1 text-right text-xs text-text-muted">
            {trimmed.length} / {REJECTION_REASON_MAX}
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

function formatCapturedAt(iso: string): string {
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

