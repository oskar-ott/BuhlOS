import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

/** Instant skeleton while the reports tiles do their Blob-backed reads. */
export default function Loading() {
  return <AdminPageSkeleton title="Reports" variant="cards" count={4} />;
}
