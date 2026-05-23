import type { ReactNode } from "react";

/**
 * Route group wrapper for the new admin surface. The actual shell chrome
 * (sidebar + topbar) is applied per-page via <AdminShell> so individual
 * routes can choose their title/breadcrumb. This layout exists to keep
 * the (admin) group in the URL tree per docs/architecture/01-target-rebuild-structure.md.
 */
export default function AdminGroupLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
