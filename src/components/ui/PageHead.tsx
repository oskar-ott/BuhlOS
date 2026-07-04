import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Page header (prototype `PageHead`): a display title + a mono-uppercase
 * sub-eyebrow on the left, right-aligned actions. The one header every admin
 * surface leads with, so titles/eyebrows stay consistent.
 */
interface PageHeadProps {
  title: string;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHead({ title, sub, actions, className }: PageHeadProps) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h1 className="font-display text-[26px] font-bold leading-tight tracking-[-0.024em] text-text">
          {title}
        </h1>
        {sub ? (
          <p className="mt-1 font-mono text-[12px] uppercase tracking-wider text-text-muted">
            {sub}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
