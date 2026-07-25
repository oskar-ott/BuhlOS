import { PhilShell } from "@/components/phil/PhilShell";
import { PhilSkeleton } from "@/components/phil/ui/PhilSkeleton";

/**
 * Instant skeleton for /phil/gear while the server checks the session and
 * flags. The page is a coming-soon placeholder, so this stays minimal —
 * no fake list cards.
 */
export default function Loading() {
  return (
    <PhilShell title="Gear">
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading…</span>
        <PhilSkeleton className="h-5 w-20" />
        <PhilSkeleton className="h-40 w-full" />
      </div>
    </PhilShell>
  );
}
