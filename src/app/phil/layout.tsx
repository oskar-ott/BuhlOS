import type { ReactNode } from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { PhilChromeHintProvider } from "@/components/phil/philChromeHint";
import { PHIL_CHROME_COOKIE, parseChromeHint } from "@/domains/phil/chrome-hint";

/**
 * Layout segment for the Phil field surface at /phil/*.
 *
 * Since the legacy-interface cutover this owns the whole field app —
 * legacy /phil, /phil/app and /my-day now 307-redirect to /phil/my-day
 * (vercel.json). The layout renders no shell chrome: each page wraps itself
 * in <PhilShell> (see scripts/check-shell-contract.js).
 *
 * The one thing it does carry is the CHROME HINT: the request's `phil_chrome`
 * cookie (the last server-confirmed sharpened baseline for this browser —
 * src/domains/phil/chrome-hint.ts), parsed once here and provided render-time
 * so the flag-less `loading.tsx` skeletons SSR the remembered chrome instead
 * of flashing the ratified layout on a cold app open. This is the only layer
 * that renders before those skeletons, and reading a request cookie here is
 * free (no blob/flag fetch — /phil pages are dynamic already). The hint is a
 * presentation echo only; every page still resolves the real flags and its
 * explicit booleans win.
 *
 * The manifest link makes Phil installable from the modern pages — the
 * PWA manifest's start_url is /phil/my-day, and PhilShell registers
 * /sw.js for push delivery.
 */
export const metadata: Metadata = {
  manifest: "/manifest.json",
};

export default async function PhilSurfaceLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const hint = parseChromeHint(cookieStore.get(PHIL_CHROME_COOKIE)?.value);
  return <PhilChromeHintProvider hint={hint}>{children}</PhilChromeHintProvider>;
}
