// Shared client for Phil field writes (#139).
//
// One DEFINITE outcome per write under bad signal. A field worker on one bar
// must never be left with an infinite spinner or a request that quietly died:
//   * a bounded timeout (no hang) — aborts and reports honestly
//   * an explicit error taxonomy the UI can branch on
//   * success only on a real, parsed server confirmation
//
// This is the honest, NO-QUEUE baseline (constitution P8): writes are
// network-only and a failure is surfaced for one-tap retry — nothing is
// silently held or pretended-saved. A durable offline outbox is later work
// (#158/#498/#143/#499) and will build on top of this, not replace its
// honesty contract. Server-side replay safety (idempotency) is #497 — until
// that lands, a retry after a timeout *could* double-write, so callers retry
// only on errors where no server write is possible (offline/timeout-before-
// send) or where the endpoint is already idempotent; that gap is tracked in
// #497 and must not be hidden behind an optimistic UI.

import { isOnline as defaultIsOnline } from "./online";

export const PHIL_WRITE_TIMEOUT_MS = 15000;

export type PhilWriteError =
  // device reports no network before we even send — definitely not sent
  | { kind: "offline"; message: string }
  // aborted after the timeout budget — may or may not have reached the server
  | { kind: "timeout"; message: string }
  // fetch threw (connection dropped mid-flight)
  | { kind: "network"; message: string }
  // caller cancelled (e.g. component unmounted) — not shown to the user
  | { kind: "cancelled"; message: string }
  // server responded with a non-2xx status
  | { kind: "http"; status: number; message: string }
  // 2xx but the body was unreadable or failed the caller's parse
  | { kind: "parse"; message: string };

export type PhilWriteResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: PhilWriteError };

export interface PhilWriteOptions {
  /** Timeout budget in ms (default 15s). */
  timeoutMs?: number;
  /** Caller cancellation (e.g. AbortController on unmount). */
  signal?: AbortSignal;
  /** Injectable for tests; defaults to navigator-based detection. */
  isOnline?: () => boolean;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

// Worker-voice copy — plain, honest, no jargon (P11).
const MESSAGES = {
  offline: "You're offline — this wasn't sent. Try again when you've got signal.",
  timeout: "That took too long and may not have sent. Check your signal and try again.",
  network: "Couldn't reach the office. Try again when you've got signal.",
  parse: "Saved, but the app couldn't read the reply — refresh to check.",
};

/**
 * POST `body` as JSON to `url` with a bounded timeout, returning a tagged
 * result. `parse` turns the raw JSON reply into the typed value (return null
 * to reject an unexpected shape — surfaced as a `parse` error). No throw:
 * every failure mode is a typed `PhilWriteResult` the caller branches on.
 */
export async function philWrite<T>(
  url: string,
  body: unknown,
  parse: (raw: unknown) => T | null,
  options: PhilWriteOptions = {}
): Promise<PhilWriteResult<T>> {
  const timeoutMs = options.timeoutMs ?? PHIL_WRITE_TIMEOUT_MS;
  const isOnline = options.isOnline ?? defaultIsOnline;
  const doFetch = options.fetchImpl ?? fetch;

  if (options.signal?.aborted) {
    return { ok: false, error: { kind: "cancelled", message: "" } };
  }
  if (!isOnline()) {
    return { ok: false, error: { kind: "offline", message: MESSAGES.offline } };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onCallerAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    if (timedOut) {
      return { ok: false, error: { kind: "timeout", message: MESSAGES.timeout } };
    }
    if (options.signal?.aborted) {
      return { ok: false, error: { kind: "cancelled", message: "" } };
    }
    return { ok: false, error: { kind: "network", message: MESSAGES.network } };
  }
  clearTimeout(timer);
  options.signal?.removeEventListener("abort", onCallerAbort);

  if (!res.ok) {
    let message = `Couldn't save that — the office returned ${res.status}. Try again.`;
    try {
      const errBody = (await res.json()) as unknown;
      if (errBody && typeof errBody === "object" && typeof (errBody as { error?: unknown }).error === "string") {
        message = (errBody as { error: string }).error;
      }
    } catch {
      // keep the default message
    }
    return { ok: false, error: { kind: "http", status: res.status, message } };
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    return { ok: false, error: { kind: "parse", message: MESSAGES.parse } };
  }
  const data = parse(raw);
  if (data === null) {
    return { ok: false, error: { kind: "parse", message: MESSAGES.parse } };
  }
  return { ok: true, data };
}
