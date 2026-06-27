import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

/** Instant skeleton while the employees view does its Blob-backed reads. */
export default function Loading() {
  return <AdminPageSkeleton title="Employees" variant="list" count={6} />;
}
