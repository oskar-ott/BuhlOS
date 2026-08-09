import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

/** Instant skeleton while the server render does its Blob-backed reads.
 *  Title matches the page's AdminShell title so the header never flashes. */
export default function Loading() {
  return <AdminPageSkeleton title="Hours · today" variant="list" count={6} />;
}
