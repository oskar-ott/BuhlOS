"use client";

import {
  CHROME_HINT_EXPIRE_COOKIE,
  chromeHintSetCookie,
  chromeHintValueFromCookieHeader,
  parseChromeHint,
  serializeChromeHint,
} from "@/domains/phil/chrome-hint";

/**
 * Last server-confirmed sharpened-chrome state for THIS browser tab.
 *
 * Route-transition skeletons (`loading.tsx`) render PhilShell without the
 * flag props — they cannot resolve flags — so with `phil_sharpened` on,
 * every navigation used to flash the ratified (non-sharpened) chrome for as
 * long as the next page streamed. The chrome components instead fall back to
 * this memory when a flag prop is `undefined`; explicit booleans always win
 * and refresh the memory (via effects, so the memory is only ever written
 * client-side — the server-side module instance stays at its defaults and
 * SSR output is unchanged).
 *
 * Consumers must gate the fallback behind a post-mount state so the first
 * client frame matches the server HTML (no hydration mismatch); the correct
 * chrome appears one frame later instead of seconds later.
 *
 * `null` = "no server-confirmed value THIS session" — distinct from an
 * explicit false, so consumers can fall through to the cold-start chrome
 * hint below without a remembered flag-off ever being overridden by it.
 *
 * COLD STARTS (the chrome-hint cookie, src/domains/phil/chrome-hint.ts):
 * this module is a per-JS-session singleton, so the installed PWA's first
 * skeleton used to render the ratified chrome for the whole first data wave
 * (field report 2026-08-23 — "the app loads up showing the old layout").
 * Every confirming write here therefore mirrors the baseline into the tiny
 * `phil_chrome` cookie; the /phil layout reads it back NEXT request and
 * provides it render-time via PhilChromeHintProvider (philChromeHint.tsx),
 * so cold-start skeletons SSR the remembered chrome from the first byte.
 * Consumer precedence: explicit prop → this memory (post-mount) → the hint
 * → today's default.
 *
 * Flag-off viewers: every wired page writes `false`, the memory never warms,
 * and the cookie sync below never writes (an all-off baseline only ever
 * EXPIRES an existing cookie) — behaviour and request bytes stay identical
 * to before this module existed.
 */
export interface PhilChromeMemory {
  sharpened: boolean | null;
  rfiRegister: boolean | null;
  /** phil_job_rooms for the viewer — the job-detail loading bar uses it. */
  jobRooms: boolean | null;
  accountInitials: string | null;
}

const memory: PhilChromeMemory = {
  sharpened: null,
  rfiRegister: null,
  jobRooms: null,
  accountInitials: null,
};

export function readPhilChromeMemory(): Readonly<PhilChromeMemory> {
  return memory;
}

/**
 * Mirror the confirmed baseline into the chrome-hint cookie (see
 * chrome-hint.ts for the full contract). Runs after every remember; cheap
 * (string compare against the current cookie) and write-only-on-change:
 *   * nothing confirmed yet this session → never touch the cookie, so the
 *     hint survives flag-less pages (/phil/leave, /v2/phil);
 *   * sharpened confirmed OFF → expire the cookie IF one exists (flag-off
 *     viewers with no cookie never see a write);
 *   * sharpened confirmed ON → set `s1.r{0|1}`; an unconfirmed jobRooms
 *     inherits the current cookie's bit rather than downgrading it.
 */
function syncChromeHintCookie(): void {
  if (typeof document === "undefined") return;
  if (memory.sharpened === null) return;
  try {
    const current = chromeHintValueFromCookieHeader(document.cookie);
    const target = memory.sharpened
      ? serializeChromeHint({
          sharpened: true,
          jobRooms: memory.jobRooms ?? parseChromeHint(current)?.jobRooms ?? false,
        })
      : null;
    if (target === current) return;
    document.cookie = target === null ? CHROME_HINT_EXPIRE_COOKIE : chromeHintSetCookie(target);
  } catch {
    // Best-effort — the hint is an optimisation; a blocked cookie store must
    // never break the chrome render (the memory fallback still works).
  }
}

/** Merge the defined keys of `patch` into the memory (undefined = no-op). */
export function rememberPhilChrome(patch: {
  [K in keyof PhilChromeMemory]?: PhilChromeMemory[K] | undefined;
}): void {
  (Object.keys(patch) as Array<keyof PhilChromeMemory>).forEach((key) => {
    const value = patch[key];
    if (value !== undefined) {
      (memory as unknown as Record<string, unknown>)[key] = value;
    }
  });
  syncChromeHintCookie();
}

/** Test hook — resets the module singleton between cases. */
export function resetPhilChromeMemoryForTests(): void {
  memory.sharpened = null;
  memory.rfiRegister = null;
  memory.jobRooms = null;
  memory.accountInitials = null;
}
