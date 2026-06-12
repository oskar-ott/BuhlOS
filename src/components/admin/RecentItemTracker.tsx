"use client";

import { useEffect } from "react";
import { recordRecentItem, type RecentItem } from "@/lib/storage/recent-items";

interface RecentItemTrackerProps {
  /** Route to navigate back to (e.g. /v2/jobs/abc, /employees/u1). */
  path: string;
  /** Human label for the palette row (job name, worker name). */
  title: string;
  /** Record kind. */
  type: RecentItem["type"];
}

/**
 * Records "you viewed this record" in the device-local recents ring buffer
 * (#215), so ⌘K can offer it as a one-keystroke jump back. Renders nothing.
 *
 * Mounted by the two record pages whose detail views are worth resuming —
 * /v2/jobs/[jobId] and /employees/[id]. Writing happens in a mount effect
 * (never during render), keyed on the identifying fields so navigating
 * between two jobs re-records. Storage is best-effort; a failure is silent.
 */
export function RecentItemTracker({ path, title, type }: RecentItemTrackerProps) {
  useEffect(() => {
    recordRecentItem({ path, title, type });
  }, [path, title, type]);
  return null;
}
