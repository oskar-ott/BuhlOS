import { PhilShell } from "@/components/phil/PhilShell";
import { PhilSkeleton } from "@/components/phil/ui/PhilSkeleton";

/**
 * Instant skeleton for /phil/jobs while the server component fetches the
 * worker's assigned jobs. Mirrors the page chrome (title + a list of rows)
 * so the tap feels immediate instead of flashing a blank navy bar.
 */
export default function Loading() {
  return (
    <PhilShell title="Jobs">
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading your jobs…</span>
        <div className="space-y-2">
          <PhilSkeleton className="h-6 w-24" />
          <PhilSkeleton className="h-4 w-64 max-w-full" />
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex min-h-[88px] items-center gap-3 px-4 py-3">
              <PhilSkeleton className="h-5 w-16 rounded-pill" />
              <div className="flex-1 space-y-2">
                <PhilSkeleton className="h-4 w-2/3" />
                <PhilSkeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </PhilShell>
  );
}
