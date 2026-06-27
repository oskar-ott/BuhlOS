import { AdminShell } from "./AdminShell";
import { cn } from "@/lib/cn";

/** A single shimmering placeholder block (decorative). */
function Bar({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-md bg-border", className)} />;
}

/**
 * Instant route skeleton for the admin surface, used by the `loading.tsx` of
 * `(admin)/*` and `/v2/jobs`. It renders the AdminShell chrome
 * (sidebar / topbar / mobile tab bar) immediately so a nav tap shows structure
 * at once instead of freezing the previous screen during the Blob-backed server
 * render (those routes block ~3.5–5.5s on cold reads). Decorative only — the
 * region carries the screen-reader "Loading…" label.
 *
 * Mirrors the Phil `loading.tsx` precedent (PhilShell + PhilSkeleton) for the
 * office surface. `variant` picks the body shape: a row list (tables / queues)
 * or a card grid (dashboards).
 */
export function AdminPageSkeleton({
  title,
  variant = "list",
  count = 5,
}: {
  title: string;
  variant?: "list" | "cards";
  count?: number;
}) {
  return (
    <AdminShell title={title}>
      <div className="mx-auto max-w-5xl space-y-4" aria-busy="true" aria-live="polite">
        <span className="sr-only">Loading {title}…</span>
        <div className="space-y-3 rounded-card border border-border bg-surface-raised p-5">
          <Bar className="h-6 w-44 max-w-[60%]" />
          <Bar className="h-4 w-72 max-w-full" />
        </div>
        {variant === "cards" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: count }).map((_, i) => (
              <div
                key={i}
                className="space-y-3 rounded-card border border-border bg-surface-raised p-5"
              >
                <Bar className="h-4 w-1/3" />
                <Bar className="h-8 w-1/2" />
                <Bar className="h-3 w-2/3" />
              </div>
            ))}
          </div>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-card border border-border bg-surface-raised">
            {Array.from({ length: count }).map((_, i) => (
              <div key={i} className="flex min-h-[64px] items-center gap-3 px-4 py-3">
                <div className="flex-1 space-y-2">
                  <Bar className="h-4 w-1/3" />
                  <Bar className="h-3 w-1/2" />
                </div>
                <Bar className="h-5 w-16 rounded-pill" />
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  );
}
