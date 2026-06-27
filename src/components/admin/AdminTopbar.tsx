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
 *
 * Mobile (< md): the bühl brand mark leads the bar (the sidebar that carries
 * the wordmark is desktop-only) and primary navigation moves to the bottom tab
 * bar (AdminMobileTabBar) + its "More" sheet — so the old hamburger is gone.
 * Detail pages keep their own back affordance via the breadcrumb. The title
 * stays visible at every width so a phone always knows which surface it is on.
 */
export function AdminTopbar({ title, breadcrumb }: AdminTopbarProps) {
  return (
    <header className="flex h-16 items-center gap-3 border-b border-border bg-surface px-4 sm:gap-4 sm:px-6">
      {/* Mobile brand mark — the office's top-corner bühl mark below md, where
          the desktop sidebar (which carries the wordmark) is hidden. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset in /public, not a remote/optimised image */}
      <img
        src="/brand/buhl-logo-ink.png"
        alt="bühl electrical"
        className="h-6 w-auto shrink-0 md:hidden"
      />
      <div className="min-w-0 flex-1">
        <h1 className="truncate font-display text-lg text-text">{title}</h1>
        {breadcrumb ? (
          <div className="mt-0.5 text-xs text-text-muted">{breadcrumb}</div>
        ) : null}
      </div>
      {/* #188: universal search — the topbar's one interactive element
          (no profile dropdown per doc 27 §13). Server-scoped admin/LH. */}
      <AdminSearchBox />
      {/* #215: ONE topbar affordance for the ⌘K command layer — a subtle,
          NON-interactive hint (not a second search input or clickable
          control). ⌘K is the primary affordance; this just advertises it.
          The palette itself is the surface (mounted in AdminShell). */}
      <kbd
        aria-hidden="true"
        data-testid="admin-cmdk-hint"
        className="hidden shrink-0 items-center gap-1 rounded-card border border-border px-2 py-1 font-mono text-[10px] text-text-muted lg:inline-flex"
      >
        <span className="text-sm leading-none">⌘</span>K
      </kbd>
    </header>
  );
}
