import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface OnboardingShellProps {
  children: ReactNode;
  /**
   * When true, the children are responsible for top padding (used by the
   * Welcome and Ready screens, which don't have the progress bar).
   */
  noProgressOffset?: boolean;
  className?: string;
}

/**
 * Mobile-first onboarding shell.
 *
 * Constrains to max-w-md the same way PhilShell does so the design is
 * faithful on mobile and stays usable on desktop. No tab bar, no header —
 * the onboarding funnel is a focused flow that ends by dropping the worker
 * onto /phil/my-day.
 */
export function OnboardingShell({
  children,
  noProgressOffset = false,
  className,
}: OnboardingShellProps) {
  return (
    <div className="min-h-svh bg-surface-subtle">
      <div
        className={cn(
          "relative mx-auto flex min-h-svh w-full max-w-md flex-col bg-surface-subtle",
          className
        )}
      >
        <div
          className={cn(
            "flex flex-1 flex-col pb-40",
            noProgressOffset ? "pt-6" : "pt-2"
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
