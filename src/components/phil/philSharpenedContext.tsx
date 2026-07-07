"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

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
interface PhilSharpenedContextValue {
  sharpened: boolean;
  /** rfi_register, resolved server-side alongside phil_sharpened: whether the
   *  sharpened Capture sheet may offer the RFI purpose chip (the raise 404s
   *  when the register is off — a rendered chip would be a dead selection). */
  rfiRegister: boolean;
}

const OFF: PhilSharpenedContextValue = { sharpened: false, rfiRegister: false };

const PhilSharpenedContext = createContext<PhilSharpenedContextValue>(OFF);

export function PhilSharpenedProvider({
  sharpened,
  rfiRegister = false,
  children,
}: {
  sharpened: boolean;
  rfiRegister?: boolean;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ sharpened, rfiRegister }), [sharpened, rfiRegister]);
  return (
    <PhilSharpenedContext.Provider value={value}>{children}</PhilSharpenedContext.Provider>
  );
}

/** True when the phil_sharpened re-skins should render. Safe without a
 *  provider (returns false — the current UI). */
export function usePhilSharpened(): boolean {
  return useContext(PhilSharpenedContext).sharpened;
}

/** True when the RFI register is on for this viewer — gates the sharpened
 *  Capture RFI chip. Safe without a provider (false — no chip). */
export function usePhilRfiRegister(): boolean {
  return useContext(PhilSharpenedContext).rfiRegister;
}
