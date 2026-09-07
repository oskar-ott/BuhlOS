// The Phil chrome-hint cookie — the COLD-START sibling of philChromeMemory.
//
// philChromeMemory (src/components/phil/philChromeMemory.ts) keeps flag-less
// renders (`loading.tsx` skeletons) on the last server-confirmed chrome — but
// it is a per-JS-session module singleton, so it is empty on a COLD app open.
// The installed PWA's very first paint is exactly such a render: the
// `/phil/my-day` loading skeleton streams before the page has resolved
// `phil_sharpened`, and with nothing remembered it showed the ratified
// (pre-sharpened) chrome for the whole first data wave — seconds of the OLD
// layout on a field connection, then a flip (field report 2026-08-23).
//
// The hint closes that gap: whenever a page render server-confirms the chrome
// flags, the client mirrors the baseline into this tiny cookie; the /phil
// layout reads it back on the NEXT request — cold starts included — and
// provides it as a render-time fallback (philChromeHint.tsx), so the skeleton
// SSRs the remembered chrome from the first byte.
//
// The hint is a PRESENTATION echo, never an authority:
//   * Explicit server-resolved booleans always beat it (and re-sync it).
//   * It only ever reproduces chrome the server previously confirmed for this
//     browser — it cannot turn a flag on (P7: nothing invented, P15: the
//     ratified package is untouched for viewers who never saw sharpened).
//   * Flag-off viewers NEVER carry it: an all-off baseline expires the cookie
//     (and an absent cookie is never written), so their requests and renders
//     stay byte-identical to before the hint existed.
//   * A stale hint (flag flipped off since) mis-renders at most one skeleton;
//     the page's explicit `false` corrects the chrome and expires the cookie.
//   * It is cleared at every session boundary alongside the SW page-cache
//     purge (page-cache.ts) — same shared-site-phone reasoning (#575 P1a).
//
// Value grammar (versioned by strictness — anything else parses to null):
//   s<0|1>.r<0|1>   e.g. "s1.r0"  → sharpened on, job rooms off
// `r` (phil_job_rooms) requires `s` — the parser enforces the same dependency
// as the server resolver (src/lib/phil/sharpened.ts).

export const PHIL_CHROME_COOKIE = "phil_chrome";

/** ~180 days — refreshed on every confirmed render, so an active device never
 *  expires; an abandoned one sheds the hint within two pay quarters. */
export const PHIL_CHROME_COOKIE_MAX_AGE = 60 * 60 * 24 * 180;

export interface PhilChromeHint {
  /** phil_sharpened — the 5-slot bar + white header chrome. */
  sharpened: boolean;
  /** phil_job_rooms — the in-job rooms tab-bar takeover (requires sharpened). */
  jobRooms: boolean;
}

/** Strict parse of a cookie VALUE. Absent / empty / any unknown shape → null
 *  (no hint — render today's default chrome, exactly as before the cookie). */
export function parseChromeHint(raw: string | null | undefined): PhilChromeHint | null {
  const m = /^s([01])\.r([01])$/.exec(raw ?? "");
  if (!m) return null;
  const sharpened = m[1] === "1";
  return { sharpened, jobRooms: sharpened && m[2] === "1" };
}

export function serializeChromeHint(hint: PhilChromeHint): string {
  const sharpened = hint.sharpened;
  return `s${sharpened ? 1 : 0}.r${sharpened && hint.jobRooms ? 1 : 0}`;
}

/** The hint's raw value out of a `document.cookie`-style pair list
 *  ("a=1; phil_chrome=s1.r0; b=2"), or null when absent/empty. The server
 *  side never needs this — Next's cookies() hands over values directly. */
export function chromeHintValueFromCookieHeader(
  header: string | null | undefined
): string | null {
  for (const pair of (header ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== PHIL_CHROME_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    return value === "" ? null : value;
  }
  return null;
}

// document.cookie assignment strings — built here (pure, testable) so the
// DOM-touching callers (philChromeMemory's sync, page-cache's session purge)
// stay one guarded line. Not HttpOnly by nature (the client writes it);
// SameSite=Lax; no Secure so localhost dev keeps working — the value is a
// two-bit chrome baseline, never data.
export function chromeHintSetCookie(value: string): string {
  return `${PHIL_CHROME_COOKIE}=${value}; path=/; max-age=${PHIL_CHROME_COOKIE_MAX_AGE}; samesite=lax`;
}

export const CHROME_HINT_EXPIRE_COOKIE = `${PHIL_CHROME_COOKIE}=; path=/; max-age=0; samesite=lax`;
