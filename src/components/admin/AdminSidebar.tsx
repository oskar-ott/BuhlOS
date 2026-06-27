"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Route } from "next";
import { Bell, ListChecks } from "lucide-react";
import { cn } from "@/lib/cn";
import { SignOutButton } from "./SignOutButton";
// #215 — NAV is extracted so the sidebar and the ⌘K palette render the same
// destinations from one source (see ./nav.ts). Rendering + longest-prefix
// active state below are unchanged.
import { NAV_GROUPS, activeHref } from "./nav";

export function AdminSidebar() {
  const pathname = usePathname() ?? "";
  const active = activeHref(pathname);

  return (
    <aside className="hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-brand-navy text-text-inverse md:flex">
      <div className="px-5 py-6">
        <p className="font-display text-xs uppercase tracking-widest text-accent-yellow">BuhlOS</p>
        <p className="font-display text-base text-text-inverse">Command Centre</p>
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
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={isActive ? "page" : undefined}
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
            to sign-out rather than as a nav-group item (#218). Today it is the
            notification-prefs page only; #222 grows /settings into a hub. */}
        <Link
          href={"/settings/notifications" as Route}
          aria-current={pathname.startsWith("/settings/notifications") ? "page" : undefined}
          className={cn(
            "flex w-full items-center gap-3 rounded-card px-3 py-2 text-sm transition-colors",
            pathname.startsWith("/settings/notifications")
              ? "bg-accent-ink font-semibold text-text-inverse"
              : "text-slate-300 hover:bg-accent-ink hover:text-text-inverse",
          )}
        >
          <Bell aria-hidden="true" className="h-4 w-4" />
          <span className="flex-1 truncate">Notification settings</span>
        </Link>
        {/* #224: rule-based task generation lives under settings too. */}
        <Link
          href={"/settings/task-rules" as Route}
          aria-current={pathname.startsWith("/settings/task-rules") ? "page" : undefined}
          className={cn(
            "flex w-full items-center gap-3 rounded-card px-3 py-2 text-sm transition-colors",
            pathname.startsWith("/settings/task-rules")
              ? "bg-accent-ink font-semibold text-text-inverse"
              : "text-slate-300 hover:bg-accent-ink hover:text-text-inverse",
          )}
        >
          <ListChecks aria-hidden="true" className="h-4 w-4" />
          <span className="flex-1 truncate">Task generation rules</span>
        </Link>
        <SignOutButton />
      </div>
    </aside>
  );
}
