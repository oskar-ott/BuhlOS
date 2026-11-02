"use client";

import {
  forwardRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

/**
 * The few controls the ITP screens compose (handoff 2026-11-02 "Design
 * tokens" / "Touch target"). Everything is on the existing tokens — brand
 * navy, accent yellow, state tints — sized for gloves:
 *   primary 64px · secondary 56px · chips / segments 48px · small 44px.
 */

type Btn = ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode };

/** Yellow fill, navy text, 64px. The one primary action per dock/sheet. */
export const ItpPrimaryButton = forwardRef<HTMLButtonElement, Btn & { size?: "lg" | "md" }>(
  function ItpPrimaryButton({ className, children, type = "button", size = "lg", ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex w-full items-center justify-center gap-2 rounded-card border-2 px-4 font-display font-bold",
          "border-[#e6b800] bg-accent-yellow text-brand-navy",
          "transition hover:brightness-95 active:brightness-90 active:scale-[0.99]",
          "focus-visible:outline-brand-navy",
          "disabled:cursor-not-allowed disabled:border-border disabled:bg-border disabled:text-text-muted disabled:active:scale-100",
          size === "lg" ? "min-h-[64px] text-[18px]" : "min-h-[44px] text-[16px]",
          className
        )}
        {...rest}
      >
        {children}
      </button>
    );
  }
);

/** White fill, navy border + text. 56px in sheets, 44px small. */
export const ItpSecondaryButton = forwardRef<
  HTMLButtonElement,
  Btn & { size?: "lg" | "md" | "sm" }
>(function ItpSecondaryButton({ className, children, type = "button", size = "lg", ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-card border-2 px-4 font-display font-bold",
        "border-brand-navy bg-surface text-brand-navy",
        "transition hover:bg-surface-subtle active:scale-[0.99] focus-visible:outline-brand-navy",
        "disabled:cursor-not-allowed disabled:border-border disabled:text-text-muted disabled:active:scale-100",
        size === "lg" && "min-h-[56px] w-full text-[17px]",
        size === "md" && "min-h-[48px] text-[16px]",
        size === "sm" && "min-h-[44px] text-[15px] px-3",
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/** Blue text button (Close, Keep it, Open, Retry all), 44px. */
export const ItpTextButton = forwardRef<HTMLButtonElement, Btn>(function ItpTextButton(
  { className, children, type = "button", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        "inline-flex min-h-[44px] items-center justify-center gap-1 rounded-card px-2 font-display text-[16px] font-bold text-state-info",
        "focus-visible:outline-brand-navy disabled:cursor-not-allowed disabled:text-text-muted",
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/** A 48px name/address pill. Selected = navy fill. */
export function ItpChip({
  selected = false,
  className,
  children,
  ...rest
}: Btn & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        "inline-flex min-h-[48px] max-w-full items-center rounded-pill border px-4 text-left text-[16px] font-semibold",
        "transition active:scale-[0.98] focus-visible:outline-brand-navy disabled:cursor-not-allowed disabled:opacity-60",
        selected
          ? "border-brand-navy bg-brand-navy text-text-inverse"
          : "border-border-strong bg-surface text-text hover:bg-surface-subtle",
        className
      )}
      {...rest}
    >
      <span className="line-clamp-2 break-words">{children}</span>
    </button>
  );
}

export type PhotoSource = "camera" | "roll";

/** Camera · Camera roll — two equal 48px segments. Resets to Camera every
 *  time a sheet opens (the caller owns the state). */
export function ItpSegmented({
  value,
  onChange,
  disabled = false,
}: {
  value: PhotoSource;
  onChange: (next: PhotoSource) => void;
  disabled?: boolean;
}) {
  const seg = (key: PhotoSource, label: string) => (
    <button
      type="button"
      aria-pressed={value === key}
      disabled={disabled}
      onClick={() => onChange(key)}
      className={cn(
        "min-h-[48px] flex-1 rounded-[10px] px-3 text-[16px] font-bold transition focus-visible:outline-brand-navy",
        value === key
          ? "bg-brand-navy text-text-inverse"
          : "bg-surface text-brand-navy hover:bg-surface-subtle",
        "disabled:cursor-not-allowed disabled:opacity-60"
      )}
    >
      {label}
    </button>
  );
  return (
    <div
      role="group"
      aria-label="Photos from"
      className="flex gap-1 rounded-card border border-border-strong bg-surface p-1"
    >
      {seg("camera", "Camera")}
      {seg("roll", "Camera roll")}
    </div>
  );
}

export const ItpInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function ItpInput({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(
          "min-h-[52px] w-full min-w-0 rounded-[10px] border border-border-strong bg-surface px-3 text-[16px] text-text",
          "placeholder:text-text-muted focus-visible:outline-brand-navy disabled:opacity-60",
          className
        )}
        {...rest}
      />
    );
  }
);

export function ItpLabel({
  htmlFor,
  children,
  className,
}: {
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn("block text-[14px] font-bold text-text-muted", className)}
    >
      {children}
    </label>
  );
}

/** A dot + words pill at the 14px minimum, in the five tones. */
export function ItpBadge({
  tone,
  children,
  className,
}: {
  tone: "neutral" | "info" | "warning" | "danger" | "success";
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    neutral:
      "bg-state-neutral-subtle-bg border-state-neutral-subtle-border text-state-neutral-subtle-text",
    info: "bg-state-info-subtle-bg border-state-info-subtle-border text-state-info-subtle-text",
    warning:
      "bg-state-warning-subtle-bg border-state-warning-subtle-border text-state-warning-subtle-text",
    danger:
      "bg-state-danger-subtle-bg border-state-danger-subtle-border text-state-danger-subtle-text",
    success:
      "bg-state-success-subtle-bg border-state-success-subtle-border text-state-success-subtle-text",
  } as const;
  const dots = {
    neutral: "bg-state-neutral-dot",
    info: "bg-state-info-dot",
    warning: "bg-state-warning-dot",
    danger: "bg-state-danger-dot",
    success: "bg-state-success-dot",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-[14px] font-semibold leading-tight",
        tones[tone],
        className
      )}
    >
      <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", dots[tone])} />
      <span>{children}</span>
    </span>
  );
}
