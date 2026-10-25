import type { ReactNode } from "react";
import { GraduationCap, Sun, Thermometer, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { LEAVE_LABELS, type LeaveType } from "@/domains/timesheets/hours-view";

export const LEAVE_ICON: Record<LeaveType, LucideIcon> = {
  sick: Thermometer,
  holiday: Sun,
  tafe: GraduationCap,
};

/**
 * The dashed "Not a job day" group: outlined pill options with icons, kept
 * apart from any job list by shape and by a label of their own. Selected =
 * navy fill + filled dot, the one selected look on the screen.
 */
export function LeavePills({
  options,
  selected,
  onSelect,
  sentType = null,
}: {
  options: ReadonlyArray<LeaveType>;
  selected: LeaveType | null;
  onSelect: (t: LeaveType) => void;
  /** In the Fix sheet: the type that was sent, marked "What you sent". */
  sentType?: LeaveType | null;
}): ReactNode {
  return (
    <div
      className="rounded-[16px] border border-dashed border-border-strong p-3"
      data-testid="hours-leave-group"
      role="radiogroup"
      aria-label="Not a job day"
    >
      <p className="font-display text-[13px] font-bold uppercase tracking-[0.06em] text-text-muted">
        Not a job day
      </p>
      <p className="mt-0.5 text-[13px] text-text-muted">Goes to payroll as leave, not to a job</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((t) => {
          const Icon = LEAVE_ICON[t];
          const active = t === selected;
          return (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onSelect(t)}
              data-testid={`hours-leave-${t}`}
              className={cn(
                "inline-flex min-h-[48px] items-center gap-2 rounded-pill border px-4 font-display text-[15px] font-semibold",
                active
                  ? "border-brand-navy bg-brand-navy text-white"
                  : "border-border-strong bg-surface text-text active:bg-surface-subtle"
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-4 w-4 items-center justify-center rounded-full border",
                  active ? "border-white" : "border-border-strong"
                )}
              >
                {active ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
              </span>
              <Icon aria-hidden="true" className="h-4 w-4" />
              {LEAVE_LABELS[t]}
              {sentType === t ? (
                <span
                  className={cn(
                    "text-[12px] font-semibold",
                    active ? "text-white/80" : "text-text-muted"
                  )}
                >
                  · What you sent
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
