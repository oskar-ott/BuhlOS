import { cookies, headers } from "next/headers";
import { decodeSessionCookie, SESSION_COOKIE, type SessionPayload } from "./session";

/**
 * Returns the current session as decoded from the cookie, or null.
 *
 * This is the function pages and layouts should call when they need to
 * know who the user is. It is shape-checked but NOT HMAC-verified;
 * pages use this for routing/redirect decisions, not authorisation
 * of mutations. Mutations always re-verify server-side via api/_lib/auth.js.
 */
export async function getCurrentUser(): Promise<SessionPayload | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  return decodeSessionCookie(raw);
}

/**
 * Pulls the host from the incoming request so server components can
 * construct absolute URLs back to /api/* on the same origin.
 */
export async function originFromRequest(): Promise<string> {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  if (!host) return "http://localhost:3000";
  return `${proto}://${host}`;
}
