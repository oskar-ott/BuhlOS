"use client";

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  defectSuggestionFor,
  snagPrefillFor,
  type SnagEvidenceLink,
} from "@/domains/evidence/defect-suggestions";
import { confidencePercent } from "./EvidenceLabelChips";
import type { EvidenceItem } from "@/domains/evidence/types";
import {
  SNAG_DESCRIPTION_MAX,
  SNAG_PRIORITIES,
  SNAG_TITLE_MAX,
} from "@/domains/snags/schema";
import type { CreateSnagPayload, SnagPriority } from "@/domains/snags/types";
import { cn } from "@/lib/cn";

interface Props {
  item: EvidenceItem;
  /** The job's snags — drives the 'linked' projection state. */
  snags: SnagEvidenceLink[];
  busy: boolean;
  /** POSTs action=dismiss-defect-suggestion; owned by the queue. */
  onDismiss: () => void;
  /** POSTs the EXISTING snag create path; resolves to an error message
   *  for inline display, or null on success. Owned by the queue. */
  onRaiseSnag: (payload: CreateSnagPayload) => Promise<string | null>;
}

const PRIORITY_LABELS: Record<SnagPriority, string> = {
  low: "Low",
  normal: "Normal",
  high: "High",
  urgent: "Urgent",
};

/**
 * #267 — the AI defect→snag suggestion panel in the evidence drawer.
 *
 * The suggestion is a pure projection (defectSuggestionFor); this card
 * only renders the state and routes the two human decisions:
 *   - "Raise snag…" opens an inline mini-form prefilled from
 *     snagPrefillFor — title / description / priority all editable
 *     BEFORE save — and POSTs the existing snag creation. No snag ever
 *     exists without this explicit human accept.
 *   - "Dismiss" stamps the sticky dismissal; afterwards the projection
 *     flips to 'dismissed' and the card quietens to one muted line.
 *
 * 'linked' shows a muted "raised from this photo" note with the snag
 * ids; 'none' renders nothing. The parent only mounts this when the
 * ai_snag_suggestions flag is on for an admin viewer — the feature is
 * dark otherwise. Key this component by item.id so the prefill state
 * resets per photo (soft-nav initial-prop pitfall).
 */
export function EvidenceDefectSuggestionCard({
  item,
  snags,
  busy,
  onDismiss,
  onRaiseSnag,
}: Props) {
  const suggestion = defectSuggestionFor(item, snags);

  const [formOpen, setFormOpen] = useState(false);
  // Prefill lazily so the worked text only computes for a live suggestion.
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<SnagPriority>("normal");
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (suggestion.state === "none") return null;

  if (suggestion.state === "linked") {
    return (
      <p className="text-xs text-text-muted" data-testid="defect-suggestion-linked">
        Snag raised from this photo — {suggestion.snagIds.join(", ")}.
      </p>
    );
  }

  if (suggestion.state === "dismissed") {
    // Quiet by design: a human already flicked it away.
    return (
      <p className="text-xs text-text-muted" data-testid="defect-suggestion-dismissed">
        Suggestion dismissed.
      </p>
    );
  }

  const label = suggestion.label;
  const pct = confidencePercent(
    typeof label.confidence === "number" ? label.confidence : null
  );

  const openForm = () => {
    const prefill = snagPrefillFor(item, label);
    setTitle(prefill.title);
    setDescription(prefill.description);
    setPriority("normal");
    setFormError(null);
    setFormOpen(true);
  };

  const submit = async () => {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFormError("Title is required.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    const err = await onRaiseSnag({
      title: trimmedTitle,
      description: description.trim() ? description.trim() : null,
      priority,
      areaId: item.areaId ?? null,
      stage: item.stage ?? null,
      taskId: item.taskId ?? null,
      evidenceIds: [item.id],
    });
    setSubmitting(false);
    if (err) {
      setFormError(err);
    } else {
      setFormOpen(false);
    }
  };

  const disabled = busy || submitting;

  return (
    <div
      className="rounded-card border border-amber-200 bg-amber-50 p-3"
      data-testid="defect-suggestion-card"
    >
      <p className="flex items-center gap-1.5 font-display text-xs uppercase tracking-wider text-amber-900">
        <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
        AI suggestion
      </p>
      <p className="mt-1 text-sm text-amber-900">
        This photo may show a defect{pct ? ` (confidence ${pct})` : ""}. It
        stays a suggestion until you decide.
      </p>

      {formOpen ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block">
            <span className="block font-display text-xs uppercase tracking-wider text-amber-900">
              Title
            </span>
            <input
              type="text"
              value={title}
              maxLength={SNAG_TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              disabled={disabled}
              className="mt-1 block h-10 w-full rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="block font-display text-xs uppercase tracking-wider text-amber-900">
              Description
            </span>
            <textarea
              value={description}
              maxLength={SNAG_DESCRIPTION_MAX}
              onChange={(e) => setDescription(e.target.value)}
              disabled={disabled}
              rows={3}
              className="mt-1 block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60"
            />
          </label>
          <label className="block">
            <span className="block font-display text-xs uppercase tracking-wider text-amber-900">
              Priority
            </span>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as SnagPriority)}
              disabled={disabled}
              className="mt-1 block h-10 rounded-card border border-border bg-surface px-3 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60"
            >
              {SNAG_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </label>
          {formError ? (
            <p role="alert" className="text-xs text-rose-700">
              {formError}
            </p>
          ) : null}
          <div className={cn("flex gap-2 pt-1")}>
            <Button type="submit" size="sm" variant="primary" disabled={disabled}>
              {submitting ? "Raising…" : "Raise snag"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setFormOpen(false)}
              disabled={disabled}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={openForm}
            disabled={disabled}
            data-testid="defect-suggestion-raise"
          >
            Raise snag…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDismiss}
            disabled={disabled}
            data-testid="defect-suggestion-dismiss"
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
