"use client";

import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { TILE_LABEL, type PendingPhoto } from "@/domains/itp-simple/upload-queue";
import type { ItpPhoto } from "@/domains/itp-simple/schema";
import styles from "./itp.module.css";

/**
 * One square tile in an area's 3-column grid (handoff 2026-11-02 "Photo
 * tile"). Saved = a plain photo that opens the photo sheet. The pending
 * states overlay the photo with WORDS — colour never carries the state
 * alone — and the only control they add is the one the state needs
 * (Retry on Didn't save, Clear on Over 8 MB; Not sent retries from the
 * dock's Retry all).
 */
export function ItpSavedTile({
  photo,
  index,
  total,
  areaName,
  onOpen,
}: {
  photo: ItpPhoto;
  index: number;
  total: number;
  areaName: string;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Photo ${index} of ${total}, ${areaName}, saved`}
      className="relative aspect-square w-full overflow-hidden rounded-[8px] border border-border bg-surface-subtle focus-visible:outline-brand-navy"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photo.url} alt="" className="h-full w-full object-cover" />
    </button>
  );
}

export function ItpPendingTile({
  item,
  index,
  total,
  areaName,
  onRetry,
  onClear,
}: {
  item: PendingPhoto;
  index: number;
  total: number;
  areaName: string;
  onRetry: () => void;
  onClear: () => void;
}) {
  const label = TILE_LABEL[item.state];
  const ring =
    item.state === "failed"
      ? "ring-[3px] ring-inset ring-state-danger"
      : item.state === "notSent" || item.state === "tooBig"
        ? "ring-[3px] ring-inset ring-state-warning"
        : "";
  const overlay =
    item.state === "waiting"
      ? "bg-[rgba(246,247,249,0.82)] text-text-muted"
      : item.state === "saving"
        ? "bg-[rgba(246,247,249,0.82)] text-state-info"
        : item.state === "failed"
          ? "bg-[rgba(253,236,236,0.92)] text-state-danger-subtle-text"
          : "bg-[rgba(251,241,224,0.92)] text-state-warning-subtle-text";

  return (
    <div
      role="group"
      aria-label={`Photo ${index} of ${total}, ${areaName}, ${label}`}
      className={cn(
        "relative aspect-square w-full overflow-hidden rounded-[8px] bg-surface-subtle",
        ring
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
      <div
        className={cn(
          "absolute inset-0 flex flex-col items-center justify-center gap-1 px-1 text-center text-[14px] font-bold leading-tight",
          overlay
        )}
      >
        {item.state === "saving" ? (
          <Loader2 aria-hidden="true" className={cn("h-5 w-5", styles.spin)} />
        ) : null}
        <span>{label}</span>
        {item.state === "failed" ? (
          <button
            type="button"
            onClick={onRetry}
            className="mt-0.5 min-h-[32px] rounded-[6px] bg-state-danger px-2.5 text-[13px] font-bold text-text-inverse focus-visible:outline-brand-navy"
          >
            Retry
          </button>
        ) : null}
        {item.state === "tooBig" ? (
          <button
            type="button"
            onClick={onClear}
            className="mt-0.5 min-h-[32px] rounded-[6px] border border-state-warning-subtle-border bg-surface px-2.5 text-[13px] font-bold text-state-warning-subtle-text focus-visible:outline-brand-navy"
          >
            Clear
          </button>
        ) : null}
      </div>
    </div>
  );
}
