"use client";

import { useEffect, useId, useState } from "react";
import { Images } from "lucide-react";
import { plural } from "@/domains/itp-simple/model";
import { ItpDangerZone } from "./ItpDangerZone";
import { ItpInput, ItpLabel, ItpSecondaryButton } from "./ItpControls";
import { ItpSheet } from "./ItpSheet";

/**
 * Area sheet (board 5b): "Kitchen · 3 photos" · Add from camera roll · Name
 * + Save name · danger: Remove area ("Removes Kitchen and its 3 photos from
 * this ITP."). Opens from the area name on the card.
 */
export function ItpAreaSheet({
  open,
  onClose,
  area,
  busy = false,
  armed,
  onArm,
  onKeep,
  onAddFromRoll,
  onRename,
  onRemove,
}: {
  open: boolean;
  onClose: () => void;
  area: { id: string; name: string; photoCount: number } | null;
  busy?: boolean;
  armed: boolean;
  onArm: () => void;
  onKeep: () => void;
  /** Called inside the tap handler — the parent opens the roll picker. */
  onAddFromRoll: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const [name, setName] = useState("");
  const fieldId = useId();
  useEffect(() => {
    if (open && area) setName(area.name);
  }, [open, area]);

  if (!area) return null;
  const clean = name.trim();
  const changed = clean.length > 0 && clean !== area.name;
  const photos = plural(area.photoCount, "photo", "photos");

  return (
    <ItpSheet
      open={open}
      onClose={onClose}
      title={area.name}
      subtitle={photos}
      testId="itp-area-sheet"
    >
      <ItpSecondaryButton disabled={busy} onClick={onAddFromRoll}>
        <Images aria-hidden="true" className="h-5 w-5" />
        Add from camera roll
      </ItpSecondaryButton>

      <div className="space-y-2">
        <ItpLabel htmlFor={fieldId}>Name</ItpLabel>
        <ItpInput
          id={fieldId}
          value={name}
          maxLength={120}
          placeholder="Area name"
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && changed) onRename(clean);
          }}
        />
        <ItpSecondaryButton disabled={!changed || busy} onClick={() => onRename(clean)}>
          Save name
        </ItpSecondaryButton>
      </div>

      <ItpDangerZone
        label="Remove area"
        armedLabel={`Tap again to remove ${area.name}`}
        consequence={`Removes ${area.name} and its ${photos} from this ITP.`}
        armedConsequence={`${area.name} and its ${photos} go from this ITP.`}
        armed={armed}
        busy={busy}
        onArm={onArm}
        onConfirm={onRemove}
        onKeep={onKeep}
      />
    </ItpSheet>
  );
}
