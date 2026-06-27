import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

/** Instant skeleton while the defects queue does its Blob-backed reads. */
export default function Loading() {
  return <AdminPageSkeleton title="Defects" variant="list" count={5} />;
}
