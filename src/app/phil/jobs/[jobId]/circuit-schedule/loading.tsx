import { PhilShell } from "@/components/phil/PhilShell";
import { PhilSkeleton } from "@/components/phil/ui/PhilSkeleton";

/**
 * Instant skeleton for a job's circuit schedule while the server fetches the
 * board(s) and their ways. Stands in for the back link, title and a board
 * card of way rows so the tap paints immediately.
 */
export default function Loading() {
  return (
    <PhilShell title="Circuit schedule">
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading circuit schedule…</span>
        <PhilSkeleton className="h-5 w-24" />
        <div className="space-y-2">
          <PhilSkeleton className="h-6 w-40" />
          <PhilSkeleton className="h-4 w-64 max-w-full" />
        </div>
        <div className="space-y-3 rounded-card border border-border bg-surface-raised p-4">
          <PhilSkeleton className="h-5 w-1/2" />
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <PhilSkeleton className="h-4 w-8" />
              <PhilSkeleton className="h-4 flex-1" />
              <PhilSkeleton className="h-7 w-20 rounded-pill" />
            </div>
          ))}
        </div>
      </div>
    </PhilShell>
  );
}
