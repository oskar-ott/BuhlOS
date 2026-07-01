import type { ReactNode } from "react";
import { AdminSidebar } from "./AdminSidebar";
import { AdminTopbar } from "./AdminTopbar";
import { AdminMobileTabBar } from "./AdminMobileTabBar";
import { CommandPalette } from "./CommandPalette";
import { FLAGGED_ITEMS } from "./nav";
import { PwaRegistrar } from "@/components/pwa/PwaRegistrar";
import { getCurrentUser } from "@/lib/auth/current-user";
import { isFlagEnabled } from "../../../api/_lib/feature-flags.js";

interface AdminShellProps {
  children: ReactNode;
  title: string;
  breadcrumb?: ReactNode;
}

/**
 * #760 owner feature-control: resolve which flag-gated nav destinations to hide
 * from THIS viewer. Reads the same viewer-aware resolver the routes/APIs use, so
 * the sidebar, ⌘K palette and mobile IA reflect exactly what the owner has
 * turned off (and what the owner is previewing). Fails OPEN — on any error the
 * chrome shows everything; the route + API 404 remain the authoritative gate, so
 * a stray visible link can never expose a disabled feature's data.
 */
async function resolveHiddenNavHrefs(): Promise<string[]> {
  try {
    const viewer = await getCurrentUser();
    const checks = await Promise.all(
      FLAGGED_ITEMS.map(async ({ href, flag }) => ({
        href,
        on: await isFlagEnabled(flag, viewer),
      })),
    );
    return checks.filter((c) => !c.on).map((c) => c.href);
  } catch {
    return [];
  }
}

/**
 * Layout for the BuhlOS admin surface. Since the legacy-interface cutover
 * this IS the admin shell — the legacy public/admin/_shell.js suite is gone
 * and the old /admin/* URLs redirect to the modern routes.
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
export async function AdminShell({ children, title, breadcrumb }: AdminShellProps) {
  const hiddenHrefs = await resolveHiddenNavHrefs();
  return (
    <div data-testid="buhlos-admin-shell" className="flex h-screen overflow-hidden bg-surface-subtle">
      <AdminSidebar hiddenHrefs={hiddenHrefs} />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AdminTopbar title={title} breadcrumb={breadcrumb} />
        {/* The scroll region — the sidebar (h-screen) + topbar stay fixed while
            only the content scrolls. The shell is bounded to the viewport
            (h-screen + overflow-hidden) so the body never scrolls the chrome
            away; min-h-0 lets this flex child shrink below content so its own
            overflow-y engages. */}
        <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
        {/* Mobile-only bottom tab bar (md:hidden) — the calm office nav below
            md, where AdminSidebar is hidden. A flex sibling of <main> (mirrors
            PhilShell) so it reserves its own space rather than overlaying the
            scroll region; gone entirely on desktop. */}
        <AdminMobileTabBar hiddenHrefs={hiddenHrefs} />
      </div>
      <CommandPalette hiddenHrefs={hiddenHrefs} />
      <PwaRegistrar />
    </div>
  );
}
