"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { AlertCircle, AlertTriangle, ArrowDown, ArrowUp, CheckCircle2, ChevronDown, ChevronUp, Info, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Workshop Stock — the few shapes every stock screen is built from (the
 * redesign's vocabulary): a SLOT (one calm card for a state, never an error
 * page), a two-line BIG BUTTON (what it does, then what it records), the
 * MINI button (Undo, Try again), the DIRECTION pill (in or out of the
 * workshop), the FOLD (a closed drawer of detail) and the SAVES line (what the
 * button will write, in the receipt's words). On-token; no colour carries a
 * meaning on its own.
 */

export type SlotTone = "ok" | "warn" | "bad" | "neu" | "inf";

const SLOT: Record<SlotTone, { box: string; icon: string; Icon: LucideIcon }> = {
  ok: { box: "border-state-success-subtle-border bg-state-success-subtle-bg", icon: "text-state-success", Icon: CheckCircle2 },
  warn: { box: "border-state-warning-subtle-border bg-state-warning-subtle-bg", icon: "text-state-warning", Icon: AlertTriangle },
  bad: { box: "border-state-danger-subtle-border bg-state-danger-subtle-bg", icon: "text-state-danger", Icon: AlertCircle },
  neu: { box: "border-border bg-surface-subtle", icon: "text-text-muted", Icon: Info },
  inf: { box: "border-state-info-subtle-border bg-state-info-subtle-bg", icon: "text-state-info", Icon: Info },
};

export function Slot({
  tone = "neu",
  title,
  children,
  action,
  below,
  icon,
  hideIcon = false,
  role,
  className,
  testId,
  ...rest
}: {
  tone?: SlotTone;
  title?: ReactNode;
  children?: ReactNode;
  /** a control on the right (the receipt's Undo) */
  action?: ReactNode;
  /** a full-width row under the text (two choices, a progress bar) */
  below?: ReactNode;
  icon?: LucideIcon;
  hideIcon?: boolean;
  role?: "alert" | "status";
  className?: string;
  testId?: string;
} & Record<`data-${string}`, string | undefined>) {
  const t = SLOT[tone];
  const Icon = icon ?? t.Icon;
  return (
    <div role={role} className={cn("rounded-[14px] border p-3", t.box, className)} data-testid={testId} {...rest}>
      <div className="flex items-start gap-2.5">
        {hideIcon ? null : <Icon aria-hidden="true" className={cn("mt-0.5 h-5 w-5 shrink-0", t.icon)} />}
        <div className="min-w-0 flex-1">
          {title ? <p className="text-[15px] font-bold leading-snug text-text">{title}</p> : null}
          {children ? <div className="mt-0.5 space-y-0.5 text-sm leading-snug text-text">{children}</div> : null}
        </div>
        {action ? <div className="shrink-0 self-center">{action}</div> : null}
      </div>
      {below ? <div className="mt-2.5">{below}</div> : null}
    </div>
  );
}

export type BigVariant = "pri" | "sec" | "ter" | "nav" | "dim";

const BIG: Record<BigVariant, string> = {
  pri: "border-2 border-[#e6b800] bg-accent-yellow text-brand-navy hover:brightness-95 active:scale-[0.99]",
  sec: "border-2 border-brand-navy bg-surface text-brand-navy hover:bg-surface-subtle active:scale-[0.99]",
  ter: "border border-border-strong bg-surface-subtle text-brand-navy hover:bg-surface active:scale-[0.99]",
  nav: "border-2 border-brand-navy bg-brand-navy text-text-inverse hover:bg-accent-ink active:scale-[0.99]",
  dim: "border border-border bg-surface-subtle text-text-muted",
};

/**
 * The design's one button shape: a 56px target, bold label, and an optional
 * second line that says what the tap records ("saves Opening count 6 each").
 * `disabled` greys it and keeps the reason readable under the label.
 */
export function BigButton({
  variant = "sec",
  label,
  sub,
  icon,
  className,
  disabled,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BigVariant; label?: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  const v = disabled ? "dim" : variant;
  return (
    <button
      type={type}
      disabled={disabled}
      className={cn(
        "flex min-h-[56px] w-full flex-col items-center justify-center rounded-[14px] px-3.5 py-2 text-center font-display text-[17px] font-bold leading-tight transition focus-visible:outline-brand-navy disabled:cursor-not-allowed",
        variant === "ter" && !disabled && "min-h-[48px] text-[15px]",
        BIG[v],
        className,
      )}
      {...rest}
    >
      {children ?? (
        <>
          <span className="flex items-center gap-2">
            {icon}
            {label}
          </span>
          {sub ? <span className={cn("mt-0.5 block font-sans text-[13px] font-medium leading-snug", disabled ? "text-text-muted" : variant === "nav" ? "text-text-inverse/80" : "text-accent-ink/80")}>{sub}</span> : null}
        </>
      )}
    </button>
  );
}

/** A 44px bordered chip-button: Undo, Try again, Show all. */
export function MiniButton({ className, type = "button", variant = "outline", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "outline" | "nav" }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex min-h-[44px] items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] px-3 text-[15px] font-semibold transition focus-visible:outline-brand-navy disabled:opacity-60",
        variant === "nav" ? "border-[1.5px] border-brand-navy bg-brand-navy text-text-inverse" : "border-[1.5px] border-brand-navy bg-surface text-brand-navy hover:bg-surface-subtle",
        className,
      )}
      {...rest}
    />
  );
}

