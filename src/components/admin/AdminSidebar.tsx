"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { Settings } from "lucide-react";
import { cn } from "@/lib/cn";
import { SignOutButton } from "./SignOutButton";
// #215 — NAV is extracted so the sidebar and the ⌘K palette render the same
// destinations from one source (see ./nav.ts). Rendering + longest-prefix
// active state below are unchanged.
import { NAV_GROUPS, activeHref } from "./nav";
import { useNavCounts } from "./useNavCounts";

export function AdminSidebar() {
  const pathname = usePathname() ?? "";
  const active = activeHref(pathname);
  // Live loop counts for the nav badges (brief §1). Best-effort + module-cached;
  // empty until the first fan-out resolves, so SSR renders labels with no badge.
  const counts = useNavCounts();

  return (
    <aside className="hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-brand-navy text-text-inverse md:flex">
      <div className="flex flex-col gap-1.5 px-5 py-6">
        {/* The bühl mark leads the office shell (brief §1). White wordmark on
            the navy rail. */}
        {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset in /public, not a remote/optimised image */}
        <img
          src="/brand/buhl-logo-white.png"
          alt="bühl electrical"
          className="h-7 w-auto self-start"
        />
        <p className="font-display text-[11px] uppercase tracking-widest text-slate-400">
          office command centre
        </p>
      </div>

      <nav aria-label="BuhlOS admin" className="flex-1 overflow-y-auto px-2 pb-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.heading} className="mb-3">
            <p className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-widest text-slate-400">
              {group.heading}
            </p>
            <ul className="space-y-1">
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = item.href === active;
                // Live count for this loop (undefined until loaded / no source).
                const count = item.countKey ? counts[item.countKey] : undefined;
                const showCount = typeof count === "number" && count > 0;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
                      // When a count is present, fold it into the accessible name
                      // so screen readers hear "Defects: 4 needing attention"
                      // (the visual pip itself is decorative / aria-hidden).
                      aria-label={
                        showCount
                          ? `${item.label}: ${count}${item.attention ? " needing attention" : ""}`
                          : undefined
                      }
                      className={cn(
                        // Per doc 27 §7.2: active = yellow left border +
                        // accent-ink background + semi-bold label.
                        "group flex items-center gap-3 rounded-card border-l-2 px-3 py-2 text-sm transition-colors",
                        isActive
                          ? "border-l-accent-yellow bg-accent-ink font-semibold text-text-inverse"
                          : "border-l-transparent text-text-inverse hover:bg-accent-ink/60",
                      )}
                    >
                      <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                      <span className="flex-1 truncate">{item.label}</span>
                      {showCount ? (
                        <span
                          aria-hidden="true"
                          data-testid={`nav-count-${item.countKey}`}
                          className={cn(
                            "inline-flex min-w-[1.25rem] justify-center rounded-pill px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums",
                            item.attention
                              ? "bg-state-danger text-text-inverse"
                              : "bg-accent-ink text-slate-300",
                          )}
                        >
                          {count > 99 ? "99+" : count}
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="space-y-1 border-t border-accent-ink p-3">
        {/* Settings is not a daily destination, so it lives in the footer next
            to sign-out rather than as a nav-group item (#218). #222 grew it into
            a hub — one "Settings" link to /settings, which itself hosts hours
            policy + job types and links on to notification prefs (#218) and task
            generation rules (#224). The footer is a single entry again. */}
        <Link
          href={"/settings" as Route}
          aria-current={pathname.startsWith("/settings") ? "page" : undefined}
          className={cn(
            "flex w-full items-center gap-3 rounded-card px-3 py-2 text-sm transition-colors",
            pathname.startsWith("/settings")
              ? "bg-accent-ink font-semibold text-text-inverse"
              : "text-slate-300 hover:bg-accent-ink hover:text-text-inverse",
          )}
        >
          <Settings aria-hidden="true" className="h-4 w-4" />
          <span className="flex-1 truncate">Settings</span>
        </Link>
        <SignOutButton />
      </div>
    </aside>
  );
}
