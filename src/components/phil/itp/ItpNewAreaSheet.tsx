"use client";

import { useEffect, useId, useRef, useState } from "react";
import { PhilDictateButton } from "@/components/phil/ui/PhilDictateButton";
import {
  ItpChip,
  ItpInput,
  ItpLabel,
  ItpPrimaryButton,
  ItpSecondaryButton,
  ItpSegmented,
  type PhotoSource,
} from "./ItpControls";
import { ItpSheet } from "./ItpSheet";

/**
 * New area sheet (board 5a). Camera / Camera roll · Recent names · Something
 * else (field + dictate + Add area) · divider · No name yet — add photos.
 * Every pick calls `onPick` INSIDE the tap handler so the parent can open
 * the file input before any request returns (iOS blocks it otherwise).
 * The segment resets to Camera every time the sheet opens.
 */
export function ItpNewAreaSheet({
  open,
  onClose,
  recentNames,
  busy = false,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  recentNames: ReadonlyArray<string>;
  busy?: boolean;
  /** name = null → "No name yet" (the parent names it Area n). */
  onPick: (name: string | null, source: PhotoSource) => void;
}) {
  const [source, setSource] = useState<PhotoSource>("camera");
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fieldId = useId();

  useEffect(() => {
    if (open) {
      setSource("camera");
      setName("");
    }
  }, [open]);

  const clean = name.trim();

  return (
    <ItpSheet open={open} onClose={onClose} title="New area" testId="itp-new-area-sheet">
      <ItpSegmented value={source} onChange={setSource} disabled={busy} />

      {recentNames.length ? (
        <div>
          <ItpLabel className="mb-2">Recent names</ItpLabel>
          <div className="flex flex-wrap gap-2">
            {recentNames.map((n) => (
              <ItpChip key={n} disabled={busy} onClick={() => onPick(n, source)}>
                {n}
              </ItpChip>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <ItpLabel htmlFor={fieldId}>Something else</ItpLabel>
        <ItpInput
          id={fieldId}
          ref={inputRef}
          value={name}
          maxLength={120}
          placeholder="Say or type a name"
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && clean) onPick(clean, source);
          }}
        />
        <PhilDictateButton
          value={name}
          onAppend={setName}
          max={120}
          disabled={busy}
          onFocusField={() => inputRef.current?.focus()}
        />
        <ItpSecondaryButton disabled={!clean || busy} onClick={() => onPick(clean, source)}>
          Add area
        </ItpSecondaryButton>
      </div>

      <div className="border-t border-border pt-4">
        <ItpPrimaryButton disabled={busy} onClick={() => onPick(null, source)}>
          No name yet — add photos
        </ItpPrimaryButton>
        <p className="mt-2 text-[14px] font-semibold text-text-muted">
          {source === "roll"
            ? "Every option opens the camera roll, as picked above."
            : "Every option opens the camera."}
        </p>
      </div>
    </ItpSheet>
  );
}
