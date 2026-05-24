import Link from "next/link";
import type { Route } from "next";
import { Calendar, Briefcase, Wrench, AlertCircle, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";

interface Tab {
  label: string;
  href: Route;
  icon: typeof Calendar;
  status: "live" | "under-construction";
}

/**
 * Phase A / B Phil tabs:
 *   Today  → /phil/my-day       (live in Phase B — the hours loop)
 *   Jobs   → UC                 (Phase D)
 *   Gear   → UC                 (Phase C)
 *   Snag   → UC                 (Phase D)
 *   More   → /v2/phil           (live placeholder; profile menu lands in Phase C+)
 *
 * UC tabs are visible but non-interactive per docs/architecture/00-rebuild-non-negotiables.md.
 */
const TABS: ReadonlyArray<Tab> = [
  { label: "Today", href: "/phil/my-day", icon: Calendar, status: "live" },
  { label: "Jobs", href: "/v2/phil", icon: Briefcase, status: "under-construction" },
  { label: "Gear", href: "/v2/phil", icon: Wrench, status: "under-construction" },
  { label: "Snag", href: "/v2/phil", icon: AlertCircle, status: "under-construction" },
  { label: "More", href: "/v2/phil", icon: MoreHorizontal, status: "live" },
];

export function PhilTabBar() {
  return (
    <nav
      aria-label="Phil tabs"
      className="sticky bottom-0 flex h-16 shrink-0 items-stretch border-t border-border bg-surface"
    >
      {TABS.map((tab, idx) => {
        const Icon = tab.icon;
        const isLive = tab.status === "live";
        const content = (
          <span className="flex flex-1 flex-col items-center justify-center gap-1">
            <Icon
              aria-hidden="true"
              className={cn("h-5 w-5", isLive ? "text-text" : "text-text-muted/60")}
            />
            <span
              className={cn(
                "text-[11px] uppercase tracking-wider",
                isLive ? "text-text" : "text-text-muted/60"
              )}
            >
              {tab.label}
              {!isLive ? <span className="ml-0.5 text-accent-yellow">·</span> : null}
            </span>
          </span>
        );
        return isLive ? (
          <Link
            key={`${tab.label}-${idx}`}
            href={tab.href}
            className="flex flex-1 flex-col items-center justify-center"
          >
            {content}
          </Link>
        ) : (
          <span
            key={`${tab.label}-${idx}`}
            aria-disabled="true"
            title={`${tab.label} is under construction in Phase A`}
            className="flex flex-1 cursor-not-allowed flex-col items-center justify-center"
          >
            {content}
          </span>
        );
      })}
    </nav>
  );
}
