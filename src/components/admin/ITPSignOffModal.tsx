"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import {
  ITP_OVERRIDE_JUSTIFICATION_MAX,
  ITP_SIGNOFF_INDEPENDENCE_THRESHOLD,
} from "@/domains/itp/schema";
import { canSignOff } from "@/domains/itp/service";
import type { ITPInstance } from "@/domains/itp/types";

interface Props {
  open: boolean;
  instance: ITPInstance | null;
  viewer: { id: string; role: string };
  busy: boolean;
  onClose: () => void;
  /** Called when admin confirms sign-off. justification is `null` when
   *  the independence rule didn't fire; otherwise the trimmed string. */
  onSubmit: (justification: string | null) => void;
}

/**
 * Phase E1c — sign-off confirmation modal.
 *
 * Two branches driven by `canSignOff()`:
 *
 * 1. Independent: admin recorded <= 50% of the points.
 *    Body shows a short "Confirm sign off" message, no textarea, submit
 *    enabled immediately.
 *
 * 2. Needs justification: admin recorded > 50% of the points.
 *    Body shows the ratio + a textarea labelled "Override justification
 *    (required)" with a 500-char counter. Submit is disabled until the
 *    trimmed text is non-empty.
 *
 * The server enforces the same threshold (api/job-itps.js:88) — this
 * modal is the UX gate, not the security gate. A 409 on submit still
 * surfaces as a banner in the parent queue ("ITP changed since you
 * loaded — reload to see the latest.").
 *
 * Mirrors SnagRejectModal's shape (single textarea + char counter +
 * cancel/confirm pair) so admin muscle memory between the two surfaces
 * stays consistent.
 *
 * Cross-ref:
 *   src/components/admin/SnagRejectModal.tsx — modal pattern precedent
 *   src/domains/itp/service.ts#canSignOff — independence-rule logic
 *   docs/rebuild-audit/32-phase-e-plan.md §7.2
 *   docs/rebuild-audit/33-phase-e-build-prompts.md §E1c
 */
export function ITPSignOffModal({
  open,
  instance,
  viewer,
  busy,
  onClose,
  onSubmit,
}: Props) {
  const [justification, setJustification] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset + focus when the modal opens on a new instance.
  useEffect(() => {
    if (open) {
      setJustification("");
      const t = window.setTimeout(() => textareaRef.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [open, instance?.id]);

  const decision = instance
    ? canSignOff(instance, { userId: viewer.id, role: viewer.role })
    : null;

  const needsJustification =
    decision?.ok === false && decision.reason === "needs-justification";

  const trimmed = justification.trim();
  const justificationValid =
    !needsJustification ||
    (trimmed.length > 0 && trimmed.length <= ITP_OVERRIDE_JUSTIFICATION_MAX);
  const canSubmit = !busy && instance != null && justificationValid;

  const templateName =
    instance?.templateSnapshot?.name?.trim() || "this ITP";

  function submit() {
    onSubmit(needsJustification ? trimmed : null);
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`Sign off "${templateName.slice(0, 60)}"`}
    >
      <div className="space-y-4">
        {decision?.ok === false && decision.reason === "wrong-role" ? (
          <p
            role="alert"
            className="rounded-card border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"
          >
            You don&rsquo;t have permission to sign off this ITP.
          </p>
        ) : null}

        {decision?.ok === false && decision.reason === "wrong-status" ? (
          <p
            role="alert"
            className="rounded-card border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"
          >
            This ITP isn&rsquo;t ready to sign off yet — every required point
            must have a result first.
          </p>
        ) : null}

        {needsJustification && decision ? (
          <>
            <p className="text-sm text-text">
              You recorded{" "}
              <strong>{formatRatio(decision.ratio)}</strong> of the points on
              this ITP. The independence rule requires a justification before
              you can sign it off yourself.
            </p>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-text">
                Override justification (required)
              </span>
              <textarea
                ref={textareaRef}
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                disabled={busy}
                rows={4}
                maxLength={ITP_OVERRIDE_JUSTIFICATION_MAX}
                placeholder="e.g. Worked solo on this energisation test — confirmed visual checks alongside the inspector."
                className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60"
              />
              <p className="mt-1 text-right text-xs text-text-muted">
                {trimmed.length} / {ITP_OVERRIDE_JUSTIFICATION_MAX}
              </p>
            </label>
          </>
        ) : decision?.ok ? (
          <p className="text-sm text-text-muted">
            All required points have been recorded by your team. Signing off
            marks the ITP as accepted and locks it from further worker edits.
            You can re-open it later if you need to.
          </p>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!canSubmit || decision?.ok !== true && !needsJustification}
            onClick={submit}
            className="bg-brand-navy text-text-inverse hover:bg-accent-ink"
          >
            {busy ? "Signing off…" : "Sign off"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function formatRatio(ratio: number): string {
  const pct = Math.round(ratio * 100);
  return `${pct}%`;
}

/** Re-exported so callers don't have to import the schema constant when
 *  they just want to round-trip the threshold for messaging. */
export { ITP_SIGNOFF_INDEPENDENCE_THRESHOLD };
