import { cn } from "@/lib/cn";

/**
 * A single shimmering placeholder block.
 *
 * Used by the Phil route `loading.tsx` files to show an honest skeleton of
 * the page chrome while the server component fetches — instant tap feedback
 * instead of a blank navy bar. Decorative only (`aria-hidden`); the loading
 * region carries the screen-reader "Loading…" label.
 */
export function PhilSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-border", className)} />
  );
}

/**
 * A card-shaped skeleton matching the Phil `Card` footprint (rounded-card,
 * raised surface, p-5). Compose `PhilSkeleton` lines inside it.
 */
export function PhilSkeletonCard({ className }: { className?: string }) {
  return (
    <div className={cn("space-y-3 rounded-card border border-border bg-surface-raised p-5", className)}>
      <PhilSkeleton className="h-4 w-1/3" />
      <PhilSkeleton className="h-3 w-2/3" />
      <PhilSkeleton className="h-3 w-1/2" />
    </div>
  );
}
