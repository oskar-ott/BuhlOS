import { PhilShell } from "@/components/phil/PhilShell";
import { PhilSkeleton, PhilSkeletonCard } from "@/components/phil/ui/PhilSkeleton";

/**
 * Instant skeleton for /phil/leave while the server resolves the worker's
 * leave context. Mirrors the back link + title + the first card so the tap
 * paints immediately instead of holding the previous screen.
 */
export default function Loading() {
  return (
    <PhilShell title="Leave">
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading leave…</span>
        <PhilSkeleton className="h-5 w-24" />
        <div className="space-y-2">
          <PhilSkeleton className="h-6 w-24" />
          <PhilSkeleton className="h-4 w-64 max-w-full" />
        </div>
        <PhilSkeletonCard />
      </div>
    </PhilShell>
  );
}
