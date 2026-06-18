"use client";

import { useEffect, useState } from "react";

import { isOnline, subscribeOnline } from "@/domains/phil/online";

/**
 * Reactive online/offline state for Phil surfaces (#139).
 *
 * Starts `true` so server render and first client paint agree (no hydration
 * mismatch — the server is always "online"), then corrects to the real value
 * on mount and tracks transitions. navigator.onLine is a cheap signal, not a
 * reachability guarantee, so writes still go through philWrite which fails
 * honestly; this only drives the visible offline affordance.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(isOnline());
    return subscribeOnline(setOnline);
  }, []);
  return online;
}
