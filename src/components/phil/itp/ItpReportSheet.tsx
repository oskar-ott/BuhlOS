"use client";

import { useEffect, useId, useState } from "react";
import { madeWhen, plural } from "@/domains/itp-simple/model";
import type { ItpSend } from "@/domains/itp-simple/schema";
import { ItpDangerZone } from "./ItpDangerZone";
import { ItpInput, ItpLabel, ItpSecondaryButton } from "./ItpControls";
import { ItpSheet } from "./ItpSheet";

/**
 * ITP sheet (board 5d): Name + Save name · Sent list (who, when) · danger:
 * Delete this ITP ("Deletes all 4 areas and 12 photos."). Opens from the
 * page title.
 */
export function ItpReportSheet({
  open,
  onClose,
  title,
  areaCount,
  photoCount,
  sends,
  busy = false,
  armed,
  onArm,
  onKeep,
  onRename,
  onDelete,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  areaCount: number;
  photoCount: number;
  sends: ReadonlyArray<ItpSend>;
  busy?: boolean;
  armed: boolean;
  onArm: () => void;
  onKeep: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState("");
  const fieldId = useId();
  useEffect(() => {
    if (open) setName(title);
  }, [open, title]);

  const clean = name.trim();
  const changed = clean.length > 0 && clean !== title;
  const sent = sends.filter((s) => s.result === "sent");

  return (
    <ItpSheet open={open} onClose={onClose} title="This ITP" testId="itp-report-sheet">
      <div className="space-y-2">
        <ItpLabel htmlFor={fieldId}>Name</ItpLabel>
        <ItpInput
          id={fieldId}
          value={name}
          maxLength={120}
          placeholder="ITP name"
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

      {sent.length ? (
        <div>
          <ItpLabel className="mb-1">Sent</ItpLabel>
          <ul className="divide-y divide-border rounded-card border border-border bg-surface-subtle">
            {sent.map((s) => (
              <li
                key={s.id}
                className="flex min-h-[48px] items-center justify-between gap-3 px-3 py-2 text-[15px]"
              >
                <span className="min-w-0 truncate font-semibold text-text">
                  {s.kind === "office" ? "Office" : s.recipient}
                </span>
                <span className="shrink-0 text-text-muted">{madeWhen(s.sentAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <ItpDangerZone
        label="Delete this ITP"
        armedLabel="Tap again to delete"
        consequence={`Deletes all ${plural(areaCount, "area", "areas")} and ${plural(photoCount, "photo", "photos")}.`}
        armed={armed}
        busy={busy}
        onArm={onArm}
        onConfirm={onDelete}
        onKeep={onKeep}
      />
    </ItpSheet>
  );
}