/** An underlined text action with a full tap target ("Wrong item? Back to the camera"). */
export function LinkButton({ className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={cn("inline-flex min-h-[44px] items-center self-start text-[15px] font-semibold text-state-info underline underline-offset-2 disabled:opacity-60", className)} {...rest} />;
}

export type Direction = "out" | "in" | "return";

const DIRECTION: Record<Direction, { text: string; Icon: LucideIcon }> = {
  out: { text: "Out of the workshop", Icon: ArrowUp },
  in: { text: "Into the workshop", Icon: ArrowDown },
  return: { text: "Into the workshop · back from a job", Icon: ArrowDown },
};

/** Which way stock is moving — said on every flow screen, never implied by colour. */
export function DirectionPill({ direction, note }: { direction: Direction; note?: ReactNode }) {
  const d = DIRECTION[direction];
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <span className="inline-flex h-[30px] items-center gap-1.5 rounded-pill bg-brand-navy px-3 text-[13px] font-bold text-text-inverse">
        <d.Icon aria-hidden="true" className="h-4 w-4" strokeWidth={2.6} />
        {d.text}
      </span>
      {note ? <span className="text-[13px] font-semibold text-text-muted">{note}</span> : null}
    </div>
  );
}

/** A closed drawer of detail: tap to open. The label says what is inside. */
export function FoldButton({ label, sub, open, onClick, testId, className }: { label: ReactNode; sub?: ReactNode; open: boolean; onClick: () => void; testId?: string; className?: string }) {
  const Icon = open ? ChevronUp : ChevronDown;
  return (
    <button type="button" onClick={onClick} aria-expanded={open} className={cn("flex min-h-[48px] w-full items-center justify-between gap-3 rounded-xl border border-border bg-surface-subtle px-3.5 py-2 text-left", className)} data-testid={testId}>
      <span className="min-w-0">
        <span className="block text-[15px] font-semibold text-brand-navy">{label}</span>
        {sub ? <span className="block truncate text-[13px] text-text-muted">{sub}</span> : null}
      </span>
      <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-brand-navy" />
    </button>
  );
}

/** "Saves: Taken 2 each · 13 each recorded after this" — what the button will write. */
export function SavesLine({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="rounded-[10px] bg-surface-subtle px-3 py-2 text-sm font-semibold leading-snug text-text" data-testid={testId}>
      {children}
    </p>
  );
}

/** Small mono section label (a shelf, "Taken often", "Latest movements"). */
export function Kicker({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("font-mono text-[12px] font-bold uppercase tracking-[0.1em] text-text", className)}>{children}</p>;
}

/** A field's provenance tag: "Read from photo", "Listing", "Same as last item". */
export function Tag({ children, tone = "neu" }: { children: ReactNode; tone?: "neu" | "inf" }) {
  return (
    <span className={cn("ml-1.5 inline-flex h-[18px] items-center rounded px-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.06em]", tone === "inf" ? "bg-state-info-subtle-bg text-state-info-subtle-text" : "bg-surface-subtle text-text-muted")}>
      {children}
    </span>
  );
}

/** A form label with an optional tag beside it. */
export function FieldLabel({ children, tag, htmlFor, className }: { children: ReactNode; tag?: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cn("flex items-center text-sm font-semibold text-text", className)}>
      {children}
      {tag}
    </label>
  );
}

export const FIELD = "mt-1 h-12 w-full rounded-xl border border-border-strong bg-surface px-3 text-base text-text disabled:opacity-60";
