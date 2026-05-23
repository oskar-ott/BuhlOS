import type { ReactNode } from "react";
import { AdminSidebar } from "./AdminSidebar";
import { AdminTopbar } from "./AdminTopbar";

interface AdminShellProps {
  children: ReactNode;
  title: string;
  breadcrumb?: ReactNode;
}

/**
 * Layout for the new BuhlOS admin surface (Phase A).
 *
 * Replaces the legacy public/admin/_shell.js + admin/index.html boot path
 * for /command-centre only. Legacy /admin/* surfaces continue to use the
 * old shell via vercel.json rewrites; this is parallel for Phase A.
 */
export function AdminShell({ children, title, breadcrumb }: AdminShellProps) {
  return (
    <div className="flex min-h-screen bg-surface-subtle">
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <AdminTopbar title={title} breadcrumb={breadcrumb} />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
