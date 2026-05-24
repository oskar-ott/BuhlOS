import Link from "next/link";
import type { Route } from "next";
import {
  LayoutGrid,
  ClipboardCheck,
  AlertOctagon,
  LifeBuoy,
  Briefcase,
  Settings,
  Clock,
  LogOut,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { Pill } from "@/components/ui/Pill";

interface NavItem {
  label: string;
  href: Route;
  icon: typeof LayoutGrid;
  status: "live" | "under-construction";
}

/**
 * Phase A admin nav: Command centre (live) + UC placeholders.
 * Phase B promotes Hours to live (the approval queue + overview).
 *
 * UC items are non-clickable per non-negotiable §"Feature gating".
 *
 * Keep this list aligned with docs/rebuild-audit/13-ui-information-architecture.md
 * §"BuhlOS Admin information architecture > Left sidebar sections".
 */
const NAV: ReadonlyArray<NavItem> = [
  { label: "Command centre", href: "/command-centre", icon: LayoutGrid, status: "live" },
  { label: "Hours", href: "/hours", icon: Clock, status: "live" },
  { label: "Approvals", href: "/hours/approvals", icon: ClipboardCheck, status: "live" },
  { label: "Jobs", href: "/command-centre", icon: Briefcase, status: "under-construction" },
  { label: "Snags", href: "/command-centre", icon: AlertOctagon, status: "under-construction" },
  { label: "Support", href: "/command-centre", icon: LifeBuoy, status: "under-construction" },
  { label: "Settings", href: "/command-centre", icon: Settings, status: "under-construction" },
];

export function AdminSidebar() {
  return (
    <aside className="hidden h-screen w-60 shrink-0 flex-col border-r border-border bg-brand-navy text-text-inverse md:flex">
      <div className="px-5 py-6">
        <p className="font-display text-xs uppercase tracking-widest text-accent-yellow">BuhlOS</p>
        <p className="font-display text-base text-text-inverse">Command Centre</p>
      </div>

      <nav aria-label="BuhlOS admin" className="flex-1 px-2">
        <ul className="space-y-1">
          {NAV.map((item, idx) => {
            const Icon = item.icon;
            const isLive = item.status === "live";
            const baseClass = cn(
              "group flex items-center gap-3 rounded-card px-3 py-2 text-sm",
              isLive ? "text-text-inverse hover:bg-accent-ink" : "text-slate-400 cursor-not-allowed"
            );
            const content = (
              <>
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate">{item.label}</span>
                {!isLive ? (
                  <Pill tone="yellow" className="text-[10px] uppercase tracking-wider">
                    UC
                  </Pill>
                ) : null}
              </>
            );
            return (
              <li key={`${item.label}-${idx}`}>
                {isLive ? (
                  <Link href={item.href} className={baseClass}>
                    {content}
                  </Link>
                ) : (
                  <span
                    aria-disabled="true"
                    title={`${item.label} is under construction in Phase A`}
                    className={baseClass}
                  >
                    {content}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-accent-ink p-3">
        <a
          href="/api/auth?action=logout"
          className="flex items-center gap-3 rounded-card px-3 py-2 text-sm text-slate-300 hover:bg-accent-ink hover:text-text-inverse"
        >
          <LogOut aria-hidden="true" className="h-4 w-4" />
          Sign out
        </a>
      </div>
    </aside>
  );
}
