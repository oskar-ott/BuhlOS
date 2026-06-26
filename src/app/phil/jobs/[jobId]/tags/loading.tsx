import { PhilShell } from "@/components/phil/PhilShell";
import { PhilSkeleton } from "@/components/phil/ui/PhilSkeleton";

/**
 * Instant skeleton for a job's Test & tag register while the server fetches
 * the job's tagged assets. Stands in for the back link, title and a few
 * register rows so the tap feels immediate.
 */
export default function Loading() {
  return (
    <PhilShell title="Test & tag">
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading test &amp; tag register…</span>
        <PhilSkeleton className="h-5 w-24" />
        <div className="space-y-2">
          <PhilSkeleton className="h-6 w-32" />
          <PhilSkeleton className="h-4 w-64 max-w-full" />
        </div>
        <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex min-h-[64px] items-center gap-3 px-4 py-3">
              <div className="flex-1 space-y-2">
                <PhilSkeleton className="h-4 w-2/3" />
                <PhilSkeleton className="h-3 w-1/3" />
              </div>
              <PhilSkeleton className="h-5 w-16 rounded-pill" />
            </div>
          ))}
        </div>
      </div>
    </PhilShell>
  );
}
