"use client";

import { useEffect, useRef } from "react";
import type { Route } from "next";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  readRememberedFilters,
  rememberedFilterQuery,
  type RememberedFilterSpec,
} from "./remembered-filters";

/**
 * Apply a list's remembered per-device filter default — issue #216.
 *
 * Hydration-safe by construction: storage is read inside a mount effect
 * (never during render), and the only way the remembered set reaches the
 * screen is a router.replace that round-trips through the URL — so the
 * server and client never render from different filter inputs. On /hours
 * (server-filtered) the replace re-renders the page with the filters; on
 * /v2/jobs it just updates useSearchParams for the client-side filter.
 *
 * The ref guard makes the replace once-per-mount (never a loop: after the
 * replace the URL carries filter params, so rememberedFilterQuery returns
 * null on any later pass anyway — the guard is belt-and-braces against
 * double-firing while the navigation is in flight).
 *
 * URL precedence: if the current URL already has any of the list's own
 * filter params (a shared link, a deep link from another surface), nothing
 * is applied and — because write-through only happens in interaction
 * handlers — nothing is overwritten in storage either.
 *
 * `spec` must be a module-level constant at the call site (stable identity).
 */
export function useApplyRememberedFiltersOnce(
  storageKey: string,
  spec: RememberedFilterSpec
): void {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current) return;
    applied.current = true;
    const stored = readRememberedFilters(storageKey, spec);
    const query = rememberedFilterQuery(
      new URLSearchParams(searchParams.toString()),
      Object.keys(spec),
      stored
    );
    if (query !== null) {
      // `as Route` — the target is the current pathname with a query string;
      // typedRoutes can't narrow a runtime-composed href (same pattern as
      // the AdminSidebar / hours page casts).
      router.replace(`${pathname}?${query}` as Route, { scroll: false });
    }
  }, [router, pathname, searchParams, storageKey, spec]);
}
