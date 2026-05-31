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
};

export type HttpResult<T> = { ok: true; data: T } | { ok: false; error: HttpError };

export interface HttpOptions<T> {
  schema: z.ZodSchema<T>;
  init?: RequestInit;
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

async function request<T>(url: string, opts: HttpOptions<T>): Promise<HttpResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, opts.init);
  } catch (err) {
    return {
      ok: false,
      error: {
        status: 0,
        body: null,
        message: err instanceof Error ? err.message : "network error",
      },
    };
  }

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
      error: { status: res.status, body, message: res.statusText || "request failed" },
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
