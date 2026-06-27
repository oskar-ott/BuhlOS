import type { ReactNode } from "react";
import { AdminSidebar } from "./AdminSidebar";
import { AdminTopbar } from "./AdminTopbar";
import { AdminMobileTabBar } from "./AdminMobileTabBar";
import { CommandPalette } from "./CommandPalette";
import { PwaRegistrar } from "@/components/pwa/PwaRegistrar";

interface AdminShellProps {
  children: ReactNode;
  title: string;
  breadcrumb?: ReactNode;
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
export function AdminShell({ children, title, breadcrumb }: AdminShellProps) {
  return (
    <div data-testid="buhlos-admin-shell" className="flex h-screen overflow-hidden bg-surface-subtle">
      <AdminSidebar />
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
        <AdminMobileTabBar />
      </div>
      <CommandPalette />
      <PwaRegistrar />
    </div>
  );
}
