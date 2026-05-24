"use client";

import { useRef, useState } from "react";
import { Camera, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { humanFileSize } from "@/domains/evidence/service";
import { cn } from "@/lib/cn";

interface Props {
  /** Selected file, or null when no photo has been picked. */
  file: File | null;
  /** Preview data-url. Passed in (not computed here) so the parent can
   *  decide when to compute the resize and avoid re-reading the file. */
  previewDataUrl: string | null;
  /** Whether the parent is currently uploading — disables the picker. */
  busy: boolean;
  /** Called when the worker picks (or retakes) a photo. Parent owns
   *  state and the resize step. */
  onPick: (file: File) => void;
}

/**
 * Photo capture step for the D3 capture sheet.
 *
 * Pure presentation — the parent (CaptureSheet) owns file + dataUrl
 * state and runs the resize step before storing the dataUrl. Per doc
 * 29 §7.2:
 *
 *   - On open: camera permission prompt fires via accept=image/* +
 *     capture=environment.
 *   - Fallback gallery picker always available (the same input handles
 *     both — when the browser doesn't expose a camera it falls back to
 *     gallery automatically).
 *   - Preview shows after pick. Retake button visible alongside.
 *   - File size displayed via humanFileSize so the worker knows the
 *     upload won't take forever.
 *
 * Cross-ref:
 *   docs/rebuild-audit/29-phase-d3-phil-capture-spec.md §7.2
 *   docs/rebuild-audit/27-interface-usability-pass.md §11
 *   src/domains/evidence/service.ts — resizeImageToDataUrl + humanFileSize
 */
export function CapturePhotoPicker({
  file,
  previewDataUrl,
  busy,
  onPick,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hint, setHint] = useState<string | null>(null);

  function handleClick() {
    if (busy) return;
    setHint(null);
    inputRef.current?.click();
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    // Reset the input so the same file can be re-picked (Retake → same image).
    e.target.value = "";
    if (!picked) return;
    if (!picked.type.startsWith("image/")) {
      setHint("That isn't an image. Pick a photo or use the camera.");
      return;
    }
    onPick(picked);
  }

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        onChange={handleChange}
        aria-label="Take or choose a photo"
      />

      {file && previewDataUrl ? (
        <div className="space-y-2">
          <div className="overflow-hidden rounded-card border border-border bg-surface-subtle">
            {/* eslint-disable-next-line @next/next/no-img-element -- dataURL preview, not optimised */}
            <img
              src={previewDataUrl}
              alt="Captured preview"
              className="block max-h-72 w-full object-contain"
            />
          </div>
          <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
            <span className="truncate">
              {file.name || "Photo"} · {humanFileSize(file.size)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={handleClick}
              disabled={busy}
              className="shrink-0"
            >
              <RotateCcw aria-hidden="true" className="h-4 w-4" />
              Retake
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          disabled={busy}
          className={cn(
            "flex w-full flex-col items-center justify-center gap-2",
            "rounded-card border-2 border-dashed border-border bg-surface-subtle",
            "px-6 py-10 text-center transition-colors",
            "hover:border-brand-navy hover:bg-surface",
            "disabled:cursor-not-allowed disabled:opacity-60"
          )}
        >
          <Camera aria-hidden="true" className="h-8 w-8 text-text-muted" />
          <span className="font-display text-base font-semibold text-text">
            Take a photo
          </span>
          <span className="text-xs text-text-muted">
            Camera opens by default. You can also choose from gallery.
          </span>
        </button>
      )}

      {hint ? (
        <p className="text-xs text-state-danger" role="alert">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
