import { CERTAINTY_LABEL, type CertaintyState } from "@/domains/jobs/certainty";
import { StatusChip, type StatusTone } from "@/components/ui/StatusChip";
import { cn } from "@/lib/cn";

/**
 * The certainty badge for the Job Builder cockpit (§4) — a member of the
 * StatusChip family (mono uppercase chip + state dot), with the one extra visual
 * cue the brief calls for per state: a suggestion reads dashed/muted, an ignored
 * row reads struck-through. Colour = meaning; wording is fixed by
 * CERTAINTY_LABEL so the chip never invents a synonym.
 */

const CERTAINTY_TONE: Record<CertaintyState, StatusTone> = {
  suggested: "neutral", // muted + dashed (see modifier)
  needs_review: "warning", // amber — owes a decision
  confirmed: "success", // green — field-eligible
  converted: "navy", // solid navy — realised as a task
  ignored: "neutral", // struck-through (see modifier)
  rfi: "info", // blue — the explicit unknown
};

/** Per-state visual cues layered on top of the shared StatusChip tone. */
const CERTAINTY_MODIFIER: Partial<Record<CertaintyState, string>> = {
  suggested: "border-dashed text-text-muted",
  ignored: "line-through text-text-muted",
};

interface CertaintyChipProps {
  cert: CertaintyState;
  className?: string;
}

export function CertaintyChip({ cert, className }: CertaintyChipProps) {
  return (
    <StatusChip
      tone={CERTAINTY_TONE[cert]}
      data-cert={cert}
      className={cn(CERTAINTY_MODIFIER[cert], className)}
    >
      {CERTAINTY_LABEL[cert]}
    </StatusChip>
  );
}
