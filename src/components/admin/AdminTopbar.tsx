import type { ReactNode } from "react";

interface AdminTopbarProps {
  title: string;
  breadcrumb?: ReactNode;
}

export function AdminTopbar({ title, breadcrumb }: AdminTopbarProps) {
  return (
    <header className="flex h-16 items-center justify-between border-b border-border bg-surface px-6">
      <div>
        <h1 className="font-display text-lg text-text">{title}</h1>
        {breadcrumb ? (
          <div className="mt-0.5 text-xs text-text-muted">{breadcrumb}</div>
        ) : null}
      </div>
      <div
        aria-label="User menu (placeholder)"
        className="flex h-9 w-9 items-center justify-center rounded-pill border border-border bg-surface-subtle text-xs font-medium text-text-muted"
      >
        ME
      </div>
    </header>
  );
}
