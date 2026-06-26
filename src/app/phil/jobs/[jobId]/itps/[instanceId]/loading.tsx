import { PhilShell } from "@/components/phil/PhilShell";
import { PhilSkeleton, PhilSkeletonCard } from "@/components/phil/ui/PhilSkeleton";

/**
 * Instant skeleton for a job's ITP while the server fetches the inspection
 * record and its points. Stands in for the back link, header and the first
 * couple of point cards so the tap feels immediate.
 */
export default function Loading() {
  return (
    <PhilShell title="ITP">
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading inspection…</span>
        <PhilSkeleton className="h-5 w-24" />
        <div className="space-y-3 rounded-card border border-border bg-surface-raised p-5">
          <PhilSkeleton className="h-6 w-2/3" />
          <PhilSkeleton className="h-4 w-1/2" />
        </div>
        <PhilSkeletonCard />
        <PhilSkeletonCard />
      </div>
    </PhilShell>
  );
}
