"use client";

import { Camera, Loader2, Plus, X } from "lucide-react";
import { humanFileSize } from "@/domains/evidence/service";
import { cn } from "@/lib/cn";

/** A photo sitting in the capture tray (not yet submitted anywhere). */
export interface TrayPhoto {
  /** Local tray id — stable across resize/upload so results map back. */
  id: string;
  file: File;
  /** Resized preview/upload data-url; null while the resize is running. */
  dataUrl: string | null;
  status: "resizing" | "ready" | "failed";
  /** Honest per-photo problem (resize or upload failure) shown on the tile. */
  error?: string;
  /** Blob URL once this photo has been uploaded for an OFFICE item — retries
   *  reuse it instead of re-uploading (see observations/office-capture.ts). */
  officeUrl?: string;
}

interface Props {
  photos: ReadonlyArray<TrayPhoto>;
  max: number;
  busy: boolean;
  /** Fires the global camera input — must be called from a direct tap. */
  onAdd: () => void;
  onRemove: (id: string) => void;
}

/**
 * The multi-photo tray for the camera-first Capture flow. Photos land here
 * straight from the camera; the worker can keep shooting ("Add photo") and
 * remove mistakes before deciding where the batch goes. Pure presentation —
 * the launcher owns the photo state and the resize/upload lifecycle.
 */
export function CapturePhotoTray({ photos, max, busy, onAdd, onRemove }: Props) {
  if (photos.length === 0) {
    return (
      <button
        type="button"
        onClick={onAdd}
        disabled={busy}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-2",
          "rounded-card border-2 border-dashed border-border bg-surface-subtle",
          "px-6 py-10 text-center transition-colors",
          "hover:border-brand-navy hover:bg-surface",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        <Camera aria-hidden="true" className="h-8 w-8 text-text-muted" />
        <span className="font-display text-base font-semibold text-text">Take a photo</span>
        <span className="text-xs text-text-muted">
          Camera opens by default. You can also choose from gallery.
        </span>
      </button>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-display text-sm font-semibold text-text">
          {photos.length === 1 ? "1 photo" : `${photos.length} photos`}
        </p>
        <p className="text-xs text-text-muted">up to {max} per capture</p>
      </div>
      <ul className="mt-2 grid grid-cols-3 gap-2">
        {photos.map((p) => (
          <li key={p.id} className="relative">
            <div
              className={cn(
                "flex aspect-square items-center justify-center overflow-hidden rounded-card border bg-surface-subtle",
                p.status === "failed" ? "border-state-danger" : "border-border",
              )}
            >
              {p.dataUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- dataURL preview, not optimised
                <img
                  src={p.dataUrl}
                  alt={`Photo ${p.file.name || ""}`.trim()}
                  className="h-full w-full object-cover"
                />
              ) : p.status === "resizing" ? (
                <Loader2 aria-hidden="true" className="h-5 w-5 animate-spin text-text-muted" />
              ) : (
                <span className="px-2 text-center text-[12px] text-state-danger">
                  {p.error ?? "Couldn't read this photo"}
                </span>
              )}
            </div>
            {!busy ? (
              <button
                type="button"
                onClick={() => onRemove(p.id)}
                aria-label={`Remove photo${p.file.name ? ` ${p.file.name}` : ""}`}
                className={cn(
                  "absolute -right-1.5 -top-1.5 inline-flex h-6 w-6 items-center justify-center",
                  "rounded-full border border-border bg-surface text-text shadow-raised",
                )}
              >
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {p.status === "failed" && p.error ? (
              <p className="mt-1 text-[12px] leading-tight text-state-danger">{p.error}</p>
            ) : null}
            {p.status === "ready" ? (
              <p className="mt-1 truncate text-[12px] text-text-muted">
                {humanFileSize(p.file.size)}
              </p>
            ) : null}
          </li>
        ))}
        {photos.length < max ? (
          <li>
            <button
              type="button"
              onClick={onAdd}
              disabled={busy}
              className={cn(
                "flex aspect-square w-full flex-col items-center justify-center gap-1",
                "rounded-card border-2 border-dashed border-border bg-surface-subtle text-text-muted",
                "transition-colors hover:border-brand-navy hover:text-text",
                "disabled:cursor-not-allowed disabled:opacity-60",
              )}
            >
              <Plus aria-hidden="true" className="h-5 w-5" />
              <span className="text-xs font-semibold">Add photo</span>
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
