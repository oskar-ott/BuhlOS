"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { countsLine, defaultPdfName, makePdfBlocker, plural } from "@/domains/itp-simple/model";
import { cn } from "@/lib/cn";
import { ItpInput, ItpLabel, ItpPrimaryButton } from "./ItpControls";
import { ItpSheet } from "./ItpSheet";

export interface MakePdfArea {
  id: string;
  name: string;
  photoCount: number;
}

/**
 * Make a PDF (board 12a/b/e): All areas + one checkbox row per area (all
 * ticked on open) · "In this PDF: n areas · n photos" · Name — optional
 * (prefilled from the ticks, follows them until typed over) · Make PDF.
 * Over the 120 cap: a warning notice + the button greys; the count updates
 * live as rows are ticked. Nothing ticked: "Tick at least one area."
 */
export function ItpMakePdfSheet({
  open,
  onClose,
  areas,
  busy = false,
  error,
  onMake,
}: {
  open: boolean;
  onClose: () => void;
  areas: ReadonlyArray<MakePdfArea>;
  busy?: boolean;
  error?: string | null;
  onMake: (input: { areaIds: string[]; name: string | null }) => void;
}) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [typed, setTyped] = useState<string | null>(null);
  const nameId = useId();

  useEffect(() => {
    if (open) {
      setTicked(new Set(areas.map((a) => a.id)));
      setTyped(null);
    }
    // Reset only on open; a refetch mid-sheet must not untick rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const selected = useMemo(() => areas.filter((a) => ticked.has(a.id)), [areas, ticked]);
  const allOn = selected.length === areas.length && areas.length > 0;
  const autoName = defaultPdfName(selected, areas.length);
  const name = typed ?? autoName;
  const blocker = makePdfBlocker(selected);
  const totalPhotos = areas.reduce((n, a) => n + a.photoCount, 0);
  const selectedPhotos = selected.reduce((n, a) => n + a.photoCount, 0);

  function toggle(id: string) {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const rowClass =
    "flex min-h-[56px] cursor-pointer items-center gap-3 px-3 py-2 text-[16px] font-semibold";

  return (
    <ItpSheet open={open} onClose={onClose} title="Make a PDF" testId="itp-make-pdf-sheet">
      {blocker && selected.length ? (
        <PhilNotice tone="warning" title={blocker.split(". ")[0]} role="alert">
          {blocker.split(". ").slice(1).join(". ")}
        </PhilNotice>
      ) : null}
      {error ? (
        <PhilNotice tone="danger" title="Couldn't make the PDF" role="alert">
          {error}
        </PhilNotice>
      ) : null}

      <div className="divide-y divide-border rounded-card border border-border bg-surface">
        <label className={cn(rowClass, "border-b border-border-strong")}>
          <input
            type="checkbox"
            className="h-6 w-6 shrink-0 accent-brand-navy"
            checked={allOn}
            disabled={busy || !areas.length}
            onChange={(e) =>
              setTicked(e.target.checked ? new Set(areas.map((a) => a.id)) : new Set())
            }
          />
          <span className="flex-1">All areas</span>
          <span className="text-[14px] text-text-muted">
            {plural(totalPhotos, "photo", "photos")}
          </span>
        </label>
        {areas.map((a) => (
          <label key={a.id} className={rowClass}>
            <input
              type="checkbox"
              className="h-6 w-6 shrink-0 accent-brand-navy"
              checked={ticked.has(a.id)}
              disabled={busy}
              onChange={() => toggle(a.id)}
            />
            <span className="line-clamp-2 flex-1 break-words">{a.name}</span>
            <span className="shrink-0 text-[14px] text-text-muted">
              {plural(a.photoCount, "photo", "photos")}
            </span>
          </label>
        ))}
      </div>

      <p className="text-[16px] font-semibold text-text">
        <span className="text-text-muted">In this PDF</span>{" "}
        {countsLine(selected.length, selectedPhotos)}
      </p>

      <div className="space-y-2">
        <ItpLabel htmlFor={nameId}>Name — optional</ItpLabel>
        <ItpInput
          id={nameId}
          value={name}
          maxLength={120}
          placeholder="PDF name"
          disabled={busy}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>

      <ItpPrimaryButton
        disabled={!!blocker || busy}
        onClick={() =>
          onMake({
            areaIds: selected.map((a) => a.id),
            name: typed != null && typed.trim() && typed.trim() !== autoName ? typed.trim() : null,
          })
        }
      >
        {busy ? "Making the PDF…" : "Make PDF"}
      </ItpPrimaryButton>
      {blocker && !selected.length ? (
        <p className="text-[14px] font-semibold text-text-muted">{blocker}</p>
      ) : null}
    </ItpSheet>
  );
}
