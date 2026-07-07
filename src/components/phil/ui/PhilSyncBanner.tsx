"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The reusable sync/save banner set (sharpened design system §3 — "Phil never
 * fails silently"). Use wherever work is saved:
 *
 *   saved    green  "Saved & backed up"            — on the phone AND the office
 *   sending  blue   "Sending…"                     — upload in flight
 *   offline  amber  "Offline — saved on your phone" — outbox waiting on signal
 *   failed   red    "Couldn't send"                — nothing lost; Try again
 *
 * Visual language: a solid tint panel (the --state-*-subtle-* quads) + a 6px
 * status dot + fixed calm wording. This is deliberately NOT PhilNotice
 * (neutral card + tone rail — the general notice surface) and NOT
 * PhilOfflineBanner (the page-level "you're offline" read banner): this one
 * is the per-save receipt, and its tinted-panel language is the piece under
 * test in the sharpened package. Constitution P8: offline and failure are
 * shown truthfully; state copy never pretends a send succeeded.
 *
 * Failed banners escalate to role="alert"; the others are polite status.
 * The Try again target is ≥44px (field-glove floor).
 */
export type PhilSyncState = "saved" | "sending" | "offline" | "failed";

interface PhilSyncBannerProps {
  state: PhilSyncState;
  /**
   * Optional contextual body replacing the default wording's second line
   * (e.g. "Two photos on the way up." while sending). Keep it one short line.
   */
  detail?: ReactNode;
  /**
   * Offline only: how many saves are waiting for signal. Renders the
   * "{n} waiting" chip when > 0. Never fabricate — pass the real outbox count.
   */
  waitingCount?: number;
  /** Failed only: wires the Try again button. Without it no button renders. */
  onRetry?: () => void;
  className?: string;
}

const STATE_COPY: Record<PhilSyncState, { title: string; body: string | null }> = {
  saved: { title: "Saved & backed up", body: "On your phone and up to the office." },
  sending: { title: "Sending…", body: null },
  offline: {
    title: "Offline — saved on your phone",
    body: "Sends itself when signal's back.",
  },
  failed: { title: "Couldn't send", body: "Nothing's lost — it's still on your phone." },
};

const STATE_TONE: Record<
  PhilSyncState,
  { panel: string; dot: string; chip: string; retry: string }
> = {
  saved: {
    panel:
      "bg-state-success-subtle-bg border-state-success-subtle-border text-state-success-subtle-text",
    dot: "bg-state-success-dot",
    chip: "border-state-success-subtle-border",
    retry: "",
  },
  sending: {
    panel: "bg-state-info-subtle-bg border-state-info-subtle-border text-state-info-subtle-text",
    dot: "bg-state-info-dot",
    chip: "border-state-info-subtle-border",
    retry: "",
  },
  offline: {
    panel:
      "bg-state-warning-subtle-bg border-state-warning-subtle-border text-state-warning-subtle-text",
    dot: "bg-state-warning-dot",
    chip: "border-state-warning-subtle-border",
    retry: "",
  },
  failed: {
    panel:
      "bg-state-danger-subtle-bg border-state-danger-subtle-border text-state-danger-subtle-text",
    dot: "bg-state-danger-dot",
    chip: "border-state-danger-subtle-border",
    retry:
      "border-state-danger-subtle-border bg-surface text-state-danger-subtle-text hover:bg-surface-subtle",
  },
};

export function PhilSyncBanner({
  state,
  detail,
  waitingCount,
  onRetry,
  className,
}: PhilSyncBannerProps) {
  const copy = STATE_COPY[state];
  const tone = STATE_TONE[state];
  const body = detail ?? copy.body;
  const showWaiting = state === "offline" && typeof waitingCount === "number" && waitingCount > 0;
  const showRetry = state === "failed" && typeof onRetry === "function";

  return (
    <div
      role={state === "failed" ? "alert" : "status"}
      data-testid={`phil-sync-banner-${state}`}
      className={cn("rounded-card border p-3.5", tone.panel, className)}
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} />
        <p className="min-w-0 flex-1 font-display text-[15px] font-bold leading-snug">
          {copy.title}
        </p>
        {showWaiting ? (
          <span
            className={cn(
              "shrink-0 rounded-pill border bg-surface px-2 py-0.5",
              "font-display text-[12px] font-bold uppercase tracking-[0.03em]",
              tone.chip,
            )}
          >
            {`${waitingCount} waiting`}
          </span>
        ) : null}
      </div>
      {body ? <p className="mt-1 pl-3.5 text-[13px] leading-snug">{body}</p> : null}
      {showRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className={cn(
            "mt-2.5 inline-flex min-h-[44px] w-full items-center justify-center rounded-card border px-4",
            "text-sm font-semibold transition active:scale-[0.99]",
            tone.retry,
          )}
        >
          Try again
        </button>
      ) : null}
    </div>
  );
}
