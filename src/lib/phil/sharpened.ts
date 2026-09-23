import { isFlagEnabled } from "../../../api/_lib/feature-flags.js";

/**
 * Server-side resolver for the Phil "sharpened" redesign flags.
 *
 * Pages resolve these ONCE per request (server component) and pass plain
 * booleans down to PhilShell / client components — never the flags blob
 * (docs/feature-flags.md "Using a flag"). Same precedent as the gear page
 * gate.
 *
 *   sharpened   — phil_sharpened: the global chrome (5-slot tab bar + header
 *                 account avatar) and, in later waves, the screen re-skins.
 *   jobRooms    — phil_job_rooms: the #133 in-job four-rooms navigation.
 *                 REQUIRES sharpened (the rooms are part of the sharpened
 *                 package), so it resolves false while phil_sharpened is off
 *                 even if its own flag was flipped — the dependency is
 *                 enforced here, in one place.
 *
 * The phil_* flags are dark launch-gates; flipping either is a governed
 * change to the ratified Phil package (P15 — docs/phil-governance.md §3).
 *
 * jobRooms currently ALWAYS resolves false (2026-09-23 usability audit): the
 * four-rooms view that registers the in-job bar left with #916 (lean reset
 * step 5), but phil_job_rooms stayed ON in production, so every job screen
 * rendered Now · Work · Proof · Site as the pending stand-in — four buttons
 * that did nothing, with Today / Jobs / Hours / Gear gone (P9, P12). With no
 * view to drive, the honest resolution is "rooms off": the job screen keeps
 * the global sharpened bar. Restore the flag read here together with the
 * rooms view (git history of PhilJobRoomsView) — never one without the other.
 */
export interface PhilSharpenedFlags {
  sharpened: boolean;
  jobRooms: boolean;
}

/** Minimal viewer shape — matches isFlagEnabled's FlagViewer. */
type Viewer = { role?: string | null } | null | undefined;

export async function philSharpenedFlags(session: Viewer): Promise<PhilSharpenedFlags> {
  const sharpened = await isFlagEnabled("phil_sharpened", session ?? null);
  // No rooms view exists to register the in-job bar (see header), so the flag
  // is not consulted — a room bar here would be dead controls.
  return { sharpened, jobRooms: false };
}

/**
 * Worker initials for the sharpened header avatar — derived from a REAL
 * display name only ("Sam Payne" → "SP", "sam" → "S"). Null when no name is
 * known (the legacy session cookie carries none), so the avatar falls back
 * to a person glyph rather than fabricated letters (P7).
 */
export function philInitials(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]!.toUpperCase());
  return letters.length > 0 ? letters.join("") : null;
}

/**
 * "On site since {t}" display time for the sharpened My Day subline — from
 * TODAY'S real time entry startTime ("06:58" → "6:58"). This is the only
 * on-site signal the page already loads (no extra API call); when today has
 * no entry or the entry has no start time, returns null and the subline
 * honestly omits the clause (P7 — never an invented clock-on).
 */
export function philOnSiteSince(startTime: string | null | undefined): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(startTime?.trim() ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const mins = Number(m[2]);
  if (h > 23 || mins > 59) return null;
  return `${h}:${m[2]}`;
}
