import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

/** Instant skeleton while the approvals queue does its Blob-backed reads. */
export default function Loading() {
  return <AdminPageSkeleton title="Hours · approvals" variant="list" count={5} />;
}
