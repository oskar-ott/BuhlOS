"use client";

import Link from "next/link";
import type { Route } from "next";
import type { ComponentProps, MouseEvent } from "react";
import { isOnline as defaultIsOnline } from "@/domains/phil/online";
import { decidePhilLinkNavigation } from "@/domains/phil/offline-link";
import { warmPhilPageCache } from "@/domains/phil/page-cache";

// Accept a plain string href as well as a typed Route (Next's typed-routes
// generic doesn't survive ComponentProps<typeof Link>); mirrors PhilBackLink's
// own `Route | string`. All Phil internal links are string paths.
type LinkProps = Omit<ComponentProps<typeof Link>, "href"> & { href: Route | string };

/**
 * Drop-in replacement for Next's <Link> on Phil internal navigation.
 *
 * Renders the exact same anchor (href, className, aria-* all forwarded — the
 * smoke/render specs that assert `href="/phil/..."` keep passing), but fixes
 * offline in-app navigation (#575 follow-up):
 *
 *   - OFFLINE at click → preventDefault + window.location.assign(href): a real
 *     document navigation, which /sw.js serves from the cached '-pages' entry
 *     (or the offline fallback). A plain Next soft-nav would issue an RSC fetch
 *     the SW doesn't intercept → a dead tap with no signal.
 *   - ONLINE at click → let Next soft-nav proceed (snappy), and fire-and-forget
 *     warm the destination HTML into the page cache so it's available offline
 *     next time. No RSC/API caching.
 *
 * Modified clicks (new tab / middle-click / cmd-click), non-string hrefs, and
 * non-"_self" targets are left entirely to the browser — see
 * {@link decidePhilLinkNavigation}.
 */
export function PhilOfflineLink({ href, target, onClick, ...rest }: LinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    // Preserve any caller-supplied onClick first (it may preventDefault).
    onClick?.(event);

    const action = decidePhilLinkNavigation({
      online: defaultIsOnline(),
      hrefIsString: typeof href === "string",
      modifierKey: event.metaKey || event.ctrlKey || event.shiftKey || event.altKey,
      primaryButton: event.button === 0,
      defaultPrevented: event.defaultPrevented,
      selfTarget: !target || target === "_self",
    });

    if (action === "hard-navigate") {
      event.preventDefault();
      window.location.assign(href as string);
    } else if (action === "soft-warm") {
      void warmPhilPageCache(href as string);
    }
    // "browser-default": do nothing — let Next/the browser handle it.
  }

  return <Link href={href as Route} target={target} onClick={handleClick} {...rest} />;
}
