import { PhilShell } from "@/components/phil/PhilShell";
import { PhilSkeleton, PhilSkeletonCard } from "@/components/phil/ui/PhilSkeleton";

/**
 * Instant skeleton for /phil/hours while the server fetches the worker's
 * time-entry history. Stands in for the back link, the week summary card and
 * the first couple of entry rows so tapping "Hours" feels immediate instead
 * of freezing the previous screen during the Blob-backed render.
 */
export default function Loading() {
  return (
    <PhilShell title="Hours history">
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading your hours…</span>
        <PhilSkeleton className="h-5 w-24" />
        <div className="space-y-2">
          <PhilSkeleton className="h-6 w-28" />
          <PhilSkeleton className="h-4 w-64 max-w-full" />
        </div>
        <PhilSkeletonCard />
        <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex min-h-[72px] items-center gap-3 px-4 py-3">
              <div className="flex-1 space-y-2">
                <PhilSkeleton className="h-4 w-1/3" />
                <PhilSkeleton className="h-3 w-1/2" />
              </div>
              <PhilSkeleton className="h-5 w-14 rounded-pill" />
            </div>
          ))}
        </div>
      </div>
    </PhilShell>
  );
}
