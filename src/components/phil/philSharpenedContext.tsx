"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Carries the server-resolved `phil_sharpened` boolean from PhilShell down to
 * client components that are mounted by OTHER components rather than a page —
 * today that's the global Capture launcher (mounted inside PhilTabBar, which
 * receives the flag for its own bar but doesn't own the launcher's design).
 *
 * The flag is resolved ONCE per request, server-side, via philSharpenedFlags()
 * (src/lib/phil/sharpened.ts) and passed to PhilShell as a boolean — this
 * context never fetches and never sees the flags blob. Default FALSE: any
 * consumer rendered outside a provider (tests, storybook-style renders) gets
 * today's un-sharpened UI, byte-identical.
 */
const PhilSharpenedContext = createContext<boolean>(false);

export function PhilSharpenedProvider({
  sharpened,
  children,
}: {
  sharpened: boolean;
  children: ReactNode;
}) {
  return (
    <PhilSharpenedContext.Provider value={sharpened}>{children}</PhilSharpenedContext.Provider>
  );
}

/** True when the phil_sharpened re-skins should render. Safe without a
 *  provider (returns false — the current UI). */
export function usePhilSharpened(): boolean {
  return useContext(PhilSharpenedContext);
}
