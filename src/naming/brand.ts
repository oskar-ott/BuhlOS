// Product brand names — the single place user-visible app names come from.
//
// This version ships as ONE brand: every surface presents as **BuhlOS**.
// "Phil" is reserved as a possible future field-app brand for other
// businesses; code identifiers, routes (/phil/*) and internal docs keep the
// phil name so a future re-brand is a copy flip here, not a route migration.
// Field URLs are sacred (installed PWAs / bookmarks) — never rename them.
//
// api/_lib/brand.js is the CommonJS mirror for the legacy API layer (emails);
// deprecated-naming.test.ts asserts the two stay in sync.

/** User-visible name of the field (mobile) surface. */
export const FIELD_APP_NAME = "BuhlOS";

/** User-visible name of the office (admin) surface. */
export const OFFICE_APP_NAME = "BuhlOS";

/**
 * How admin copy refers to the field surface generically when it needs to
 * distinguish it from the office ("visible in the field app", "raise edits
 * in the field app") — lowercase, mid-sentence.
 */
export const FIELD_SURFACE_PHRASE = "the field app";
