"use client";

import { useEffect, useId, useRef, useState } from "react";
import { PhilDictateButton } from "@/components/phil/ui/PhilDictateButton";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { madeWhen, plural } from "@/domains/itp-simple/model";
import type { ItpPdf } from "@/domains/itp-simple/schema";
import { ItpInput, ItpLabel, ItpPrimaryButton, ItpTextButton } from "./ItpControls";
import { ItpSheet } from "./ItpSheet";

/**
 * Rename PDF (board 12f): Name + dictate · "Shows on the PDF, its file name
 * and the email subject." · Save name · Go back to the area names. An empty
 * name saves as the area names too.
 */
export function ItpRenamePdfSheet({
  open,
  onClose,
  onBack,
  pdf,
  busy = false,
  error,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  onBack: () => void;
  pdf: ItpPdf | null;
  busy?: boolean;
  error?: string | null;
  /** name = null → back to the area names. */
  onSave: (name: string | null) => void;
}) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fieldId = useId();
  useEffect(() => {
    if (open && pdf) setName(pdf.nameIsAuto ? "" : pdf.name);
  }, [open, pdf]);

  if (!pdf) return null;
  const clean = name.trim();

  return (
    <ItpSheet
      open={open}
      onClose={onClose}
      back={{ label: "PDFs", onClick: onBack }}
      title="Rename PDF"
      subtitle={`${plural(pdf.areaCount, "area", "areas")} · ${plural(pdf.photoCount, "photo", "photos")} · made ${madeWhen(pdf.madeAt)}`}
      testId="itp-rename-pdf-sheet"
    >
      {error ? (
        <PhilNotice tone="danger" title="Couldn't rename it" role="alert">
          {error}
        </PhilNotice>
      ) : null}
      <div className="space-y-2">
        <ItpLabel htmlFor={fieldId}>Name</ItpLabel>
        <ItpInput
          id={fieldId}
          ref={inputRef}
          value={name}
          maxLength={120}
          placeholder={pdf.nameIsAuto ? pdf.name : "PDF name"}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
        <PhilDictateButton
          value={name}
          onAppend={setName}
          max={120}
          disabled={busy}
          onFocusField={() => inputRef.current?.focus()}
        />
        <p className="text-[14px] font-semibold text-text-muted">
          Shows on the PDF, its file name and the email subject.
        </p>
      </div>
      <ItpPrimaryButton disabled={busy} onClick={() => onSave(clean || null)}>
        {busy ? "Saving…" : "Save name"}
      </ItpPrimaryButton>
      {!pdf.nameIsAuto ? (
        <ItpTextButton disabled={busy} onClick={() => onSave(null)} className="w-full">
          Go back to the area names
        </ItpTextButton>
      ) : null}
    </ItpSheet>
  );
}
