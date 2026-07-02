import type { ReactNode } from "react";
import { visibleLabels, type LabelledEvidence, type VisibleLabel } from "@/domains/evidence/labels";
import { cn } from "@/lib/cn";

/**
 * Photo-label chips for the admin evidence surfaces (#262).
 *
 * The display contract lives in src/domains/evidence/labels.ts:
 *   - confirmed / accepted labels render as SOLID chips
 *   - unreviewed AI suggestions render as visually-TENTATIVE chips —
 *     dashed border, an explicit "AI" prefix and the confidence % — so a
 *     model guess never masquerades as a human-confirmed fact (P7)
 *   - rejected / below-floor entries never reach this component
 *     (visibleLabels filters them)
 *
 * Display is harmless, so chips render wherever rows carry labels; all
 * label MUTATION controls are gated behind the ai_photo_labels flag by
 * the parent (queue / drawer).
 */

/** Site-language display names for the taxonomy ids. */
const LABEL_DISPLAY_OVERRIDES: Record<string, string> = {
  "rough-in": "Rough-in",
  "fit-off": "Fit-off",
  "cable-tray": "Cable tray",
  "data-comms": "Data & comms",
  "possible-defect": "Possible defect",
};

export function photoLabelDisplay(label: string): string {
  const override = LABEL_DISPLAY_OVERRIDES[label];
  if (override) return override;
  return label.charAt(0).toUpperCase() + label.slice(1).replace(/-/g, " ");
}

export function confidencePercent(confidence: number | null): string | null {
  return typeof confidence === "number" ? `${Math.round(confidence * 100)}%` : null;
}

/**
 * One label chip. `children` lets the drawer append its accept / remove
 * icon buttons inside the same chip.
 */
export function LabelChip({
  label,
  className,
  children,
}: {
  label: VisibleLabel;
  className?: string;
  children?: ReactNode;
}) {
  const pct = confidencePercent(label.confidence);
  return (
    <span
      title={
        label.tentative
          ? "AI suggestion — not confirmed by a human yet"
          : undefined
      }
      className={cn(
        "inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-xs font-medium",
        label.tentative
          ? "border border-dashed border-border-strong bg-surface text-text-muted"
          : "border border-border bg-surface-subtle text-text",
        className
      )}
    >
      {label.tentative ? (
        <span className="font-display text-xs font-semibold uppercase tracking-wide">
          AI
        </span>
      ) : null}
      {photoLabelDisplay(label.label)}
      {label.tentative && pct ? (
        <span className="text-text-muted">{pct}</span>
      ) : null}
      {children}
    </span>
  );
}

/** Read-only chip row for queue rows — renders nothing when unlabelled. */
export function EvidenceLabelChips({
  item,
  className,
}: {
  item: LabelledEvidence;
  className?: string;
}) {
  const labels = visibleLabels(item);
  if (labels.length === 0) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {labels.map((l) => (
        <LabelChip key={l.label} label={l} />
      ))}
    </span>
  );
}
