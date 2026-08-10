import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

export function Card({ className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-card border border-border bg-surface-raised shadow-card p-5",
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardTitle({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2 className={cn("font-display text-lg text-text", className)}>{children}</h2>
  );
}

/**
 * Quiet mono section label with the small yellow tick — the card-label motif
 * every section on the Job Detail Variants surfaces shares ("Money", "Labour",
 * "Evidence", …). Brand yellow stays a brand accent here, never a status.
 */
export function CardKicker({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "font-mono text-xs font-medium uppercase tracking-[0.14em] text-text",
        className
      )}
    >
      {children}
      <span aria-hidden="true" className="ml-2 inline-block h-[3px] w-4 -translate-y-0.5 bg-accent-yellow" />
    </p>
  );
}

export function CardDescription({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <p className={cn("text-sm text-text-muted", className)}>{children}</p>;
}
