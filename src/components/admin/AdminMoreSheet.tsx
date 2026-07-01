"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { Settings } from "lucide-react";
import { cn } from "@/lib/cn";
import { Drawer } from "@/components/ui/Drawer";
import { SignOutButton } from "./SignOutButton";
// One nav source (./nav.ts) — the sidebar, the ⌘K palette AND this "More"
// sheet render the same destinations, so they can never drift. #760: the same
// hiddenHrefs (owner-disabled features) filter this mobile IA too.
import { visibleNavGroups, activeHref } from "./nav";

/**
 * The mobile admin "More" sheet — the full office IA behind the bottom tab
 * bar's `More` tab.
 *
 * The bottom tab bar (AdminMobileTabBar) surfaces the four highest-traffic
 * destinations; everything else in the office IA — plus Notification settings
 * and the ONLY mobile sign-out path — lives here. It replaces the old
 * AdminTopbar hamburger drawer (same `NAV_GROUPS` body, same `logout-mobile`
 * sign-out testid) so the calm bottom tab bar is the single mobile nav and the
 * full IA is one tap away.
 *
 * Controlled by the tab bar (open / onClose) and rendered inside the shared
 * Drawer (focus-trap + Escape + backdrop close). Desktop never sees it — the
 * tab bar that owns it is `md:hidden`.
 */
export function AdminMoreSheet({
  open,
  onClose,
  hiddenHrefs,
}: {
  open: boolean;
  onClose: () => void;
  hiddenHrefs?: ReadonlyArray<string>;
}) {
  const pathname = usePathname() ?? "";
  const active = activeHref(pathname);
  const settingsActive = pathname.startsWith("/settings");
  const groups = visibleNavGroups(hiddenHrefs);

  return (
    <Drawer open={open} onClose={onClose} title="BuhlOS" subtitle="Menu">
      <nav aria-label="BuhlOS admin">
        {groups.map((group) => (
          <div key={group.heading} className="mb-3">
            <p className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-widest text-text-muted">
              {group.heading}
            </p>
            <ul className="space-y-1">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = item.href === active;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onClose}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex min-h-[44px] items-center gap-3 rounded-card border-l-2 px-3 py-2 text-sm",
                        isActive
                          ? "border-l-accent-yellow bg-surface-subtle font-semibold text-text"
                          : "border-l-transparent text-text hover:bg-surface-subtle",
                      )}
                    >
                      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

        {/* Footer parity with the sidebar — settings isn't a daily destination
            but must still be reachable on a phone (#218), and sign-out MUST be:
            the sidebar (which carries it) is desktop-only, so without this the
            mobile admin had no way to sign out at all. #222 points this at the
            /settings hub (which links on to notification prefs + task rules). */}
        <div className="mt-2 space-y-1 border-t border-border pt-2">
          <Link
            href={"/settings" as Route}
            onClick={onClose}
            aria-current={settingsActive ? "page" : undefined}
            className={cn(
              "flex min-h-[44px] items-center gap-3 rounded-card px-3 py-2 text-sm",
              settingsActive
                ? "bg-surface-subtle font-semibold text-text"
                : "text-text-muted hover:bg-surface-subtle hover:text-text",
            )}
          >
            <Settings aria-hidden="true" className="h-4 w-4" />
            <span className="flex-1 truncate">Settings</span>
          </Link>
          <SignOutButton
            testId="logout-mobile"
            className="flex min-h-[44px] w-full items-center gap-3 rounded-card px-3 py-2 text-sm text-text-muted hover:bg-surface-subtle hover:text-text disabled:opacity-60"
          />
        </div>
      </nav>
    </Drawer>
  );
}
