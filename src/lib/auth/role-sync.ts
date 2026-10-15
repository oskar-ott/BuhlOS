import { normaliseRole } from "./roles";

/**
 * Role-change sync (2026-10-15).
 *
 * The session cookie carries the role the person signed in with and lasts 30
 * days; the page gates route by it. After the office changes someone's role
 * (/employees → Change role) the landing pages — Phil My Day and the Command
 * centre — see the LIVE users.json role on their normal load and, when it no
 * longer matches the cookie, send the browser to ROLE_SYNC_PATH once
 * (api/auth.js ?action=refresh), which re-signs the session with the live
 * role and routes to the right home. Without it, an electrician made project
 * manager kept the field app (no job hours, no materials) until they happened
 * to sign out.
 */
export const ROLE_SYNC_PATH = "/api/auth?action=refresh";

/**
 * True when the live login role differs from the cookie's role and the
 * browser hasn't just come back from a sync (`synced`). A missing live role
 * (failed lookup) is never treated as a change.
 */
export function needsRoleSync(cookieRole: unknown, liveRole: unknown, synced: boolean): boolean {
  if (synced) return false;
  const live = normaliseRole(liveRole);
  if (!live) return false;
  return normaliseRole(cookieRole) !== live;
}
