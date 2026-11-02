"use client";

import { useEffect, useId, useRef, useState } from "react";
import { PhilDictateButton } from "@/components/phil/ui/PhilDictateButton";
import type { ItpPhoto } from "@/domains/itp-simple/schema";
import { ItpDangerZone } from "./ItpDangerZone";
import { ItpInput, ItpLabel, ItpSecondaryButton } from "./ItpControls";
import { ItpSheet } from "./ItpSheet";

/**
 * Photo sheet (board 5c): the photo full width · Caption — prints under the
 * photo (+ dictate, Save caption) · danger: Remove photo. Opens by tapping a
 * saved tile — the ✕ is gone from the grid.
 */
export function ItpPhotoSheet({
  open,
  onClose,
  photo,
  areaName,
  index,
  total,
  busy = false,
  armed,
  onArm,
  onKeep,
  onSaveCaption,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  photo: ItpPhoto | null;
  areaName: string;
  index: number;
  total: number;
  busy?: boolean;
  armed: boolean;
  onArm: () => void;
  onKeep: () => void;
  onSaveCaption: (caption: string) => void;
  onRemove: () => void;
}) {
  const [caption, setCaption] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fieldId = useId();
  useEffect(() => {
    if (open && photo) setCaption(photo.caption);
  }, [open, photo]);

  if (!photo) return null;
  const clean = caption.trim();
  const changed = clean !== photo.caption.trim();

  return (
    <ItpSheet
      open={open}
      onClose={onClose}
      title={areaName}
      subtitle={`photo ${index} of ${total}`}
      testId="itp-photo-sheet"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo.url}
        alt={photo.caption || `Photo ${index} of ${total} in ${areaName}`}
        className="w-full rounded-card border border-border bg-surface-subtle object-contain"
      />

      <div className="space-y-2">
        <ItpLabel htmlFor={fieldId}>Caption — prints under the photo</ItpLabel>
        <ItpInput
          id={fieldId}
          ref={inputRef}
          value={caption}
          maxLength={200}
          placeholder="e.g. Cable run above ceiling, north side"
          disabled={busy}
          onChange={(e) => setCaption(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && changed) onSaveCaption(clean);
          }}
        />
        <PhilDictateButton
          value={caption}
          onAppend={setCaption}
          max={200}
          disabled={busy}
          onFocusField={() => inputRef.current?.focus()}
        />
        <ItpSecondaryButton disabled={!changed || busy} onClick={() => onSaveCaption(clean)}>
          Save caption
        </ItpSecondaryButton>
      </div>

      <ItpDangerZone
        label="Remove photo"
        armedLabel="Tap again to remove this photo"
        consequence="It goes from this ITP."
        armed={armed}
        busy={busy}
        onArm={onArm}
        onConfirm={onRemove}
        onKeep={onKeep}
      />
    </ItpSheet>
  );
}
