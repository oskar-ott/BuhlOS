import Link from "next/link";
import type { Route } from "next";
import { Settings } from "lucide-react";
import { AdminSearchBox } from "./AdminSearchBox";
import { SignOutButton } from "./SignOutButton";

interface AdminTopbarProps {
  /** Static initials for the viewer avatar chip — null renders no chip
   *  (honest-or-absent; resolved from the real session in AdminShell). */
  viewerInitials?: string | null;
}

/**
 * The top bar's right-hand cluster (lean-reset redesign, 2026-07-26 replica):
 * universal search + ⌘K hint, a settings gear (the /settings hub, #222 — no
 * longer a rail footer link), sign-out, and a STATIC viewer-initials avatar
 * chip. The chip is display-only — per doc 27 §13 (as amended for the
 * redesign) there is still NO profile dropdown on this surface.
 *
 * The page title + breadcrumb moved into the content column (AdminShell), per
 * the replica. Mobile (< md): search stays; the gear / sign-out / avatar
 * cluster hides — those live in AdminMobileTabBar's "More" sheet, which is
 * untouched by this slice.
 */
export function AdminTopbar({ viewerInitials }: AdminTopbarProps) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
      {/* #188: universal search — server-scoped admin/LH results. */}
      <AdminSearchBox />
      {/* #215: ONE affordance for the ⌘K command layer — a subtle,
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
      <Link
        href={"/settings" as Route}
        aria-label="Settings"
        data-testid="admin-settings-link"
        className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-card text-text-muted transition-colors hover:bg-surface-subtle hover:text-text md:inline-flex"
      >
        <Settings aria-hidden="true" className="h-4 w-4" />
      </Link>
      <SignOutButton
        iconOnly
        className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-card text-text-muted transition-colors hover:bg-surface-subtle hover:text-text disabled:opacity-60 md:inline-flex"
      />
      {viewerInitials ? (
        <span
          data-testid="admin-viewer-avatar"
          aria-label={`Signed in as ${viewerInitials}`}
          className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-pill bg-brand-navy font-display text-sm font-bold text-text-inverse md:flex"
        >
          {viewerInitials}
        </span>
      ) : null}
    </div>
  );
}
