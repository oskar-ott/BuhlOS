import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Generic list-row shell (prototype `.row`): a min-48px row with a growing
 * title/meta body and a right slot. The one row pattern the inboxes, registers
 * and hub lists share, so list items stay consistent. Pass `onClick` to make the
 * whole row a button (deep-link a job, open a drawer).
 */
interface RowProps {
  title?: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  className?: string;
  children?: ReactNode;
}

export function Row({ title, meta, right, onClick, className, children }: RowProps) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        {title ? (
          <div className="truncate font-display text-sm font-semibold text-text">{title}</div>
        ) : null}
        {meta ? (
          <div className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-text-muted">
            {meta}
          </div>
        ) : null}
        {children}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </>
  );
  const base = "flex min-h-[48px] items-center gap-3 px-3 py-2";
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(base, "w-full text-left transition-colors hover:bg-surface-subtle", className)}
      >
        {body}
      </button>
    );
  }
  return <div className={cn(base, className)}>{body}</div>;
}
