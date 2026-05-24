import type { ReactNode } from "react";

/**
 * Layout for the new BuhlOS admin /hours/* surface (Phase B).
 *
 * The legacy admin keeps its own /admin/hours, /admin/approvals etc. via
 * vercel.json rewrites. The new admin uses the bare /hours and
 * /hours/approvals paths — they're unclaimed by vercel.json and Next.js
 * owns them naturally per docs/rebuild-audit/16-migration-strategy.md §B.
 */
export default function HoursLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
