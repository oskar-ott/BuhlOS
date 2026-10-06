/**
 * POST one pay period to accounts (api/time-entries-email.js) — the ONE send
 * path both timesheet surfaces use (phone WeeklyCloseoutSendFinale, desktop
 * SendTimesheetsCard), so they can't drift on what a refusal means.
 *
 * Rides out the one refusal that waiting is guaranteed to clear (2026-10-05,
 * owner report): days approved seconds ago can still read as their previous
 * version for up to a minute, so the server refuses the payroll read rather
 * than email a sheet short of real hours — and says when it will clear
 * (503, code 'settling', retryAfterMs). The boss approved the week, tapped
 * Send to Tia inside that minute, tapped again still inside it, and gave up;
 * the week never went. Now the surface waits the server's number and re-sends
 * by itself. A 'settling' refusal happens BEFORE anything is composed or
 * sent, so the re-send can never produce a second email.
 *
 * Every other failure is returned as-is for the screen to show. A dropped
 * connection THROWS (the caller already words "can't tell if it went").
 */

export interface PeriodSendReceipt {
  recipients: string[];
  workerCount: number;
  totalHours: number;
}

export type PeriodSendOutcome =
  | { ok: true; receipt: PeriodSendReceipt }
  | { ok: false; error: string };

/** Automatic re-sends after a 'settling' refusal before handing back to a person.
 *  With the server's 70s settle + 10s back-off this covers ~2 minutes after
 *  the last approval — twice the ~60s staleness seen in production. */
export const MAX_SETTLE_RETRIES = 3;
/** Never wait longer than this on the server's say-so. */
export const MAX_SETTLE_WAIT_MS = 120_000;

export interface SendPeriodOptions {
  fromDate: string;
  toDate: string;
  /** Called before each automatic wait, with how long it will be. */
  onSettling?: (waitMs: number) => void;
  /** False once the screen is gone — stop without sending again. */
  isActive?: () => boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Resolves the outcome, or null when the screen went away mid-wait. */
export async function sendPeriodTimesheets({
  fromDate,
  toDate,
  onSettling,
  isActive,
  fetchImpl = fetch,
  sleep = defaultSleep,
}: SendPeriodOptions): Promise<PeriodSendOutcome | null> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl("/api/time-entries-email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromDate, toDate }),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) {
      return {
        ok: true,
        receipt: {
          recipients: strings(data?.recipients),
          workerCount: Number(data?.workerCount) || 0,
          totalHours: Number(data?.totalHours) || 0,
        },
      };
    }
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
      error:
        (typeof data?.error === "string" && data.error) ||
        `The send failed (${res.status}) — nothing was emailed.`,
    };
  }
}
