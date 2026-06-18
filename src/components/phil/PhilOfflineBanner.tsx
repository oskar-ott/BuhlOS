"use client";

import { PhilNotice } from "./ui/PhilNotice";
import { useOnline } from "./useOnline";

/**
 * Presentational offline banner (no hook) — exported for SSR render tests.
 * Honest copy: the worker is seeing their last-loaded data and writes won't
 * land until signal returns (constitution P8 — degrade honestly, never pretend).
 */
export function OfflineBannerView() {
  return (
    <PhilNotice tone="warning" role="status" title="You're offline" className="mb-3">
      Showing your last loaded data. Changes won&apos;t send until you&apos;re back on signal.
    </PhilNotice>
  );
}

/**
 * Live banner: renders nothing while online, the banner while offline. SSR and
 * first paint render nothing (useOnline starts true), so there is no hydration
 * flash; the banner appears only after the client detects no connection.
 */
export function PhilOfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return <OfflineBannerView />;
}
