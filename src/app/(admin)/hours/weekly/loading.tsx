import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

/** Instant skeleton while the weekly board does its Blob-backed reads —
 *  the heaviest hours page (overview + runs + per-worker cost rates), so a
 *  blank wait here read as the section being broken. Title matches the page's
 *  AdminShell title, so the header never flashes to a different name. */
export default function Loading() {
  return <AdminPageSkeleton title="Hours · this week" variant="list" count={6} />;
}
