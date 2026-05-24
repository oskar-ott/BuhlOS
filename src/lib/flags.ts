/**
 * Feature flags + the DEMO MODE indicator.
 *
 * DEMO MODE is on whenever the app is rendering fixture data instead of
 * a real backend response. The shell shows DemoModeBanner whenever this
 * function returns true so users (and screenshots) are never confused
 * about whether what they see is real.
 *
 * Phase A initially returned true (no real wiring). Phase B wired the
 * timesheets domain to real /api/time-entries* endpoints; once that
 * landed in production, the global flag was flipped to false here so
 * the banner stops misleading workers/admins into thinking their real
 * submissions are demo data. Per-domain fixtures (e.g. Storybook,
 * preview) still set their own demo state at the component level.
 */

export type FeatureFlag = "phil-hours-v2" | "admin-shell-v2";

const DEFAULT_FLAGS: Record<FeatureFlag, boolean> = {
  "phil-hours-v2": false, // Phase B
  "admin-shell-v2": false, // Phase B
};

export function isFlagEnabled(flag: FeatureFlag): boolean {
  return DEFAULT_FLAGS[flag];
}

export const fixtures = {
  /**
   * Returns true whenever the app is showing mock data instead of real
   * backend responses. Phase B wires the only end-to-end domain (hours)
   * to the real /api/time-entries* endpoints, so the global flag is now
   * false. If a future phase introduces a domain that is still fixture-
   * backed (e.g. gear before wiring), flip this back to true (or move
   * to per-route detection) until that domain is wired.
   */
  isDemoMode(): boolean {
    return false;
  },
} as const;
