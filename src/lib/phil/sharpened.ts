import { isFlagEnabled } from "../../../api/_lib/feature-flags.js";

/**
 * Server-side resolver for the Phil "sharpened" redesign flags.
 *
 * Pages resolve these ONCE per request (server component) and pass plain
 * booleans down to PhilShell / client components — never the flags blob
 * (docs/feature-flags.md "Using a flag"). Same precedent as the gear /
 * safety_docs / itp page gates.
 *
 *   sharpened — phil_sharpened: the global chrome (5-slot tab bar + header
 *               account avatar) and, in later waves, the screen re-skins.
 *   jobRooms  — phil_job_rooms: the #133 in-job four-rooms navigation.
 *               REQUIRES sharpened (the rooms are part of the sharpened
 *               package), so it resolves false while phil_sharpened is off
 *               even if its own flag was flipped — the dependency is enforced
 *               here, in one place.
 *
 * Both flags are dark launch-gates; flipping either is a governed change to
 * the ratified Phil package (P15 — docs/phil-governance.md §3).
 */
export interface PhilSharpenedFlags {
  sharpened: boolean;
  jobRooms: boolean;
}

/** Minimal viewer shape — matches isFlagEnabled's FlagViewer. */
type Viewer = { role?: string | null } | null | undefined;

export async function philSharpenedFlags(session: Viewer): Promise<PhilSharpenedFlags> {
  const sharpened = await isFlagEnabled("phil_sharpened", session ?? null);
  const jobRooms = sharpened && (await isFlagEnabled("phil_job_rooms", session ?? null));
  return { sharpened, jobRooms };
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
