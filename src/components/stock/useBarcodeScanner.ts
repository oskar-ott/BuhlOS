"use client";

import { useEffect, useRef } from "react";
import { createScanDetector } from "@/domains/workshop-stock/scanner";

/**
 * Listen for a keyboard-style barcode scanner. A scan made while a text field
 * has focus is left to that field (it types into it, as the person expects).
 * Anywhere else the Enter a scan ends with is ALWAYS swallowed — so a scan on a
 * confirmation screen can never press its focused "Confirm take" — and
 * `onScan(code)` is called only while `enabled`.
 */
export function useBarcodeScanner(onScan: (code: string) => void, enabled = true) {
  const ref = useRef(onScan);
  ref.current = onScan;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    const detector = createScanDetector();
    const listener = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const code = detector.key(e.key, e.timeStamp || performance.now());
      if (code) {
        e.preventDefault();
        e.stopPropagation();
        if (enabledRef.current) ref.current(code);
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
}
