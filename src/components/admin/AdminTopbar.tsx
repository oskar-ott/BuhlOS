import type { ReactNode } from "react";

interface AdminTopbarProps {
  title: string;
  breadcrumb?: ReactNode;
}

/**
 * Admin top bar — page title + optional breadcrumb.
 *
 * Profile / settings lives in the sidebar footer (sign-out) and the
 * dedicated Settings section once that ships. Per doc 27 §13 there is
 * NO profile dropdown / avatar pill in the top-right — that pattern is
 * banned for this surface.
 */
export function AdminTopbar({ title, breadcrumb }: AdminTopbarProps) {
  return (
    <header className="flex h-16 items-center border-b border-border bg-surface px-6">
      <div className="min-w-0">
        <h1 className="truncate font-display text-lg text-text">{title}</h1>
        {breadcrumb ? (
          <div className="mt-0.5 text-xs text-text-muted">{breadcrumb}</div>
        ) : null}
      </div>
    </header>
  );
}
