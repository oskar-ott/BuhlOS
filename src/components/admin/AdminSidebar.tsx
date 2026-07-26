"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
// #215 — NAV is extracted so this nav and the ⌘K palette render the same
// destinations from one source (see ./nav.ts). Longest-prefix active state
// is unchanged.
// #760 — hiddenHrefs (resolved server-side in AdminShell) drops owner-disabled
// features from the office IA via visibleNavGroups.
import { visibleNavGroups, activeHref } from "./nav";
import { useNavCounts } from "./useNavCounts";

/**
 * The BuhlOS admin primary navigation — since the lean-reset redesign
 * (2026-07-26, owner-ratified replica) a horizontal pill row in the white top
 * bar, not a navy rail. The component keeps the AdminSidebar name because the
 * shell contract guards (scripts/check-shell-contract.js,
 * scripts/check-route-ownership.js) and the render suite key off it.
 *
 * Behaviour is unchanged from the rail: one flattened list from nav.ts
 * (NAV_GROUPS stays grouped — the ⌘K palette still renders the headings),
 * longest-prefix active state, honest useNavCounts badges, #760 hiddenHrefs
 * filtering. Active item = navy pill with white label; the rest are ghost
 * pills. Desktop-only (hidden below md — AdminMobileTabBar owns < md).
 *
 * Overflow: prod can show more items than the replica's five (flag-dependent),
 * so the row scrolls horizontally with no wrap — the HoursTabs scroll pattern
 * (overflow-x-auto + shrink-0 items, active item scrolled into view; the
 * scrollIntoView effect is inert under SSR).
 */
export function AdminSidebar({ hiddenHrefs }: { hiddenHrefs?: ReadonlyArray<string> }) {
  const pathname = usePathname() ?? "";
  const active = activeHref(pathname);
  const groups = visibleNavGroups(hiddenHrefs);
  const items = groups.flatMap((g) => g.items);
  // Live loop counts for the nav badges (brief §1). Best-effort + module-cached;
  // empty until the first fan-out resolves, so SSR renders labels with no badge.
  const counts = useNavCounts();
  const activeRef = useRef<HTMLLIElement | null>(null);

  // Keep the active pill in view when the row overflows (deep link / many
  // flags on). `nearest` never scrolls when it's already visible.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [pathname]);

  return (
    <nav aria-label="BuhlOS admin" className="hidden min-w-0 flex-1 md:block">
      <ul className="flex items-center gap-1 overflow-x-auto">
        {items.map((item) => {
          const Icon = item.icon;
          const isActive = item.href === active;
          // Live count for this loop (undefined until loaded / no source).
          const count = item.countKey ? counts[item.countKey] : undefined;
          const showCount = typeof count === "number" && count > 0;
          return (
            <li key={item.href} ref={isActive ? activeRef : undefined} className="shrink-0">
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                // When a count is present, fold it into the accessible name
                // so screen readers hear "Defects: 4 needing attention"
                // (the visual chip itself is decorative / aria-hidden).
                aria-label={
                  showCount
                    ? `${item.label}: ${count}${item.attention ? " needing attention" : ""}`
                    : undefined
                }
                className={cn(
                  // Replica top-nav pills: active = navy pill, white label;
                  // inactive = ghost, subtle hover.
                  "flex h-9 items-center gap-2 whitespace-nowrap rounded-card px-3 text-sm transition-colors",
                  isActive
                    ? "bg-brand-navy font-semibold text-text-inverse"
                    : "text-text-muted hover:bg-surface-subtle hover:text-text",
                )}
              >
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
                {showCount ? (
                  <span
                    aria-hidden="true"
                    data-testid={`nav-count-${item.countKey}`}
                    className={cn(
                      "inline-flex min-w-[1.25rem] justify-center rounded-pill px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums",
                      // On the navy active pill use a translucent WHITE tint —
                      // never text-text-inverse/NN (renders dark ink, see the
                      // admin token opacity gotcha).
                      isActive
                        ? "bg-white/15 text-text-inverse"
                        : item.attention
                          ? "bg-state-danger-subtle-bg text-state-danger-subtle-text"
                          : "bg-state-neutral-subtle-bg text-state-neutral-subtle-text",
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
    </nav>
  );
}
