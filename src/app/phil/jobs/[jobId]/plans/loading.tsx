import { PhilShell } from "@/components/phil/PhilShell";
import { PhilSkeleton } from "@/components/phil/ui/PhilSkeleton";

/**
 * Instant skeleton for the Phil plan viewer while the server fetches the
 * job + plans. Stands in for the back link, the read-only intro, and the
 * drawing stage.
 */
export default function Loading() {
  return (
    <PhilShell title="Plans">
      <div className="space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading plans…</span>
        <PhilSkeleton className="h-5 w-24" />
        <div className="space-y-2">
          <PhilSkeleton className="h-6 w-20" />
          <PhilSkeleton className="h-4 w-64 max-w-full" />
        </div>
        <PhilSkeleton className="h-[50vh] min-h-[16rem] w-full rounded-card" />
      </div>
    </PhilShell>
  );
}
