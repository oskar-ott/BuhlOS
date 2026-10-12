/**
 * Download a payroll sheet (PDF / CSV from /api/time-entries-export) without
 * ever landing the office on a raw error page (owner pull 2026-10-12: a
 * problem exporting timesheets must never halt the process).
 *
 * The downloads used to be plain links. The server refuses a payroll artifact
 * while hours in the period are still saving (503 'settling' — 2026-10-09
 * integrity rule) or when a day can't be read — and a plain link showed that
 * refusal as a page of JSON with no way back. This fetches instead:
 *   - 'settling' → waits the server's number and fetches again by itself
 *     (same caps as the send — sendPeriodTimesheets);
 *   - ok        → saves the file under the server's own filename;
 *   - anything else → the plain-words problem (and, for days that couldn't be
 *     read, which ones — the screen can offer to download without them; the
 *     PDF names them on its "Not on this sheet" list).
 * A download stamps nothing (ADR #609), so fetching again is always safe.
 */

import { explainHoursProblem, type HoursProblem } from "@/domains/timesheets/problem";
import { parseUnreadableDays, type UnreadableDay } from "@/domains/timesheets/payroll-refusal";
import { MAX_SETTLE_RETRIES, MAX_SETTLE_WAIT_MS } from "./sendPeriodTimesheets";

export type PayrollDownloadOutcome =
  | { ok: true; filename: string }
  | { ok: false; problem: HoursProblem; unreadable: UnreadableDay[] };

export interface PayrollDownloadOptions {
  /** The export URL (same-origin), e.g. payrollSheetUrl(…). */
  url: string;
  /** Used when the server doesn't name the file. */
  fallbackFilename: string;
  onSettling?: (waitMs: number) => void;
  /** False once the screen is gone — stop without fetching again. */
  isActive?: () => boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Hands the bytes to the browser. Swappable for tests. */
  save?: (blob: Blob, filename: string) => void;
}

/** The approved-hours sheet for a period — the same one Send to Tia emails. */
export function payrollSheetUrl({
  fromDate,
  toDate,
  format = "pdf",
  shape,
  skip = [],
}: {
  fromDate: string;
  toDate: string;
  format?: "pdf" | "csv";
  shape?: "review" | "xero";
  /** "userId|date" days to leave off (PDF only — named on the sheet). */
  skip?: string[];
}): string {
  const q = new URLSearchParams({ status: "approved", fromDate, toDate });
  if (format === "pdf") q.set("format", "pdf");
  if (shape) q.set("shape", shape);
  if (format === "pdf" && skip.length) q.set("skip", skip.join(","));
  // Always a dry run, always last (the #895 invariant: a download never stamps).
  q.set("dryRun", "1");
  return `/api/time-entries-export?${q.toString()}`;
}

function filenameFrom(res: Response, fallback: string): string {
  const cd = res.headers?.get?.("content-disposition") ?? "";
  const m = cd.match(/filename="?([^";]+)"?/i);
  return m?.[1] ?? fallback;
}

function saveInBrowser(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser (and iOS's preview) time to take the bytes.
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves the outcome, or null when the screen went away mid-wait. A dropped
 *  connection resolves a "no connection" problem (a download is always safe
 *  to try again). */
export async function downloadPayrollFile({
  url,
  fallbackFilename,
  onSettling,
  isActive,
  fetchImpl = fetch,
  sleep = defaultSleep,
  save = saveInBrowser,
}: PayrollDownloadOptions): Promise<PayrollDownloadOutcome | null> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { cache: "no-store", credentials: "same-origin" });
    } catch {
      return {
        ok: false,
        problem: explainHoursProblem("download", { status: 0, kind: "network" }),
        unreadable: [],
      };
    }
    if (res.ok) {
      const filename = filenameFrom(res, fallbackFilename);
      save(await res.blob(), filename);
      return { ok: true, filename };
    }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const waitMs = Number(data?.retryAfterMs);
    if (
      res.status === 503 &&
      data?.code === "settling" &&
      Number.isFinite(waitMs) &&
      waitMs > 0 &&
      attempt < MAX_SETTLE_RETRIES
    ) {
      const wait = Math.min(waitMs, MAX_SETTLE_WAIT_MS);
      onSettling?.(wait);
      await sleep(wait);
      if (isActive && !isActive()) return null;
      continue;
    }
    return {
      ok: false,
      problem: explainHoursProblem("download", { status: res.status, body: data }),
      unreadable: data?.code === "unreadable" ? parseUnreadableDays(data) : [],
    };
  }
}
