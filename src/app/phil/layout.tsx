import type { ReactNode } from "react";
import type { Metadata } from "next";

/**
 * Layout segment for the Phil field surface at /phil/*.
 *
 * Since the legacy-interface cutover this owns the whole field app —
 * legacy /phil, /phil/app and /my-day now 307-redirect to /phil/my-day
 * (vercel.json). The layout stays a pass-through: each page wraps itself
 * in <PhilShell> (see scripts/check-shell-contract.js).
 *
 * The manifest link makes Phil installable from the modern pages — the
 * PWA manifest's start_url is /phil/my-day, and PhilShell registers
 * /sw.js for push delivery.
 */
export const metadata: Metadata = {
  manifest: "/manifest.json",
};

export default function PhilSurfaceLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
