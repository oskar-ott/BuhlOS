import type { ReactNode } from "react";

/**
 * Layout segment for /phil/onboarding.
 *
 * Intentionally minimal — the onboarding shell is a focused funnel with
 * no Phil header / tab bar. Each step renders its own full-bleed shell.
 */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
