// Online/offline detection for Phil field writes (#139).
//
// navigator.onLine is the cheap, synchronous signal a field worker needs: it
// is false when the device has no network interface up. It is NOT a guarantee
// of reachability (you can be "online" on a dead site connection), so the
// write client (./write-client) still treats every send as fallible — this is
// only the fast pre-check that avoids firing a doomed request and lets the UI
// show an honest "offline" state. SSR-safe: assume online when there is no
// navigator/window (the server is, by definition, connected).

export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  // Only an explicit `false` means offline; treat unknown as online.
  return navigator.onLine !== false;
}

/**
 * Subscribe to browser online/offline transitions. Returns an unsubscribe
 * function. No-op (returns a no-op cleanup) outside the browser.
 */
export function subscribeOnline(onChange: (online: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handleOnline = () => onChange(true);
  const handleOffline = () => onChange(false);
  window.addEventListener("online", handleOnline);
  window.addEventListener("offline", handleOffline);
  return () => {
    window.removeEventListener("online", handleOnline);
    window.removeEventListener("offline", handleOffline);
  };
}
