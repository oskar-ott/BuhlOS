import { z } from "zod";

/**
 * Typed fetch wrapper. Parses every response through a Zod schema so the
 * caller gets a strongly-typed result instead of `unknown`.
 *
 * For Phase A this is just the thinnest possible wrapper. Domain clients
 * (src/domains/*\/client.ts) will build on top of it in Phase B+.
 */

export type HttpError = {
  status: number;
  body: unknown;
  message: string;
  /** Failure class for network-layer errors (status 0). Absent for HTTP
   *  status errors. Lets callers tell a timed-out write from a dropped one. */
  kind?: "timeout" | "network";
};

export type HttpResult<T> = { ok: true; data: T } | { ok: false; error: HttpError };

export interface HttpOptions<T> {
  /** Output-typed schema; transforms with a different input shape are fine
   *  (#383's lenient list parse) — safeParse takes unknown either way. */
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  init?: RequestInit;
  /** Opt-in bounded timeout (ms). Omitted → no timeout (unchanged behaviour).
   *  Field writes set this so a request on bad signal fails honestly instead
   *  of hanging forever (#139). Pick a budget that fits the payload — small
   *  JSON writes ~15s, large photo uploads more generous. */
  timeoutMs?: number;
}

export async function httpGet<T>(url: string, opts: HttpOptions<T>): Promise<HttpResult<T>> {
  return request(url, { ...opts, init: { ...opts.init, method: "GET" } });
}

export async function httpPost<T>(
  url: string,
  body: unknown,
  opts: HttpOptions<T>
): Promise<HttpResult<T>> {
  return request(url, {
    ...opts,
    init: {
      ...opts.init,
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(opts.init?.headers ?? {}),
      },
      body: JSON.stringify(body),
    },
  });
}

export async function httpPut<T>(
  url: string,
  body: unknown,
  opts: HttpOptions<T>
): Promise<HttpResult<T>> {
  return request(url, {
    ...opts,
    init: {
      ...opts.init,
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...(opts.init?.headers ?? {}),
      },
      body: JSON.stringify(body),
    },
  });
}

export async function httpPatch<T>(
  url: string,
  body: unknown,
  opts: HttpOptions<T>
): Promise<HttpResult<T>> {
  return request(url, {
    ...opts,
    init: {
      ...opts.init,
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(opts.init?.headers ?? {}),
      },
      body: JSON.stringify(body),
    },
  });
}

/**
 * DELETE carries no request body in this codebase — the target is named in
 * the query string (e.g. /api/plans?id=X). Mirrors httpGet's shape; only the
 * method differs.
 */
export async function httpDelete<T>(url: string, opts: HttpOptions<T>): Promise<HttpResult<T>> {
  return request(url, { ...opts, init: { ...opts.init, method: "DELETE" } });
}

/**
 * The message for a non-2xx response. Every api/*.js handler answers a
 * refusal with `{ error: "<why>" }` — that sentence is the ONLY thing that
 * tells the worker what went wrong (the day is too far back, the job is
 * closed, the entry already exists). Over HTTP/2 `res.statusText` is empty,
 * so before 2026-09-26 the field saw a bare "request failed" for every 400 /
 * 403 / 409 / 5xx. Server text first, status text second, then a plain
 * status-class fallback — never an empty string.
 */
export function httpErrorMessage(status: number, statusText: string, body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error: unknown }).error;
    if (typeof err === "string" && err.trim()) return err.trim();
  }
  if (statusText) return statusText;
  if (status >= 500) return "The office server had a problem";
  if (status === 404) return "Not found";
  if (status === 401 || status === 403) return "Not allowed";
  return "request failed";
}

async function request<T>(url: string, opts: HttpOptions<T>): Promise<HttpResult<T>> {
  let init = opts.init;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  if (opts.timeoutMs && opts.timeoutMs > 0) {
    const controller = new AbortController();
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, opts.timeoutMs);
    // Honour a caller-supplied signal too (e.g. unmount cancellation).
    const callerSignal = init?.signal;
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort();
      else callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    init = { ...init, signal: controller.signal };
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      return {
        ok: false,
        error: {
          status: 0,
          kind: "timeout",
          body: null,
          message: "That took too long and may not have sent. Check your signal and try again.",
        },
      };
    }
    return {
      ok: false,
      error: {
        status: 0,
        kind: "network",
        body: null,
        // Bounded calls are field writes (#139) — give the worker honest,
        // plain copy instead of a browser internals string ("Failed to
        // fetch"). Unbounded (admin/read) callers keep the raw message.
        message: timer
          ? "Couldn't reach the office. Try again when you've got signal."
          : err instanceof Error
            ? err.message
            : "network error",
      },
    };
  }
  if (timer) clearTimeout(timer);

  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    return {
      ok: false,
      error: {
        status: res.status,
        body,
        message: httpErrorMessage(res.status, res.statusText, body),
      },
    };
  }

  const parsed = opts.schema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        status: res.status,
        body,
        message: `response schema mismatch: ${parsed.error.message}`,
      },
    };
  }
  return { ok: true, data: parsed.data };
}
