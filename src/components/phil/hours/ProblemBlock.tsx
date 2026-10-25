import type { ReactNode } from "react";
import { AlertCircle, RotateCw } from "lucide-react";
import { cn } from "@/lib/cn";
import type { HoursProblem } from "@/domains/timesheets/problem";

/**
 * A failed action, in the slot that failed: what happened, why, what to do,
 * and a Try again in the same block when trying again can work. The words
 * come from explainHoursProblem (problem.ts) — the same words the office
 * screens use for the same failure.
 */
export function ProblemBlock({
  problem,
  onRetry,
  retryLabel = "Try again",
  retryTestId = "hours-problem-retry",
  className,
}: {
  problem: HoursProblem;
  onRetry?: () => void;
  retryLabel?: string;
  retryTestId?: string;
  className?: string;
}): ReactNode {
  return (
    <div
      role="alert"
      data-testid="hours-problem"
      className={cn("rounded-[16px] border border-[#f4c9c9] bg-[#fee2e2] p-4 text-text", className)}
    >
      <div className="flex items-start gap-3">
        <AlertCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-state-danger" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-display text-[16px] font-bold leading-snug text-state-danger">
            {problem.title}
          </p>
          <p className="text-[14px] leading-snug text-text">{problem.why}</p>
          <p className="text-[14px] leading-snug text-text">{problem.todo}</p>
        </div>
      </div>
      {onRetry && problem.canRetry ? (
        <button
          type="button"
          onClick={onRetry}
          data-testid={retryTestId}
          className="mt-3 flex min-h-[48px] w-full items-center justify-center gap-2 rounded-card bg-accent-yellow px-4 font-display text-[15px] font-bold text-accent-ink active:scale-[0.99]"
        >
          <RotateCw aria-hidden="true" className="h-4 w-4" />
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}
