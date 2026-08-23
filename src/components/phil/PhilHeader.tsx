"use client";

import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { PhilOfflineLink } from "./PhilOfflineLink";
import { usePhilChromeHint } from "./philChromeHint";
import { readPhilChromeMemory, rememberPhilChrome } from "./philChromeMemory";

interface PhilHeaderProps {
  title: string;
  /**
   * phil_sharpened (dark): show the account avatar button top-right —
   * account moves off the tab bar ("More" leaves) and onto the header, per
   * the sharpened nav (§1: "Account lives on the header avatar, not a tab").
   * An explicit boolean (server-resolved) always wins and refreshes the
   * chrome memory; `undefined` (a flag-less render such as a `loading.tsx`
   * skeleton) falls back to the memory POST-MOUNT, then to the request's
   * chrome hint (the /phil layout's cookie read — philChromeHint.tsx), which
   * IS available during SSR — so navigations AND cold app opens keep the
   * remembered chrome instead of flashing the ratified header.
   * False = the ratified header, byte-identical.
   */
  sharpened?: boolean;
  /**
   * The signed-in worker's initials for the avatar (e.g. "SP"). Explicit
   * values (including a resolved null — the legacy session cookie carries no
   * name) win and refresh memory; `undefined` consults the memory post-mount.
   * Null shows a person glyph instead (honest fallback, never fabricated
   * initials).
   */
  accountInitials?: string | null;
}

/**
 * Phil top app bar — slim navy chrome with the page title and the brand
 * accent dot. Stays put while `<main>` scrolls (it's a flex sibling of the
 * scroll container), so it reads as a fixed app bar.
 *
 * Refinements over the flat original: a top safe-area inset so the bar
 * clears a notch / status bar, a subtle elevation so it sits above the
 * grey content surface, and tighter title typography.
 */
export function PhilHeader({ title, sharpened, accountInitials }: PhilHeaderProps) {
  // Mounted gate (see philChromeMemory.ts): the memory fallback applies only
  // after mount so the first client frame matches the server HTML exactly —
  // no hydration mismatch. The chrome HINT below it is request-scoped and
  // identical on both passes, so it MAY drive SSR: a cold-start skeleton
  // paints the remembered chrome from the first byte (philChromeHint.tsx).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Explicit props refresh the memory; undefined keys are no-ops by design.
  useEffect(() => {
    rememberPhilChrome({ sharpened, accountInitials });
  }, [sharpened, accountInitials]);
  const memory = readPhilChromeMemory();
  const hint = usePhilChromeHint();
  // Explicit prop → session memory (post-mount; null until server-confirmed)
  // → the request's cookie hint → the ratified default.
  const effectiveSharpened =
    sharpened ?? (mounted ? memory.sharpened : null) ?? hint?.sharpened ?? false;
  const effectiveInitials =
    accountInitials !== undefined
      ? accountInitials
      : mounted
        ? memory.accountInitials
        : null;
  if (effectiveSharpened) {
    // Sharpened app header (§1): WHITE card chrome — ink title with the small
    // yellow Phil dot beside it, hairline bottom border, and the 44px account
    // avatar as a navy circle (white initials / person glyph) reading
    // navy-on-white. Same safe-area inset and testids as the ratified header;
    // flag off renders the navy bar below, byte-identical.
    return (
      <header className="shrink-0 border-b border-border bg-surface-raised text-text pt-[env(safe-area-inset-top)]">
        <div className="flex h-12 items-center justify-between gap-2 px-4">
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <p
              className="min-w-0 truncate font-display text-[15px] font-bold tracking-tight text-text"
              title={title}
            >
              {title}
            </p>
            {/* The Phil dot — beside the title on the white bar. */}
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-pill bg-accent-yellow"
              title="BuhlOS"
            />
          </span>
          {/* Account entry (§1): a 44px round avatar linking to the /v2/phil
              account/More screen — the slot "More" vacated on the tab bar.
              Initials when the page resolved a name; a person glyph
              otherwise (honest fallback, never fabricated initials). */}
          <PhilOfflineLink
            href="/v2/phil"
            aria-label="Account"
            data-testid="phil-header-account"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand-navy transition active:scale-95"
          >
            {effectiveInitials ? (
              <span className="text-[12px] font-semibold uppercase tracking-wider text-white">
                {effectiveInitials}
              </span>
            ) : (
              <User aria-hidden="true" className="h-5 w-5 text-white" />
            )}
          </PhilOfflineLink>
        </div>
      </header>
    );
  }
  return (
    <header className="shrink-0 bg-brand-navy text-text-inverse shadow-card pt-[env(safe-area-inset-top)]">
      <div className="flex h-12 items-center justify-between gap-2 px-4">
        <p
          className="min-w-0 flex-1 truncate font-display text-[15px] font-semibold tracking-tight"
          title={title}
        >
          {title}
        </p>
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-pill bg-accent-yellow"
          title="BuhlOS"
        />
      </div>
    </header>
  );
}
