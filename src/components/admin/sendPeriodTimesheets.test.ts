import { describe, expect, it, vi } from "vitest";
import {
  MAX_SETTLE_RETRIES,
  MAX_SETTLE_WAIT_MS,
  sendPeriodTimesheets,
} from "./sendPeriodTimesheets";

/**
 * The one send path both timesheet surfaces use. 2026-10-05: the boss
 * approved the week, tapped Send to Tia inside the minute just-approved days
 * take to read back, got refused twice, and the week never reached accounts.
 * A 'settling' refusal now waits the server's number and re-sends by itself;
 * every other answer is handed back unchanged.
 */

type Reply = { status: number; body: unknown };

function fetchSequence(replies: Reply[]) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const impl = vi.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const SENT: Reply = {
  status: 200,
  body: { sent: true, recipients: ["tia@x.com"], workerCount: 10, totalHours: 412.4 },
};
const settling = (retryAfterMs: number): Reply => ({
  status: 503,
  body: {
    error: "payroll read refused — 1 day record(s) could not be read consistently: …",
    code: "settling",
    retryAfterMs,
  },
});

const PERIOD = { fromDate: "2026-09-28", toDate: "2026-10-04" };

describe("sendPeriodTimesheets", () => {
  it("sends the explicit period and returns the server's receipt", async () => {
    const { impl, calls } = fetchSequence([SENT]);
    const out = await sendPeriodTimesheets({ ...PERIOD, fetchImpl: impl });
    expect(out).toEqual({
      ok: true,
      receipt: { recipients: ["tia@x.com"], workerCount: 10, totalHours: 412.4 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("/api/time-entries-email");
    expect(calls[0]!.body).toEqual(PERIOD);
  });

  it("the 2026-10-05 case: a 'settling' refusal waits the server's number, says so, then re-sends and lands", async () => {
    const { impl, calls } = fetchSequence([settling(55_000), SENT]);
    const sleep = vi.fn(async () => {});
    const onSettling = vi.fn();
    const out = await sendPeriodTimesheets({ ...PERIOD, fetchImpl: impl, sleep, onSettling });
    expect(out?.ok).toBe(true);
    expect(onSettling).toHaveBeenCalledWith(55_000);
    expect(sleep).toHaveBeenCalledWith(55_000);
    expect(calls).toHaveLength(2);
  });

  it("gives up after a bounded number of automatic re-sends and shows the server's words", async () => {
    const { impl, calls } = fetchSequence([settling(5_000)]);
    const out = await sendPeriodTimesheets({ ...PERIOD, fetchImpl: impl, sleep: async () => {} });
    expect(out).toEqual({ ok: false, error: expect.stringContaining("payroll read refused") });
    expect(calls).toHaveLength(MAX_SETTLE_RETRIES + 1);
  });

  it("never waits longer than the cap, whatever the server says", async () => {
    const { impl } = fetchSequence([settling(10 * 60_000), SENT]);
    const sleep = vi.fn(async () => {});
    await sendPeriodTimesheets({ ...PERIOD, fetchImpl: impl, sleep });
    expect(sleep).toHaveBeenCalledWith(MAX_SETTLE_WAIT_MS);
  });

  it("any other refusal is handed straight back — no automatic re-send", async () => {
    for (const reply of [
      {
        status: 503,
        body: { error: "payroll read refused — … (unreadable). wait a minute and retry." },
      },
      { status: 503, body: { error: "No recipients yet", code: "not_configured" } },
      { status: 422, body: { error: "No approved hours in this period — nothing was sent." } },
      {
        status: 502,
        body: { error: "The email provider refused the send", code: "provider_error" },
      },
    ]) {
      const { impl, calls } = fetchSequence([reply]);
      const sleep = vi.fn(async () => {});
      const out = await sendPeriodTimesheets({ ...PERIOD, fetchImpl: impl, sleep });
      expect(out).toEqual({ ok: false, error: (reply.body as { error: string }).error });
      expect(calls).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  });

  it("a body-less failure still says nothing was emailed", async () => {
    const { impl } = fetchSequence([{ status: 500, body: null }]);
    const out = await sendPeriodTimesheets({ ...PERIOD, fetchImpl: impl });
    expect(out).toEqual({ ok: false, error: "The send failed (500) — nothing was emailed." });
  });

  it("stops without re-sending when the screen went away during the wait", async () => {
    const { impl, calls } = fetchSequence([settling(55_000), SENT]);
    let active = true;
    const out = await sendPeriodTimesheets({
      ...PERIOD,
      fetchImpl: impl,
      sleep: async () => {
        active = false;
      },
      isActive: () => active,
    });
    expect(out).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("a dropped connection throws for the caller to word — never reported as 'not sent'", async () => {
    const impl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    await expect(sendPeriodTimesheets({ ...PERIOD, fetchImpl: impl })).rejects.toBeInstanceOf(
      TypeError
    );
  });
});
