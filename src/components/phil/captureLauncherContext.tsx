"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import type { CaptureQuickAction } from "./philCapture";

/**
 * Lets any Phil screen open the global Capture launcher preset to a single
 * action (the My Day quick-action tiles), without each page mounting its own
 * launcher. The launcher itself stays in PhilTabBar (it owns the camera input
 * and the FAB) — this context only carries the "open preset to X" request to
 * it. The FAB path is unaffected: it opens the launcher with no request.
 */
export interface QuickCaptureRequest {
  action: CaptureQuickAction;
  /** Bumped per call so the tab bar reacts even to a repeat of the same tile. */
  seq: number;
}

interface CaptureLauncherValue {
  /** Open the global Capture launcher straight into a quick action. */
  openQuickCapture: (action: CaptureQuickAction) => void;
  /** Consumed by PhilTabBar to drive the launcher; not for screens. */
  request: QuickCaptureRequest | null;
  /** Cleared by PhilTabBar once the request has been handled / the sheet closed. */
  clearRequest: () => void;
}

const CaptureLauncherContext = createContext<CaptureLauncherValue | null>(null);

export function CaptureLauncherProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<QuickCaptureRequest | null>(null);
  const seqRef = useRef(0);

  const openQuickCapture = useCallback((action: CaptureQuickAction) => {
    seqRef.current += 1;
    setRequest({ action, seq: seqRef.current });
  }, []);
  const clearRequest = useCallback(() => setRequest(null), []);

  return (
    <CaptureLauncherContext.Provider value={{ openQuickCapture, request, clearRequest }}>
      {children}
    </CaptureLauncherContext.Provider>
  );
}

export function useCaptureLauncher(): CaptureLauncherValue {
  const ctx = useContext(CaptureLauncherContext);
  if (!ctx) {
    throw new Error("useCaptureLauncher must be used within a CaptureLauncherProvider");
  }
  return ctx;
}
