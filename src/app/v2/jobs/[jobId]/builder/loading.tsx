import { AdminPageSkeleton } from "@/components/admin/AdminPageSkeleton";

/** Instant skeleton while the server render does its job/users/reconciliation
 *  reads — the builder previously showed NOTHING during the load, which read
 *  as broken. Same pattern as /v2/jobs/loading.tsx. */
export default function Loading() {
  return <AdminPageSkeleton title="Job builder" variant="cards" count={4} />;
}
