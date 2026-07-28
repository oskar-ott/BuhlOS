// Server-side reader for the ServiceM8 daily-sync report blob
// (servicem8-sync.json, written by api/_lib/servicem8-sync.js via the
// /api/internal/sync-checks/servicem8 cron). The command-centre card renders
// this snapshot — the page never talks to ServiceM8 itself.

import { readJsonBlob } from "@/server/blob";

export const SERVICEM8_REPORT_KEY = "servicem8-sync.json";

export type ServiceM8SyncReport = {
  lastRun?: string;
  status?: "ok" | "error" | "skipped";
  reason?: string;
  error?: string;
  sm8Count?: number;
  matchedCount?: number;
  /** Jobs auto-created by the LAST run. */
  created?: Array<{ id: string; name: string; sm8Number?: string }>;
  failed?: Array<{ name: string; sm8Number?: string; error?: string }>;
  /** Cumulative auto-created memory (capped in the writer). */
  autoCreated?: Array<{ id: string; name: string; sm8Number?: string; createdAt?: string }>;
  /** Auto-created jobs still live but with NO assigned workers — hours can't
   *  be logged to these until someone assigns the crew. */
  needsAssignment?: Array<{ id: string; name: string }>;
};

export async function loadServiceM8SyncReport(): Promise<ServiceM8SyncReport | null> {
  return readJsonBlob<ServiceM8SyncReport>(SERVICEM8_REPORT_KEY, null);
}
