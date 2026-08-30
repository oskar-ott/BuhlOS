import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

/** Instant skeleton while the pay-period page fans out its per-week closeout
 *  + export dry-run reads (a fortnight = several sequential-feeling seconds
 *  of blank page without this). Title matches the page's AdminShell title. */
export default function Loading() {
  return <AdminPageSkeleton title="Hours · pay period" variant="list" count={5} />;
}
