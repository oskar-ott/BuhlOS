import type { ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { STATUS_WORDS } from "@/domains/timesheets/status-words";
import type { TimeEntryStatus } from "@/domains/timesheets/types";
import styles from "./hours.module.css";

/**
 * The status words on the Hours screen, always word + icon, never colour
 * alone (docs/phil-hours.md). The four stored statuses come from the ONE
 * vocabulary (status-words.ts); the two app-side states — Saving… and Not
 * confirmed — are this screen's own and exist only while a send is in flight
 * or unanswered.
 */
export type HoursPillState = TimeEntryStatus | "saving" | "unconfirmed";

const PILL: Record<HoursPillState, { word: string; Icon: LucideIcon; className: string }> = {
  draft: {
    word: STATUS_WORDS.draft,
    Icon: FileText,
    className: "bg-surface-subtle text-text-muted",
  },
  submitted: {
    word: STATUS_WORDS.submitted,
    Icon: Clock,
    className: "bg-[#dbeafe] text-state-info",
  },
  approved: {
    word: STATUS_WORDS.approved,
    Icon: CheckCircle2,
    className: "bg-[#dcfce7] text-state-success",
  },
  rejected: {
    word: STATUS_WORDS.rejected,
    Icon: AlertCircle,
    className: "bg-[#fee2e2] text-state-danger",
  },
  saving: { word: "Saving…", Icon: Loader2, className: "bg-brand-navy text-white" },
  unconfirmed: {
    word: "Not confirmed",
    Icon: AlertTriangle,
    className: "bg-[#fef3c7] text-state-warning",
  },
};

export function statusPillWord(state: HoursPillState): string {
  return PILL[state].word;
}

export function StatusPill({
  state,
  className,
  size = "sm",
}: {
  state: HoursPillState;
  className?: string;
  /** `md` for the day-detail sheet's headline pill. */
  size?: "sm" | "md";
}): ReactNode {
  const { word, Icon, className: tone } = PILL[state];
  return (
    <span
      data-testid={`hours-status-${state}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-pill font-display font-bold leading-tight",
        size === "md" ? "px-3 py-2 text-[14px]" : "max-w-[124px] px-2 py-1 text-center text-[12px]",
        tone,
        className
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(size === "md" ? "h-4 w-4" : "h-3.5 w-3.5", state === "saving" && styles.spin)}
      />
      <span>{word}</span>
    </span>
  );
}
