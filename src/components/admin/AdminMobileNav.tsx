"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { Menu, Bell } from "lucide-react";
import { cn } from "@/lib/cn";
import { Drawer } from "@/components/ui/Drawer";
// One nav source (./nav.ts) — the sidebar, the ⌘K palette AND this mobile
// drawer render the same destinations, so they can never drift.
import { NAV_GROUPS, activeHref } from "./nav";

/**
 * Mobile / tablet navigation for the admin shell.
 *
 * AdminSidebar is desktop-only (`hidden … md:flex`), so below 768px there was
 * NO way to move between sections and the ⌘K palette opens only on a physical
 * keystroke — a phone visit to an admin URL dead-ended (audit B/F finding). This
 * adds a `md:hidden` hamburger that opens the SAME NAV_GROUPS in the shared
 * Drawer (focus-trap + Escape + backdrop close). Desktop is untouched — at md+
 * the button is hidden and the sidebar is the nav.
 */
export function AdminMobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname() ?? "";
  const active = activeHref(pathname);
  const settingsActive = pathname.startsWith("/settings");

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        className="-ml-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-card text-text hover:bg-surface-subtle md:hidden"
      >
        <Menu aria-hidden="true" className="h-5 w-5" />
      </button>

      <Drawer open={open} onClose={() => setOpen(false)} title="BuhlOS" subtitle="Menu">
        <nav aria-label="BuhlOS admin">
          {NAV_GROUPS.map((group) => (
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
                        onClick={() => setOpen(false)}
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

          {/* Footer link parity with the sidebar — settings isn't a daily
              destination but must still be reachable on a phone (#218). */}
          <div className="mt-2 border-t border-border pt-2">
            <Link
              href={"/settings/notifications" as Route}
              onClick={() => setOpen(false)}
              aria-current={settingsActive ? "page" : undefined}
              className={cn(
                "flex min-h-[44px] items-center gap-3 rounded-card px-3 py-2 text-sm",
                settingsActive
                  ? "bg-surface-subtle font-semibold text-text"
                  : "text-text-muted hover:bg-surface-subtle hover:text-text",
              )}
            >
              <Bell aria-hidden="true" className="h-4 w-4" />
              <span className="flex-1 truncate">Notification settings</span>
            </Link>
          </div>
        </nav>
      </Drawer>
    </>
  );
}
