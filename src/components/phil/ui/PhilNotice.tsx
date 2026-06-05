import type { ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

export type PhilNoticeTone = "info" | "success" | "warning" | "danger" | "neutral";

interface PhilNoticeProps {
  /** Semantic tone — drives the rail + icon colour (icon + text, never colour-only). */
  tone?: PhilNoticeTone;
  /** Bold lead line — what happened. */
  title?: ReactNode;
  /** Body / supporting line(s) / inline CTA. */
  children?: ReactNode;
  /** ARIA role — "alert" for load/submit errors, "status" for passive notices. */
  role?: "alert" | "status";
  /** Hide the leading tone icon for very compact inline notices. */
  hideIcon?: boolean;
  className?: string;
}

/**
 * The one Phil notice / banner / inline-error surface.
 *
 * Replaces the hand-rolled `border-amber-200 bg-amber-50` / `bg-rose-50`
 * boxes scattered across the Phil pages and panels with a single on-token
 * pattern: a neutral raised card, a 4px tone-coloured left rail, and a
 * tone-coloured icon. Tone is conveyed by icon + copy (not colour alone),
 * so it survives a colour-blind glance and an outdoor screen.
 *
 * On-token by construction — uses only `state-*`, `surface-*`, `border`,
 * and `text-*` tokens (the `state-*` tokens are solid single colours, so a
 * tinted fill via opacity is not available; the rail + icon carry the tone).
 */
const TONE: Record<PhilNoticeTone, { rail: string; icon: string; Icon: LucideIcon }> = {
  info: { rail: "border-l-state-info", icon: "text-state-info", Icon: Info },
  success: { rail: "border-l-state-success", icon: "text-state-success", Icon: CheckCircle2 },
  warning: { rail: "border-l-state-warning", icon: "text-state-warning", Icon: AlertTriangle },
  danger: { rail: "border-l-state-danger", icon: "text-state-danger", Icon: AlertCircle },
  neutral: { rail: "border-l-border-strong", icon: "text-text-muted", Icon: Info },
};

export function PhilNotice({
  tone = "info",
  title,
  children,
  role = "status",
  hideIcon = false,
  className,
}: PhilNoticeProps) {
  const t = TONE[tone];
  const Icon = t.Icon;
  return (
    <div
      role={role}
      className={cn(
        "flex gap-3 rounded-card border border-border border-l-4 bg-surface-raised p-3.5 text-left",
        t.rail,
        className,
      )}
    >
      {hideIcon ? null : (
        <Icon aria-hidden="true" className={cn("mt-0.5 h-5 w-5 shrink-0", t.icon)} />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        {title ? (
          <p className="font-display text-sm font-semibold leading-snug text-text">{title}</p>
        ) : null}
        {children ? (
          <div className="text-sm leading-snug text-text-muted">{children}</div>
        ) : null}
      </div>
    </div>
  );
}
