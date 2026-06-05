import { PhilShell } from "@/components/phil/PhilShell";
import { PhilSkeleton, PhilSkeletonCard } from "@/components/phil/ui/PhilSkeleton";

/**
 * Instant skeleton for /phil/my-day while the server fetches the week's
 * time entries. Leads with a tall block standing in for the log-hours
 * capture card (the home's primary action).
 */
export default function Loading() {
  return (
    <PhilShell title="My day">
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading your day…</span>
        <div className="space-y-3 rounded-card border border-border bg-surface-raised p-5">
          <PhilSkeleton className="h-4 w-28" />
          <PhilSkeleton className="h-14 w-full" />
          <PhilSkeleton className="h-10 w-full" />
        </div>
        <PhilSkeletonCard />
      </div>
    </PhilShell>
  );
}
