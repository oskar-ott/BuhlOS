"use client";

import { useEffect } from "react";
import { recordView } from "./jobListPrefs";

/**
 * Phil — record that the worker opened this job (#145, P14).
 *
 * A mount-only client effect: the job screen is a server component, so this
 * tiny component does the client-side `recordView` so the next visit to the
 * jobs list can surface this job in the automatic "Recent" group + sort it up.
 * Renders nothing.
 *
 * Best-effort + client-only by construction (recordView is SSR-safe and never
 * throws). Keyed by userId so it stays the signed-in worker's own history; an
 * empty userId is a no-op.
 */
export function PhilJobViewRecorder({
  userId,
  jobId,
}: {
  userId: string;
  jobId: string;
}) {
  useEffect(() => {
    recordView(userId, jobId);
  }, [userId, jobId]);
  return null;
}
