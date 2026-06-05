import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

interface PhilActionButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  /** md = 44px (the field-glove minimum), lg = 48px (default for primary CTAs). */
  size?: "md" | "lg";
  /** Stretch to the container width (default true — Phil CTAs are full-width). */
  fullWidth?: boolean;
}

const SIZE: Record<"md" | "lg", string> = {
  md: "h-11 px-4 text-sm",
  lg: "h-12 px-5 text-base",
};

/**
 * Phil's accent (yellow) primary action.
 *
 * The Phil surface had four hand-rolled copies of
 *   <Button variant="primary" className="bg-accent-yellow ... hover:bg-accent-yellow">
 * which (a) overrode the Button variant inline and (b) set hover to the base
 * colour, so the most important CTA had *no* press feedback. This consolidates
 * them into one on-token control with real hover/press feedback
 * (`brightness` + `scale`, the pattern already used on /v2/phil), a guaranteed
 * ≥44px tap target, and a navy focus ring (the global yellow ring is invisible
 * on a yellow button).
 *
 * Yellow-on-navy is reserved for the single primary field action per screen —
 * status colour stays with StatusChip/Pill.
 */
export const PhilActionButton = forwardRef<HTMLButtonElement, PhilActionButtonProps>(
  function PhilActionButton(
    { children, size = "lg", fullWidth = true, className, type = "button", ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type}
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-card font-semibold",
          "bg-accent-yellow text-brand-navy",
          "transition hover:brightness-95 active:brightness-90 active:scale-[0.99]",
          "focus-visible:outline-brand-navy",
          "disabled:cursor-not-allowed disabled:opacity-60 disabled:active:scale-100",
          SIZE[size],
          fullWidth && "w-full",
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);
