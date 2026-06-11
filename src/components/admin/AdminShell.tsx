import type { ReactNode } from "react";
import { AdminSidebar } from "./AdminSidebar";
import { AdminTopbar } from "./AdminTopbar";
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
 */
export function AdminShell({ children, title, breadcrumb }: AdminShellProps) {
  return (
    <div data-testid="buhlos-admin-shell" className="flex min-h-screen bg-surface-subtle">
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AdminTopbar title={title} breadcrumb={breadcrumb} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
      <PwaRegistrar />
    </div>
  );
}
