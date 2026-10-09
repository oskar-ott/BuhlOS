"use client";

import { useState } from "react";
import { Camera, ImageUp } from "lucide-react";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { PHOTO_PROBLEM_COPY, preparePhoto } from "@/domains/workshop-stock/photo";

/**
 * Take or pick a product photo (Workshop Stock). Camera first, library second,
 * retake any time. The photo is downscaled on the phone; a dark frame gets a
 * non-blocking hint; a photo the phone can't open says so plainly. Camera
 * permission is the browser's file picker — if the camera is refused the
 * library button still works, and so does searching by hand.
 */
export function PhotoCapture({
  guidance,
  onPhoto,
  previewUrl,
  disabled = false,
  testId = "stock-photo",
}: {
  guidance: string;
  onPhoto: (dataUrl: string, dark: boolean) => void;
  previewUrl?: string | null;
  disabled?: boolean;
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
    onPhoto(prepared.dataUrl, prepared.dark);
  }

  const off = disabled || busy;
  return (
    <div className="space-y-3">
      {previewUrl ? (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local data: preview */}
          <img src={previewUrl} alt="Your photo" className="h-28 w-28 rounded-card border border-border object-cover" />
          <p className="text-sm text-text-muted">{guidance}</p>
        </div>
      ) : (
        <p className="text-sm text-text">{guidance}</p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className={`flex min-h-[56px] cursor-pointer items-center justify-center gap-2 rounded-card bg-accent-yellow px-3 font-semibold text-brand-navy${off ? " pointer-events-none opacity-60" : ""}`} data-testid={`${testId}-camera`}>
          <Camera aria-hidden="true" className="h-5 w-5" />
          <span>{busy ? "Opening…" : previewUrl ? "Retake" : "Take photo"}</span>
          <input type="file" accept="image/*" capture="environment" className="sr-only" disabled={off} onChange={(e) => void pick(e.target.files?.[0], e.currentTarget)} />
        </label>
        <label className={`flex min-h-[56px] cursor-pointer items-center justify-center gap-2 rounded-card border border-border-strong bg-surface px-3 font-semibold text-text${off ? " pointer-events-none opacity-60" : ""}`} data-testid={`${testId}-library`}>
          <ImageUp aria-hidden="true" className="h-5 w-5" />
          <span>From library</span>
          <input type="file" accept="image/*" className="sr-only" disabled={off} onChange={(e) => void pick(e.target.files?.[0], e.currentTarget)} />
        </label>
      </div>
      {problem ? (
        <PhilNotice tone="warning" role="alert">
          {problem}
        </PhilNotice>
      ) : null}
    </div>
  );
}
