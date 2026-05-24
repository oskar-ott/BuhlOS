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
  /** Reason is optional in the server payload but the UI strongly
   *  encourages one — empty submit is still allowed so admins aren't
   *  blocked by an obvious mistake. */
  onSubmit: (reason: string) => void;
}

/**
 * Admin un-review confirmation modal (D5).
 *
 * Un-review sends a `reviewed → submitted` transition through the D2
 * /api/evidence?action=review endpoint. Per doc 30 D4-11 risk: this is
 * a destructive operation, so a confirmation modal with a reason is
 * the right shape. The reason lands in the audit summary; the row's
 * `rejectionReason` field stays untouched (that's reserved for
 * rejected items).
 *
 * Empty submit is allowed by the server but the modal makes clear that
 * a reason is expected — accidental un-reviews are still preventable
 * via the two-click flow (open modal → confirm).
 */
export function EvidenceUnreviewModal({
  open,
  item,
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
  }, [open, item?.id]);

  const trimmed = reason.trim();
  const tooLong = trimmed.length > REJECTION_REASON_MAX;
  const canSubmit = !busy && !tooLong;

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={
        item
          ? `Un-review ${item.capturedByName ?? "this capture"}'s evidence`
          : "Un-review evidence"
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          This sends the evidence back to the submitted queue. The original{" "}
          <span className="font-medium text-text">Reviewed by</span> stamp is
          replaced by your name when you (or another admin) reviews it again.
          The note below is recorded in the audit log.
        </p>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-text">
            Why are you un-reviewing? <span className="text-text-muted">(optional)</span>
          </span>
          <textarea
            ref={textareaRef}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            rows={3}
            maxLength={REJECTION_REASON_MAX}
            placeholder="e.g. Wrong area — should have been Kitchen, not Lounge."
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
            {busy ? "Un-reviewing…" : "Un-review"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
