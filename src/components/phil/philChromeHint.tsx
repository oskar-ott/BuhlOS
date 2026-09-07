"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { PhilChromeHint } from "@/domains/phil/chrome-hint";

/**
 * Carries the chrome-hint cookie's parsed value (src/domains/phil/chrome-hint.ts)
 * from the /phil layout — the one server component that renders BEFORE the
 * loading skeletons — down to the chrome components (PhilHeader, PhilTabBar,
 * PhilSharpenedProvider).
 *
 * Unlike philChromeMemory (client singleton, post-mount only), this value is
 * request-scoped and identical on the server pass and the client's first
 * frame — it is read from the request's cookies and threaded through React —
 * so flag-less renders may consult it DURING SSR with no hydration mismatch.
 * That is what lets a cold-start skeleton paint the remembered chrome from
 * the first byte instead of flashing the ratified layout until the page
 * streams in (field report 2026-08-23).
 *
 * Precedence at the consumers: explicit server-resolved prop → chrome memory
 * (post-mount, fresher within the session) → this hint → today's default.
 * Null (cookie absent/invalid, or no provider — tests, /v2/phil outside the
 * /phil segment) = no hint: behaviour is byte-identical to before it existed.
 */
const PhilChromeHintContext = createContext<PhilChromeHint | null>(null);

export function PhilChromeHintProvider({
  hint,
  children,
}: {
  hint: PhilChromeHint | null;
  children: ReactNode;
}) {
  return (
    <PhilChromeHintContext.Provider value={hint}>{children}</PhilChromeHintContext.Provider>
  );
}

/** The remembered chrome baseline for this request, or null when none. */
export function usePhilChromeHint(): PhilChromeHint | null {
  return useContext(PhilChromeHintContext);
}
