import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

/** Instant skeleton while the owner-console summary does its Blob-backed reads. */
export default function Loading() {
  return <AdminPageSkeleton title="Owner Console" variant="cards" count={5} />;
}
