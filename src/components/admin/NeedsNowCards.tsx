"use client";

import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  Camera,
  Clock,
  FileCheck2,
  Inbox,
  Layers,
  Package,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { ExceptionItem, ExceptionSource } from "@/domains/exceptions/types";

/**
 * "Needs you now" — the Command Centre's ≤N action cards (brief §2). Shows the
 * actionable exceptions (critical-first, supplied by buildBoard), capped, with a
 * "+N more" toggle. Each card deep-links to the surface that owns the item; an
 * item whose action isn't reachable renders muted (never a broken link).
 */

const SOURCE_ICON: Record<ExceptionSource, typeof AlertOctagon> = {
  hours: Clock,
  observation: Inbox,
  evidence: Camera,
  snag: AlertOctagon,
  itp: FileCheck2,
  job: AlertTriangle,
  material: Package,
  planMarkup: Layers,
  gear: Wrench,
};

function cardTone(item: ExceptionItem): string {
  return item.severity === "critical"
    ? "border-l-state-danger bg-rose-50"
    : "border-l-state-warning bg-amber-50";
}

function CardInner({ item }: { item: ExceptionItem }) {
  const Icon = SOURCE_ICON[item.source] ?? AlertTriangle;
  const meta = [item.sourceLabel ?? item.source, item.jobName, item.ageLabel]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <span
        className={cn(
          "mt-0.5 shrink-0",
          item.severity === "critical" ? "text-state-danger" : "text-state-warning",
        )}
      >
        <Icon aria-hidden="true" className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs text-text-muted">{meta}</span>
        <span className="mt-0.5 block font-display text-sm font-semibold text-text">
          {item.title}
        </span>
      </span>
    </>
  );
}

export function NeedsNowCards({
  items,
  cap,
}: {
  items: ReadonlyArray<ExceptionItem>;
  cap: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, cap);
  const overflow = items.length - cap;

  return (
    <div className="mt-3 space-y-2">
      {shown.map((item) => {
        const actionable = item.actionState === "available" && !!item.actionHref;
        const base =
          "flex items-start gap-3 rounded-card border border-border border-l-4 px-3 py-2.5 " +
          cardTone(item);
        return actionable ? (
          <Link
            key={item.id}
            href={item.actionHref as Route}
            aria-label={`${item.title} — ${item.actionLabel ?? "open"}`}
            className={cn(
              base,
              "group transition-colors hover:border-brand-navy focus:outline-none focus:ring-2 focus:ring-brand-navy",
            )}
          >
            <CardInner item={item} />
            <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 self-center text-sm font-medium text-brand-navy">
              <span className="hidden sm:inline">{item.actionLabel ?? "Open"}</span>
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </span>
          </Link>
        ) : (
          <div key={item.id} className={base}>
            <CardInner item={item} />
            {item.actionReason ? (
              <span className="mt-0.5 shrink-0 self-center text-xs text-text-muted">
                {item.actionReason}
              </span>
            ) : null}
          </div>
        );
      })}

      {overflow > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded((s) => !s)}
          className="w-full rounded-card border border-dashed border-border px-3 py-2 text-sm font-medium text-text-muted transition-colors hover:border-brand-navy hover:text-text"
        >
          {expanded ? "Show fewer" : `+${overflow} more need action`}
        </button>
      ) : null}
    </div>
  );
}
