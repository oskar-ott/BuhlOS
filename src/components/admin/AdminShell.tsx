import type { ReactNode } from "react";
import { AdminSidebar } from "./AdminSidebar";
import { AdminTopbar } from "./AdminTopbar";
import { AdminMobileTabBar } from "./AdminMobileTabBar";
import { CommandPalette } from "./CommandPalette";
import { FLAGGED_ITEMS } from "./nav";
import { PwaRegistrar } from "@/components/pwa/PwaRegistrar";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isFlagEnabled } from "../../../api/_lib/feature-flags.js";
import type { SessionPayload } from "@/lib/auth/session";

interface AdminShellProps {
  children: ReactNode;
  title: string;
  breadcrumb?: ReactNode;
  /** Job Detail Variants design: pages whose content leads with its own hero
   *  (the job hub) skip the shell's page-head block — the hero carries the
   *  page's h1 instead, so the title never renders twice. */
  hideHead?: boolean;
}

/**
 * #760 owner feature-control: resolve which flag-gated nav destinations to hide
 * from THIS viewer. Reads the same viewer-aware resolver the routes/APIs use, so
 * the top nav, ⌘K palette and mobile IA reflect exactly what the owner has
 * turned off (and what the owner is previewing). Fails OPEN — on any error the
 * chrome shows everything; the route + API 404 remain the authoritative gate, so
 * a stray visible link can never expose a disabled feature's data.
 */
async function resolveHiddenNavHrefs(viewer: SessionPayload | null): Promise<string[]> {
  try {
    const checks = await Promise.all(
      FLAGGED_ITEMS.map(async ({ href, flag }) => ({
        href,
        on: await isFlagEnabled(flag, viewer),
      }))
    );
    return checks.filter((c) => !c.on).map((c) => c.href);
  } catch {
    return [];
  }
}

/**
 * Viewer initials for the top bar's static avatar chip (lean-reset redesign).
 * Honest-or-absent: derived only from the real session (name, else username,
 * else email local part). No session identity → no chip, never a placeholder.
 */
function viewerInitials(viewer: SessionPayload | null): string | null {
  const source = viewer?.name || viewer?.username || viewer?.email?.split("@")[0];
  if (!source) return null;
  const words = source
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  const initials = words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
  return initials || null;
}

/**
 * Layout for the BuhlOS admin surface. Since the interface cutover this IS the
 * admin shell — public/admin/_shell.js is gone and the old /admin/* URLs
 * redirect to the modern routes.
 *
 * Lean-reset redesign (2026-07-26, owner-ratified replica): the chrome is a
 * single white TOP BAR — bühl wordmark, horizontal nav pills (AdminSidebar,
 * which keeps its name for guard/test continuity), then search + settings +
 * sign-out + viewer avatar (AdminTopbar). The page title + optional breadcrumb
 * render at the top of the scrolling content column, per the replica. Below md
 * the nav pills hide and AdminMobileTabBar stays the primary navigation
 * (mobile re-skin is a separate slice).
 *
 * PwaRegistrar registers /sw.js so admin devices keep receiving Web Push
 * (office inbox, digests, overrun alerts) and silently refreshes the push
 * subscription when permission is already granted. The explicit opt-in
 * lives on /command-centre (PushNotificationsCard).
 *
 * CommandPalette is the ⌘K keyboard command layer (#215) — mounted as a
 * client child (same pattern as AdminSidebar) so this stays a server
 * component. It renders nothing until ⌘K / Ctrl+K opens it.
 */
export async function AdminShell({ children, title, breadcrumb, hideHead }: AdminShellProps) {
  const viewer = await getCurrentUser().catch(() => null);
  const hiddenHrefs = await resolveHiddenNavHrefs(viewer);
  const initials = viewerInitials(viewer);
  return (
    <div
      data-testid="buhlos-admin-shell"
      // Office warm theme (Job Detail Variants design) — retunes the shared
      // tokens to the login screen's cream/ink inside this scope only; Phil
      // keeps the root values. See tokens.css [data-theme="office"].
      data-theme="office"
      // text-text re-anchors inherited text INSIDE the theme scope — without
      // it, unclassed text falls through to body's root-value ink.
      className="flex h-screen flex-col overflow-hidden bg-surface-subtle text-text"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 sm:px-5">
        {/* The bühl wordmark leads the office shell — ink on the white bar. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset in /public, not a remote/optimised image */}
        <img
          src="/brand/buhl-logo-ink.png"
          alt="bühl electrical"
          className="h-10 w-auto shrink-0"
        />
        {/* Horizontal nav pills (desktop). Named AdminSidebar for continuity —
            shell guards and the render suite key off the component name. */}
        <AdminSidebar hiddenHrefs={hiddenHrefs} />
        <AdminTopbar viewerInitials={initials} />
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* The scroll region — the top bar stays fixed while only the content
            scrolls. The shell is bounded to the viewport (h-screen +
            overflow-hidden) so the body never scrolls the chrome away; min-h-0
            lets this flex child shrink below content so its own overflow-y
            engages. */}
        <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {/* Page head per the replica: display title, breadcrumb beside it,
              and the login screen's yellow rule beneath — the one brand
              signature carried into every office page (2026-08-09 polish).
              Hero-led pages (hideHead) render their own h1 in the content. */}
          {hideHead ? null : (
            <div className="mb-5 min-w-0">
              <div className="flex min-w-0 items-end gap-3">
                <h1 className="min-w-0 truncate font-display text-2xl font-bold tracking-tight text-text">
                  {title}
                </h1>
                {breadcrumb ? (
                  <div className="shrink-0 pb-0.5 text-xs text-text-muted">{breadcrumb}</div>
                ) : null}
              </div>
              <div aria-hidden="true" className="mt-2 h-1 w-12 bg-accent-yellow" />
            </div>
          )}
          {children}
        </main>
        {/* Mobile-only bottom tab bar (md:hidden) — the calm office nav below
            md, where the top-bar nav pills are hidden. A flex sibling of
            <main> (mirrors PhilShell) so it reserves its own space rather than
            overlaying the scroll region; gone entirely on desktop. */}
        <AdminMobileTabBar hiddenHrefs={hiddenHrefs} />
      </div>
      <CommandPalette hiddenHrefs={hiddenHrefs} />
      <PwaRegistrar />
    </div>
  );
}
