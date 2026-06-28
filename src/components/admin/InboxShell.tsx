"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { cn } from "@/lib/cn";
import {
  inboxFilterCountLabel,
  inboxStatToneClass,
  isMutedStatValue,
  type InboxStatTone,
} from "./inbox-shell";

/**
 * Shared field-to-office inbox shell (brief §6) — the chrome the five cross-job
 * inboxes share: a glanceable stat strip, a filter bar with a "N of M" count,
 * action banners and a load-error card. Each instance keeps its OWN data
 * fetching, row logic and mutations; this only hoists the surrounding shell so
 * Observations / Material requests / Expenses stop re-declaring it.
 *
 * Presentational only — the colour logic lives in the pure, unit-tested
 * `inbox-shell.ts`. Brand tokens throughout (no new hex, no inline styles).
 */

/* ── Stat strip ─────────────────────────────────────────────────────────── */

export interface InboxStat {
  key: string;
  label: string;
  /** Pre-formatted display value, or "—" when the signal didn't load. A real
   *  0 renders calm/muted; never fabricate a 0 for a missing signal. */
  value: string | number;
  tone?: InboxStatTone;
  icon?: LucideIcon;
}

/**
 * A row of glanceable stat tiles (the prototype's KPI strip). Two-up on
 * mobile, four-up from `lg`, matching the existing inbox summary grids.
 */
export function InboxStatStrip({ stats }: { stats: ReadonlyArray<InboxStat> }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((s) => (
        <InboxStatCard key={s.key} stat={s} />
      ))}
    </div>
  );
}

function InboxStatCard({ stat }: { stat: InboxStat }) {
  const muted = isMutedStatValue(stat.value);
  const toneClass = inboxStatToneClass(stat.tone ?? "neutral", muted);
  const Icon = stat.icon;
  return (
    <Card className="flex items-center justify-between gap-2">
      <div className="min-w-0">
        <p className="text-xs uppercase tracking-wider text-text-muted">{stat.label}</p>
        <p className={cn("mt-1 font-display text-2xl tabular-nums", toneClass)}>{stat.value}</p>
      </div>
      {Icon ? (
        <Icon aria-hidden="true" className={cn("h-5 w-5 shrink-0", toneClass)} />
      ) : null}
    </Card>
  );
}

/* ── Filter bar ─────────────────────────────────────────────────────────── */

/**
 * The filter-bar card. Children are the filter controls (use InboxFilterSelect);
 * the "N of M" count sits at the trailing edge. A `Clear` affordance is passed
 * as `onClear` so the count + reset stay together.
 */
export function InboxFilterBar({
  children,
  shown,
  total,
  onClear,
  clearLabel = "Clear",
}: {
  children: ReactNode;
  /** Rows currently visible after filtering. */
  shown: number;
  /** Total rows loaded. */
  total: number;
  /** When set, renders a Clear button before the count. */
  onClear?: () => void;
  clearLabel?: string;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-card border border-border bg-surface p-3">
      {children}
      {onClear ? (
        <button
          type="button"
          onClick={onClear}
          className="rounded-card px-2 py-1.5 text-xs font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 hover:bg-surface-subtle focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          {clearLabel}
        </button>
      ) : null}
      <span className="ml-auto self-center text-xs text-text-muted">
        {inboxFilterCountLabel(shown, total)}
      </span>
    </div>
  );
}

/** A labelled select for the filter bar. "All" is the always-present default. */
export function InboxFilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel = "All",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  allLabel?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-text-muted">
      <span className="uppercase tracking-wider">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full min-w-0 rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy sm:w-auto sm:min-w-[8rem] sm:max-w-[11rem]"
      >
        <option value="">{allLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ── Banners + load error ───────────────────────────────────────────────── */

/**
 * The transient action result banner (a mutation succeeded / failed). Uses the
 * status palette so success reads green and failure reads danger.
 */
export function InboxBanner({
  tone,
  children,
}: {
  tone: "success" | "danger";
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-card border px-3 py-2 text-sm",
        tone === "success"
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : "border-rose-200 bg-rose-50 text-rose-900"
      )}
    >
      {children}
    </div>
  );
}

/**
 * The "couldn't load" card with a one-tap retry. The amber treatment matches
 * the existing inbox + Phil load-error cards; the message is the honest server
 * reason, never a fabricated empty success.
 */
export function InboxLoadErrorCard({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <Card className="border-amber-200 bg-amber-50" role="alert">
      <CardTitle>{title}</CardTitle>
      <CardDescription className="text-amber-900">{message}</CardDescription>
      <div className="mt-3">
        <RefreshButton />
      </div>
    </Card>
  );
}
