// Offline-aware navigation decision for Phil internal links (#575 follow-up).
//
// The service worker's offline read cache only serves pages for real document
// navigations (`request.mode === 'navigate'`). A Next.js <Link> tap does a
// client-side App Router/RSC navigation — NOT a document request — so offline it
// neither hits the SW page cache nor falls back: a dead tap. (Found while
// validating #597: reload/history worked offline, but tapping My Day → Jobs →
// Job did not.)
//
// PhilOfflineLink uses this pure decision at click time:
//   * offline → force a real document navigation (window.location.assign), so
//     /sw.js serves the cached /phil/* page (or the offline fallback);
//   * online  → behave like a normal <Link> (snappy soft-nav) AND warm the
//     destination document into the page cache so it's there for next time.
// We deliberately do NOT cache RSC/flight or API responses — that would grow the
// stale-data surface and fight the #575 "no API/data cache" safety model.

export interface PhilLinkClick {
  /** navigator-reported connectivity at click time. */
  online: boolean;
  /** the href is a plain string path (object hrefs fall back to the browser). */
  hrefIsString: boolean;
  /** a modifier key was held (meta/ctrl/shift/alt) → let the browser handle it. */
  modifierKey: boolean;
  /** left/primary mouse button (button === 0). */
  primaryButton: boolean;
  /** another handler already called preventDefault. */
  defaultPrevented: boolean;
  /** target is absent or "_self" (anything else opens elsewhere → leave it). */
  selfTarget: boolean;
}

export type PhilLinkAction =
  // leave it entirely to the browser / Next <Link> (new-tab, modified, object href…)
  | "browser-default"
  // offline: preventDefault + window.location.assign(href) → document navigation
  | "hard-navigate"
  // online: let Next soft-nav proceed, and warm the destination into the cache
  | "soft-warm";

/**
 * Decide how a Phil internal link click should be handled. Pure and exhaustive
 * so it unit-tests without a DOM. Only a plain, primary-button, same-tab click
 * of a string href is ever intercepted; everything else is the browser's.
 */
export function decidePhilLinkNavigation(c: PhilLinkClick): PhilLinkAction {
  if (
    c.defaultPrevented ||
    c.modifierKey ||
    !c.primaryButton ||
    !c.selfTarget ||
    !c.hrefIsString
  ) {
    return "browser-default";
  }
  return c.online ? "soft-warm" : "hard-navigate";
}
