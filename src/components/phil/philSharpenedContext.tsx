"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { usePhilChromeHint } from "./philChromeHint";
import { readPhilChromeMemory, rememberPhilChrome } from "./philChromeMemory";

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
 *
 * `undefined` props (a flag-less render such as a `loading.tsx` skeleton)
 * consult the chrome memory POST-MOUNT (philChromeMemory.ts — mounted-gate
 * contract), then the request's chrome hint (philChromeHint.tsx — cookie-fed,
 * SSR-safe, covers cold app opens); explicit booleans always win and refresh
 * that memory.
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
  rfiRegister,
  children,
}: {
  sharpened?: boolean;
  rfiRegister?: boolean;
  children: ReactNode;
}) {
  // Mounted gate (see philChromeMemory.ts): the memory fallback applies only
  // after mount so the first client frame matches the server HTML. The chrome
  // HINT is request-scoped (identical on both passes) so it may drive SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Explicit props refresh the memory; undefined keys are no-ops by design.
  useEffect(() => {
    rememberPhilChrome({ sharpened, rfiRegister });
  }, [sharpened, rfiRegister]);
  const memory = readPhilChromeMemory();
  const hint = usePhilChromeHint();
  const effectiveSharpened =
    sharpened ?? (mounted ? memory.sharpened : null) ?? hint?.sharpened ?? false;
  // The hint carries no rfiRegister bit (the chip only matters after an
  // interaction, by which time the memory is warm) — memory or off.
  const effectiveRfiRegister =
    rfiRegister ?? (mounted ? memory.rfiRegister : null) ?? false;
  const value = useMemo(
    () => ({ sharpened: effectiveSharpened, rfiRegister: effectiveRfiRegister }),
    [effectiveSharpened, effectiveRfiRegister],
  );
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
