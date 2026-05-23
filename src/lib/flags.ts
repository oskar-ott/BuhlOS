/**
 * Feature flags + the DEMO MODE indicator.
 *
 * DEMO MODE is on whenever the app is rendering fixture data instead of
 * a real backend response. The shell shows DemoModeBanner whenever this
 * function returns true so users (and screenshots) are never confused
 * about whether what they see is real.
 *
 * In Phase A we have no real client data wiring yet, so fixtures.isDemoMode()
 * returns true by default. As real wiring lands in Phase B+, this becomes
 * false in production and stays true under test/preview as needed.
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
   * backend responses. Phase A is entirely placeholder shells, so this is
   * permanently true. Phase B+ flips it off per-domain.
   */
  isDemoMode(): boolean {
    return true;
  },
} as const;
