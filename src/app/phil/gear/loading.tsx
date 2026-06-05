import { PhilShell } from "@/components/phil/PhilShell";
import { PhilSkeleton, PhilSkeletonCard } from "@/components/phil/ui/PhilSkeleton";

/**
 * Instant skeleton for /phil/gear while the server fetches the worker's
 * held assets.
 */
export default function Loading() {
  return (
    <PhilShell title="My gear">
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading your gear…</span>
        <PhilSkeleton className="h-5 w-20" />
        <div className="space-y-2">
          <PhilSkeleton className="h-6 w-28" />
          <PhilSkeleton className="h-4 w-64 max-w-full" />
        </div>
        <PhilSkeletonCard />
        <PhilSkeletonCard />
      </div>
    </PhilShell>
  );
}
