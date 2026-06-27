import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

/** Instant skeleton while loadSnapshot does its Blob-backed reads. */
export default function Loading() {
  return <AdminPageSkeleton title="Command Centre" variant="cards" count={6} />;
}
