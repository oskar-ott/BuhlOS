import { z } from "zod";

/**
 * Session helper that mirrors api/_lib/auth.js without duplicating its HMAC
 * code. Phase A talks to the existing /api/auth?action=me endpoint to
 * resolve the current session; middleware and server components both call
 * `readSessionFromCookie()` to get a parsed payload (or null).
 *
 * The cookie name `buhl_session` is the legacy cookie — the new app
 * intentionally shares it so users stay logged in across the cutover.
 *
 * Cross-ref: api/_lib/auth.js (DO NOT EDIT in Phase A)
 */

export const SESSION_COOKIE = "buhl_session";

const SessionPayloadSchema = z.object({
  // Legacy api/_lib/auth.js signs payloads as `{ userId, role, exp }`; the
  // JWT-style `sub` field is provided for future compatibility but is not
  // emitted by the legacy login today.
  sub: z.string().optional(),
  userId: z.string().optional(),
  email: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  /** "What you go by" nickname — greeting-only (owner-directed 2026-08-09);
   *  `name` is the real full name everywhere else. */
  preferredName: z.string().nullable().optional(),
  username: z.string().optional(),
  exp: z.number().optional(),
});

export type SessionPayload = z.infer<typeof SessionPayloadSchema>;

/**
 * Decode and shape-check a session cookie value. Does NOT verify the
 * HMAC — that's the responsibility of the legacy api/_lib/auth.js verifier
 * (reachable via /api/auth?action=me). Use `verifyViaApi()` when authority
 * matters.
 *
 * Returns null if the cookie is missing, malformed, or expired by its
 * embedded `exp` field.
 */
export function decodeSessionCookie(value: string | undefined): SessionPayload | null {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const body = value.slice(0, dot);
  try {
    const json = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const parsed = SessionPayloadSchema.safeParse(json);
    if (!parsed.success) return null;
    if (parsed.data.exp && parsed.data.exp < Date.now()) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Authoritative session check via the legacy /api/auth?action=me endpoint.
 * Used when the server actually needs to trust the cookie (e.g. mutations).
 */
/**
 * Shape-gate a user object resolved IN-PROCESS (api/_lib/auth.js
 * getCurrentUser via api/_lib/phil-page-data.js) into the same payload
 * verifyViaApi returns — so a page can swap the HTTP `/api/auth?action=me`
 * hop for the in-process read without changing what it trusts or renders.
 * Pure zod; safe to live here even though middleware also imports this file.
 */
export function parseSessionUser(user: unknown): SessionPayload | null {
  const parsed = MeResponseSchema.safeParse({ user });
  return parsed.success && parsed.data.user ? parsed.data.user : null;
}

const MeResponseSchema = z.object({
  user: z
    .object({
      email: z.string().optional(),
      role: z.string().optional(),
      name: z.string().optional(),
      // Greeting-only nickname (owner-directed 2026-08-09) — `name` carries
      // the real full name for every other surface.
      preferredName: z.string().nullable().optional(),
      // users.json usernames double as display names across the app (the
      // hours pipeline stamps them onto entries; the employees bridge splits
      // them into first/last) — surfaced here so greetings can use them too.
      username: z.string().optional(),
    })
    .nullable()
    .optional(),
});

export async function verifyViaApi(
  cookieHeader: string,
  baseUrl: string
): Promise<SessionPayload | null> {
  try {
    const res = await fetch(`${baseUrl}/api/auth?action=me`, {
      headers: { cookie: cookieHeader },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = await res.json();
    const parsed = MeResponseSchema.safeParse(body);
    if (!parsed.success || !parsed.data.user) return null;
    return parsed.data.user;
  } catch {
    return null;
  }
}
