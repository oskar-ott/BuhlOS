import { isOnline } from "@/domains/phil/online";

/**
 * ITP builder fetch helper. Every outcome is one of three the UI branches
 * on (handoff "Uploads" rule 4 — use the response, never a guess):
 *   ok       parsed body
 *   network  offline / fetch threw / timed out   → "Not sent", sync banner
 *   server   non-2xx                             → "Didn't save", with the message
 */
export type ItpApiResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; kind: "network" | "server"; status?: number; message: string };

const NETWORK_MESSAGE = "No signal.";

export async function itpApi<T = unknown>(
  path: string,
  init?: RequestInit & { timeoutMs?: number }
): Promise<ItpApiResult<T>> {
  if (!isOnline()) return { ok: false, kind: "network", message: NETWORK_MESSAGE };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 60000);
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers || {}) },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    return { ok: false, kind: "network", message: NETWORK_MESSAGE };
  }
  clearTimeout(timer);
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `The office returned ${res.status}.`;
    return { ok: false, kind: "server", status: res.status, message };
  }
  return { ok: true, data: body as T };
}

export function itpBase(jobId: string): string {
  return `/api/itp-simple?jobId=${encodeURIComponent(jobId)}`;
}
