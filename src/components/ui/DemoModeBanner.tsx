import { fixtures } from "@/lib/flags";

/**
 * Top-of-shell banner that screams DEMO MODE whenever fixtures are being
 * rendered instead of real backend responses.
 *
 * Mandatory per docs/architecture/00-rebuild-non-negotiables.md
 *   §"Feature gating" rule 3: "No mock-only UI pretending to be functional."
 *
 * Phase A is entirely fixtures (no real wiring), so this banner is always
 * visible. Phase B+ flips it off per-domain as real data lands.
 */
export function DemoModeBanner() {
  if (!fixtures.isDemoMode()) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2 border-b border-amber-300 bg-amber-100 px-4 py-1.5 text-xs font-medium uppercase tracking-widest text-amber-900"
    >
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-amber-700" />
      Demo mode — data shown is not real
    </div>
  );
}
