"use client";

import Link from "next/link";
import type { Route } from "next";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/cn";
import { StatusChip } from "@/components/ui/StatusChip";
import { type FlagItem, expiryTone } from "@/domains/platform/owner-console";

/**
 * #760 — the EASY staged-rollout control for one feature on the Owner Feature
 * Control Board. One segmented control moves a feature through the launch it
 * actually has:
 *
 *   Off  → nobody sees it.
 *   Preview → only YOU (the owner) see it — build + test it in the real product
 *             before customers or admins get it.
 *   Live → everyone sees it.
 *
 * This is the honest expression of the two dials underneath (customer baseline +
 * owner-preview override): one atomic `rollout` write to POST /api/owner-flags.
 * When a feature is reachable for the owner (Preview or Live), an "Open to test"
 * link deep-links straight to it so the owner can try it immediately.
 *
 * Props-only + effect-free (SSR-render-testable); the board owns the CAS rev +
 * optimistic state + the reduce-exposure confirm.
 */

export type Rollout = "off" | "preview" | "live";

/** Current rollout state derived from the resolved flag (customer > owner > off). */
export function rolloutOf(f: FlagItem): Rollout {
  if (f.resolved) return "live";
  if (f.resolvedForOwner) return "preview";
  return "off";
}

const STAGES: ReadonlyArray<{ state: Rollout; label: string; hint: string }> = [
  { state: "off", label: "Off", hint: "Hidden from everyone" },
  { state: "preview", label: "Preview", hint: "Only you can see it — build & test it live" },
  { state: "live", label: "Live", hint: "Everyone (customers + admins) sees it" },
];

export function OwnerFeatureRow({
  flag,
  saving,
  onRollout,
}: {
  flag: FlagItem;
  saving: boolean;
  onRollout: (state: Rollout) => void;
}) {
  const state = rolloutOf(flag);
  const envPinned = flag.source === "env";
  const canOpen = (state === "preview" || state === "live") && !!flag.previewHref;

  return (
    <div className="space-y-2 px-4 py-3" data-testid={`feature-row-${flag.key}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-text">{flag.label || flag.key}</span>
        <span className="font-mono text-[11px] text-text-muted">{flag.key}</span>
        <StatusChip
          tone={state === "live" ? "success" : state === "preview" ? "info" : "neutral"}
          dot={false}
        >
          {state === "live" ? "Live" : state === "preview" ? "Preview only (you)" : "Off"}
        </StatusChip>
        {flag.core ? (
          <StatusChip tone="warning" dot={false}>
            core
          </StatusChip>
        ) : null}
        {flag.expiryStatus !== "ok" ? (
          <StatusChip tone={expiryTone(flag.expiryStatus)}>{flag.expiryStatus}</StatusChip>
        ) : null}
        {envPinned ? (
          <StatusChip tone="warning" dot={false}>
            pinned by env
          </StatusChip>
        ) : null}
      </div>

      <p className="text-sm text-text-muted">{flag.description}</p>

      {envPinned ? (
        <p className="text-xs text-text-muted">
          Pinned by <span className="font-mono">FLAG_{flag.key.toUpperCase()}</span> — change it in
          deployment settings; the env value always wins.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3 pt-0.5">
          {/* The easy staged control: Off · Preview · Live. */}
          <div
            role="group"
            aria-label={`Rollout for ${flag.label || flag.key}`}
            className="inline-flex overflow-hidden rounded-card border border-border"
          >
            {STAGES.map((s) => {
              const active = s.state === state;
              return (
                <button
                  key={s.state}
                  type="button"
                  disabled={saving}
                  aria-pressed={active}
                  title={s.hint}
                  data-testid={`rollout-${s.state}-${flag.key}`}
                  onClick={() => {
                    if (!active) onRollout(s.state);
                  }}
                  className={cn(
                    "px-3 py-1.5 text-sm transition-colors disabled:opacity-50",
                    active
                      ? s.state === "live"
                        ? "bg-brand-navy font-semibold text-white"
                        : s.state === "preview"
                          ? "bg-accent-ink font-semibold text-white"
                          : "bg-surface-subtle font-semibold text-text"
                      : "text-text-muted hover:bg-surface-subtle hover:text-text",
                  )}
                >
                  {s.label}
                </button>
              );
            })}
          </div>

          {canOpen ? (
            <Link
              href={flag.previewHref as Route}
              data-testid={`feature-open-${flag.key}`}
              className="inline-flex items-center gap-1 text-sm font-medium text-brand-navy underline underline-offset-2 hover:opacity-80"
            >
              <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              {state === "preview" ? "Open to test" : "Open"}
            </Link>
          ) : null}
        </div>
      )}

      {/* Honest one-liner: what THIS state means for the two audiences. */}
      {!envPinned ? (
        <p className="text-xs text-text-muted">
          {state === "live"
            ? "Everyone sees this feature."
            : state === "preview"
              ? "Only you see this feature — customers and admins don't. Open it to build & test before you release it."
              : "Hidden from everyone. Switch to Preview to test it yourself first."}
        </p>
      ) : null}
    </div>
  );
}
