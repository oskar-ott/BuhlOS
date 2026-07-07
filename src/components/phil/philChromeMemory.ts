"use client";

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
 * Flag-off viewers: every wired page writes `false`, so the memory never
 * warms and behaviour is byte-identical to before this module existed.
 */
export interface PhilChromeMemory {
  sharpened: boolean;
  rfiRegister: boolean;
  /** phil_job_rooms for the viewer — the job-detail loading bar uses it. */
  jobRooms: boolean;
  accountInitials: string | null;
}

const memory: PhilChromeMemory = {
  sharpened: false,
  rfiRegister: false,
  jobRooms: false,
  accountInitials: null,
};

export function readPhilChromeMemory(): Readonly<PhilChromeMemory> {
  return memory;
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
}

/** Test hook — resets the module singleton between cases. */
export function resetPhilChromeMemoryForTests(): void {
  memory.sharpened = false;
  memory.rfiRegister = false;
  memory.jobRooms = false;
  memory.accountInitials = null;
}
