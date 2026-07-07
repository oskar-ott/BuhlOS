import { cn } from "@/lib/cn";

/**
 * The one Phil status-badge language (sharpened design system §1).
 *
 * Five tones, one shape: a pale tint pill + a solid 6px dot + an Inter Tight
 * 700 UPPERCASE label at 12px (the repo's ratified legibility floor — the
 * prototype's 11px is deliberately raised; see legibility-floor.test.ts).
 * Colour never carries meaning alone — every badge has a written label.
 *
 * The canonical status vocabulary (the ONLY task/proof/sync labels allowed —
 * don't invent ten badge styles that mean the same thing):
 *   neutral  Not started
 *   info     In progress · Submitted · Syncing
 *   warning  Needs photo · In review · Offline
 *   danger   Blocked · Rejected · Failed
 *   success  Done · Approved · Saved
 *
 * Domain-specific words that aren't statuses of work (job-row phrases like
 * "Check owed" / "Due soon" / "Expired") may REUSE a tone by passing an
 * explicit `tone` with their label — the type system requires the tone for
 * any non-canonical label, so the canonical mapping can't drift silently.
 *
 * On-token by construction: the tint quads are the --state-*-subtle-* /
 * --state-*-dot tokens (src/styles/tokens.css), added for this badge set.
 */
export type PhilStatusTone = "neutral" | "info" | "warning" | "danger" | "success";

/** The canonical status wording — tone is derived, never passed. */
export const PHIL_STATUS_TONE = {
  "Not started": "neutral",
  "In progress": "info",
  "Needs photo": "warning",
  Blocked: "danger",
  Done: "success",
  Submitted: "info",
  "In review": "warning",
  Approved: "success",
  Rejected: "danger",
  Saved: "success",
  Syncing: "info",
  Offline: "warning",
  Failed: "danger",
} as const satisfies Record<string, PhilStatusTone>;

export type PhilStatusLabel = keyof typeof PHIL_STATUS_TONE;

const TONE_CLASSES: Record<PhilStatusTone, { pill: string; dot: string }> = {
  neutral: {
    pill: "bg-state-neutral-subtle-bg border-state-neutral-subtle-border text-state-neutral-subtle-text",
    dot: "bg-state-neutral-dot",
  },
  info: {
    pill: "bg-state-info-subtle-bg border-state-info-subtle-border text-state-info-subtle-text",
    dot: "bg-state-info-dot",
  },
  warning: {
    pill: "bg-state-warning-subtle-bg border-state-warning-subtle-border text-state-warning-subtle-text",
    dot: "bg-state-warning-dot",
  },
  danger: {
    pill: "bg-state-danger-subtle-bg border-state-danger-subtle-border text-state-danger-subtle-text",
    dot: "bg-state-danger-dot",
  },
  success: {
    pill: "bg-state-success-subtle-bg border-state-success-subtle-border text-state-success-subtle-text",
    dot: "bg-state-success-dot",
  },
};

type PhilStatusBadgeProps = {
  className?: string;
} & (
  | {
      /** A canonical status — tone is derived from the vocabulary. */
      label: PhilStatusLabel;
      /** Optional override; normally omit and let the vocabulary decide. */
      tone?: PhilStatusTone;
    }
  | {
      /** A domain word reusing a tone (e.g. "Check owed") — tone required. */
      label: string;
      tone: PhilStatusTone;
    }
);

export function PhilStatusBadge({ label, tone, className }: PhilStatusBadgeProps) {
  const resolved: PhilStatusTone =
    tone ?? PHIL_STATUS_TONE[label as PhilStatusLabel] ?? "neutral";
  const t = TONE_CLASSES[resolved];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-2 py-0.5",
        "font-display text-[12px] font-bold uppercase tracking-[0.03em] leading-none",
        t.pill,
        className,
      )}
    >
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", t.dot)} />
      <span>{label}</span>
    </span>
  );
}
