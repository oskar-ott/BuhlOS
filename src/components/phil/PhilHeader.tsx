import { User } from "lucide-react";
import { PhilOfflineLink } from "./PhilOfflineLink";

interface PhilHeaderProps {
  title: string;
  /**
   * phil_sharpened (dark): show the account avatar button top-right —
   * account moves off the tab bar ("More" leaves) and onto the header, per
   * the sharpened nav (§1: "Account lives on the header avatar, not a tab").
   * False/absent = the ratified header, byte-identical.
   */
  sharpened?: boolean;
  /**
   * The signed-in worker's initials for the avatar (e.g. "SP"). Optional —
   * the legacy session cookie carries no name, so pages that don't resolve a
   * profile pass nothing and the avatar shows a person glyph instead (honest
   * fallback, never fabricated initials).
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
export function PhilHeader({ title, sharpened = false, accountInitials }: PhilHeaderProps) {
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
          title="Phil"
        />
        {sharpened ? (
          // Account entry (sharpened §1): a 44px round avatar linking to the
          // /v2/phil account/More screen — the slot "More" vacated on the tab
          // bar. Initials when the page resolved a name; a person glyph
          // otherwise. White ring so the navy circle reads on the navy bar
          // (this header is re-skinned in a later wave).
          <PhilOfflineLink
            href="/v2/phil"
            aria-label="Account"
            data-testid="phil-header-account"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/30 bg-brand-navy transition active:scale-95"
          >
            {accountInitials ? (
              <span className="text-[12px] font-semibold uppercase tracking-wider text-white">
                {accountInitials}
              </span>
            ) : (
              <User aria-hidden="true" className="h-5 w-5 text-white" />
            )}
          </PhilOfflineLink>
        ) : null}
      </div>
    </header>
  );
}
