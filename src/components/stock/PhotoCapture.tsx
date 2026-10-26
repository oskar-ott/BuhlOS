"use client";

import { useState, type ReactNode } from "react";
import { Camera, ImageUp } from "lucide-react";
import { cn } from "@/lib/cn";
import { PHOTO_PROBLEM_COPY, preparePhoto } from "@/domains/workshop-stock/photo";
import { Slot } from "./ui";

/**
 * Take or pick a product photo (Workshop Stock). The photo is downscaled on
 * the phone; a dark frame gets a non-blocking hint; a photo the phone can't
 * open says so plainly. Camera permission is the browser's file picker — if
 * the camera is refused the library button still works, and so does searching
 * by hand.
 *
 * Two shapes: `pair` (camera + library side by side, the Add screen) and
 * `single` (one named button — "No code? Photograph the label" — with the
 * library as a small link under it, the Take screen's backup).
 */
export function PhotoCapture({
  guidance,
  onPhoto,
  previewUrl,
  disabled = false,
  variant = "pair",
  label,
  sub,
  tone = "pri",
  testId = "stock-photo",
}: {
  guidance?: string;
  /** the photo (≤ 1600 px), whether it looks dark, and its list-size copy (null if it couldn't be made) */
  onPhoto: (dataUrl: string, dark: boolean, thumbDataUrl: string | null) => void;
  previewUrl?: string | null;
  disabled?: boolean;
  variant?: "pair" | "single";
  label?: ReactNode;
  sub?: ReactNode;
  tone?: "pri" | "ter";
  testId?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function pick(file: File | undefined, input: HTMLInputElement) {
    input.value = ""; // so the same photo can be picked again after a retake
    if (!file) return;
    setProblem(null);
    setBusy(true);
    const prepared = await preparePhoto(file);
    setBusy(false);
    if (!prepared.ok) {
      setProblem(PHOTO_PROBLEM_COPY[prepared.reason]);
      return;
    }
    onPhoto(prepared.dataUrl, prepared.dark, prepared.thumbDataUrl);
  }

  const off = disabled || busy;
  const cameraInput = <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={off} onChange={(e) => void pick(e.target.files?.[0], e.currentTarget)} />;
  const libraryInput = <input type="file" accept="image/*" className="sr-only" disabled={off} onChange={(e) => void pick(e.target.files?.[0], e.currentTarget)} />;

  if (variant === "single") {
    return (
      <div className="space-y-1.5">
        <label
          className={cn(
            "flex min-h-[56px] w-full cursor-pointer flex-col items-center justify-center rounded-[14px] px-3.5 py-2 text-center font-display text-[17px] font-bold leading-tight",
            tone === "pri" ? "border-2 border-[#e6b800] bg-accent-yellow text-brand-navy" : "border border-border-strong bg-surface-subtle text-brand-navy",
            off && "pointer-events-none opacity-60",
          )}
          data-testid={`${testId}-camera`}
        >
          <span className="flex items-center gap-2">
            <Camera aria-hidden="true" className="h-5 w-5" />
            {busy ? "Opening…" : label ?? "Take photo"}
          </span>
          {sub ? <span className="mt-0.5 block font-sans text-[13px] font-medium text-accent-ink/80">{sub}</span> : null}
          {cameraInput}
        </label>
        <label className={cn("inline-flex min-h-[44px] cursor-pointer items-center gap-1.5 px-1 text-sm font-semibold text-text-muted underline underline-offset-2", off && "pointer-events-none opacity-60")} data-testid={`${testId}-library`}>
          <ImageUp aria-hidden="true" className="h-4 w-4" />
          Or pick a photo from the library
          {libraryInput}
        </label>
        {problem ? <Slot tone="warn" role="alert">{problem}</Slot> : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {previewUrl ? (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local data: preview */}
          <img src={previewUrl} alt="Your photo" className="h-24 w-24 rounded-xl border border-border object-cover" />
          {guidance ? <p className="text-sm text-text-muted">{guidance}</p> : null}
        </div>
      ) : guidance ? (
        <p className="text-sm text-text">{guidance}</p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <label className={cn("flex min-h-[56px] cursor-pointer items-center justify-center gap-2 rounded-[14px] border-2 border-[#e6b800] bg-accent-yellow px-3 font-display text-[17px] font-bold text-brand-navy", off && "pointer-events-none opacity-60")} data-testid={`${testId}-camera`}>
          <Camera aria-hidden="true" className="h-5 w-5" />
          <span>{busy ? "Opening…" : previewUrl ? "Retake" : label ?? "Take photo"}</span>
          {cameraInput}
        </label>
        <label className={cn("flex min-h-[56px] cursor-pointer items-center justify-center gap-2 rounded-[14px] border-2 border-brand-navy bg-surface px-3 font-display text-[17px] font-bold text-brand-navy", off && "pointer-events-none opacity-60")} data-testid={`${testId}-library`}>
          <ImageUp aria-hidden="true" className="h-5 w-5" />
          <span>From library</span>
          {libraryInput}
        </label>
      </div>
      {problem ? <Slot tone="warn" role="alert">{problem}</Slot> : null}
    </div>
  );
}
