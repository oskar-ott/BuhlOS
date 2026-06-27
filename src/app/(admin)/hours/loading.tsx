import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

/** Instant skeleton while the server render does its Blob-backed reads. */
export default function Loading() {
  return <AdminPageSkeleton title="Hours" variant="list" count={6} />;
}
