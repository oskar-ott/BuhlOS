"use client";

import { useState } from "react";
import { canSubmitForReview } from "@/domains/itp/service";
import { submitItpForReview } from "@/domains/itp/client";
import type { ITPInstance } from "@/domains/itp/types";
import { PhilActionButton } from "./ui/PhilActionButton";
import { PhilNotice } from "./ui/PhilNotice";

interface Props {
  jobId: string;
  instance: ITPInstance;
  viewer: { id: string; role: string };
  /** Bubble the server-canonical next instance up to the recording
   *  orchestrator so the header pill + lock state update in place. */
  onSaved: (next: ITPInstance) => void;
  /** Surface a failure through the orchestrator's shared banner. */
  onError: (message: string, status: number) => void;
}

/**
 * Phil — "Submit for review" footer for the per-instance ITP recording
 * screen (the explicit in-progress → witnessed handoff).
 *
 * Once every required point is recorded the worker taps this to hand the
 * ITP to the office; it then shows in /qa as awaiting sign-off. The
 * enable/disable decision is the SHARED pure `canSubmitForReview` so the
 * button can never offer an action the server would 409 — and the same
 * rule drives the admin queue's button.
 *
 * States rendered:
 *   - witnessed   → a calm "Submitted — waiting for sign-off" notice
 *                   (the recording is done; nothing more for the worker).
 *   - signed-off / archived → nothing (the screen is locked above).
 *   - in-progress complete  → enabled button.
 *   - pending / in-progress incomplete → disabled button + honest copy.
 *
 * Click → success/error is thin glue over the unit-tested client +
 * route; the SSR render tests pin the disabled/enabled/copy states.
 */
export function ITPSubmitForReview({
  jobId,
  instance,
  viewer,
  onSaved,
  onError,
}: Props) {
  const [submitting, setSubmitting] = useState(false);

  // Already submitted — the office owns it now.
  if (instance.status === "witnessed") {
    return (
      <PhilNotice tone="info" role="status">
        Submitted for review — waiting on the office to sign off.
      </PhilNotice>
    );
  }
  // Locked states are handled by the orchestrator's lockedReason banner.
  if (instance.status === "signed-off" || instance.archived) return null;

  const decision = canSubmitForReview(instance, {
    userId: viewer.id,
    role: viewer.role,
  });
  // The worker is always a recorder here, so wrong-role shouldn't happen;
  // if it somehow does, render nothing rather than a dead button.
  if (decision.ok === false && decision.reason === "wrong-role") return null;

  const disabled = submitting || decision.ok === false;

  async function handleSubmit() {
    setSubmitting(true);
    const r = await submitItpForReview(jobId, { instanceId: instance.id });
    setSubmitting(false);
    if (r.ok) {
      onSaved(r.data.instance);
    } else {
      onError(
        r.error.status === 409
          ? "Couldn't submit — finish the required points, or reload if it changed."
          : r.error.status === 403
            ? "You can't submit this check."
            : "Couldn't submit for review. Try again.",
        r.error.status,
      );
    }
  }

  return (
    <div className="space-y-2" data-testid="itp-submit-for-review">
      <PhilActionButton
        onClick={handleSubmit}
        disabled={disabled}
        aria-disabled={disabled}
      >
        {submitting ? "Submitting…" : "Submit for review"}
      </PhilActionButton>
      {decision.ok === false ? (
        <p className="text-center text-xs text-text-muted">
          Complete all required points before submitting.
        </p>
      ) : (
        <p className="text-center text-xs text-text-muted">
          All required points done — send it to the office for sign-off.
        </p>
      )}
    </div>
  );
}
