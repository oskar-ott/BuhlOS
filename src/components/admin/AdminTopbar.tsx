import type { ReactNode } from "react";
import { AdminSearchBox } from "./AdminSearchBox";

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
 * banned for this surface. The one interactive element is the universal
 * search box (#188), mounted as a client child so this stays a server
 * component.
 */
export function AdminTopbar({ title, breadcrumb }: AdminTopbarProps) {
  return (
    <header className="flex h-16 items-center gap-4 border-b border-border bg-surface px-6">
      <div className="min-w-0 flex-1">
        <h1 className="truncate font-display text-lg text-text">{title}</h1>
        {breadcrumb ? (
          <div className="mt-0.5 text-xs text-text-muted">{breadcrumb}</div>
        ) : null}
      </div>
      {/* #188: universal search — the topbar's one interactive element
          (no profile dropdown per doc 27 §13). Server-scoped admin/LH. */}
      <AdminSearchBox />
    </header>
  );
}
