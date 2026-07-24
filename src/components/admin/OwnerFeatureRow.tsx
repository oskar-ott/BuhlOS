"use client";

import Link from "next/link";
import type { Route } from "next";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/cn";
import { StatusChip } from "@/components/ui/StatusChip";
import { type FlagItem, expiryTone } from "@/domains/platform/owner-console";

/**
 * #760 — the EASY staged-rollout control for one feature on the Owner Feature
 * Control Board, drawn as a three-position switch (a launch pipeline):
 *
 *   Off  → nobody sees it.
 *   Preview → only YOU (the owner) see it — build + test it in the real product
 *             before customers or admins get it.
 *   Live → everyone sees it.
 *
 * The track fills up to the current stage so the state is readable at a glance
 * (off = empty, preview = half, live = full). This is the honest expression of
 * the two dials underneath (customer baseline + owner-preview override): one
 * atomic `rollout` write to POST /api/owner-flags. When a feature is reachable
 * for the owner (Preview or Live), an "Open to test" link deep-links straight
 * to it so the owner can try it immediately.
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

const STAGE_INDEX: Record<Rollout, number> = { off: 0, preview: 1, live: 2 };

/** Node + track colours per CURRENT stage (the travelled path takes this colour). */
const STAGE_COLOR: Record<Rollout, { node: string; track: string; label: string }> = {
  off: {
    node: "border-border-strong bg-border-strong",
    track: "bg-border-strong",
    label: "text-text",
  },
  preview: { node: "border-sky-500 bg-sky-500", track: "bg-sky-500", label: "text-sky-700" },
  live: {
    node: "border-emerald-500 bg-emerald-500",
    track: "bg-emerald-500",
    label: "text-emerald-700",
  },
};

/** The three-position rollout switch. Effect-free; each stop is a button. */
function RolloutSwitch({
  name,
  state,
  saving,
  flagKey,
  onRollout,
}: {
  name: string;
  state: Rollout;
  saving: boolean;
  flagKey: string;
  onRollout: (state: Rollout) => void;
}) {
  const currentIdx = STAGE_INDEX[state];
  const color = STAGE_COLOR[state];

  return (
    <div
      role="group"
      aria-label={`Rollout for ${name}`}
      aria-busy={saving || undefined}
      className={cn("flex items-start", saving && "opacity-60")}
    >
      {STAGES.map((s, i) => {
        const isCurrent = i === currentIdx;
        const isPassed = i < currentIdx;
        return (
          <div key={s.state} className="flex items-start">
            {i > 0 ? (
              // Connector segment — takes the current stage's colour once travelled.
              <span
                aria-hidden="true"
                className={cn(
                  "mt-[9px] h-0.5 w-6 sm:w-8",
                  i <= currentIdx ? color.track : "bg-border",
                )}
              />
            ) : null}
            <button
              type="button"
              disabled={saving}
              aria-pressed={isCurrent}
              title={s.hint}
              data-testid={`rollout-${s.state}-${flagKey}`}
              onClick={() => {
                if (!isCurrent) onRollout(s.state);
              }}
              className="group/stop flex flex-col items-center gap-1 disabled:cursor-not-allowed"
            >
              <span
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded-full border-2 transition-all",
                  isCurrent
                    ? cn(color.node, saving ? "animate-pulse" : "scale-110")
                    : isPassed
                      ? cn(color.node, "opacity-40")
                      : "border-border-strong bg-surface-raised group-hover/stop:border-text-muted",
                )}
              >
                {isCurrent ? <span className="h-1.5 w-1.5 rounded-full bg-white" /> : null}
              </span>
              <span
                className={cn(
                  "text-[11px] font-semibold leading-none",
                  isCurrent ? color.label : "text-text-muted group-hover/stop:text-text",
                )}
              >
                {s.label}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

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
    <div
      className="grid gap-x-6 gap-y-2 px-4 py-3.5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
      data-testid={`feature-row-${flag.key}`}
    >
      <div className="min-w-0">
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

        <p className="mt-1 text-sm text-text-muted">{flag.description}</p>

        {/* Honest one-liner: what THIS state means for the two audiences. */}
        {envPinned ? (
          <p className="mt-1 text-xs text-text-muted">
            Pinned by <span className="font-mono">FLAG_{flag.key.toUpperCase()}</span> — change it
            in deployment settings; the env value always wins.
          </p>
        ) : (
          <p className="mt-1 text-xs text-text-muted">
            {state === "live"
              ? "Everyone sees this feature."
              : state === "preview"
                ? "Only you see this feature — customers and admins don't. Open it to build & test before you release it."
                : "Hidden from everyone. Switch to Preview to test it yourself first."}
          </p>
        )}
      </div>

      {!envPinned ? (
        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          <RolloutSwitch
            name={flag.label || flag.key}
            state={state}
            saving={saving}
            flagKey={flag.key}
            onRollout={onRollout}
          />
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
      ) : null}
    </div>
  );
}
