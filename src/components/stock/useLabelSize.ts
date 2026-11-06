"use client";

import { useCallback, useState } from "react";
import { labelSize, type LabelSize } from "@/domains/workshop-stock/label";

const SIZE_KEY = "buhlos.stock.labelSize";

function savedSize(): string | null {
  try { return window.localStorage.getItem(SIZE_KEY); } catch { return null; }
}

/**
 * The label size picked on this device — the roll that's in the printer, so
 * item labels and bin labels share it. Remembered per device (a convenience
 * only: without storage it starts at the first size).
 */
export function useLabelSize(): [LabelSize, (key: string) => void] {
  const [key, setKey] = useState<string>(() => labelSize(typeof window === "undefined" ? null : savedSize()).key);
  const choose = useCallback((next: string) => {
    setKey(next);
    try { window.localStorage.setItem(SIZE_KEY, next); } catch { /* a per-device convenience only */ }
  }, []);
  return [labelSize(key), choose];
}
