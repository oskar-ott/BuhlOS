"use client";

import { Pencil } from "lucide-react";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { lastSuccessfulSend, madeWhen, pdfRowBadge, plural } from "@/domains/itp-simple/model";
import type { ItpPdf, ItpSend } from "@/domains/itp-simple/schema";
import { ItpBadge, ItpPrimaryButton, ItpSecondaryButton } from "./ItpControls";
import { ItpSheet } from "./ItpSheet";

/**
 * PDFs · n (board 12c): one card per PDF, newest first — name (pencil →
 * rename), what's in it, made-at, badge, Open + Send (or Make again when
 * out of date) · Make another PDF.
 */
export function ItpPdfsSheet({
  open,
  onClose,
  pdfs,
  sends,
  areaNamesFor,
  busyPdfId,
  sendBlocker,
  error,
  onRename,
  onSend,
  onMakeAgain,
  onMakeAnother,
}: {
  open: boolean;
  onClose: () => void;
  pdfs: ReadonlyArray<ItpPdf>;
  sends: ReadonlyArray<ItpSend>;
  /** The current names of a PDF's areas, for the "what's in it" line. */
  areaNamesFor: (pdf: ItpPdf) => string;
  busyPdfId: string | null;
  /** Why Send is greyed (pending / failed photos), or null. */
  sendBlocker: string | null;
  error?: string | null;
  onRename: (pdf: ItpPdf) => void;
  onSend: (pdf: ItpPdf) => void;
  onMakeAgain: (pdf: ItpPdf) => void;
  onMakeAnother: () => void;
}) {
  return (
    <ItpSheet open={open} onClose={onClose} title={`PDFs · ${pdfs.length}`} testId="itp-pdfs-sheet">
      {error ? (
        <PhilNotice tone="danger" title="That didn't work" role="alert">
          {error}
        </PhilNotice>
      ) : null}
      {sendBlocker ? (
        <PhilNotice tone="warning" role="status">
          {sendBlocker}
        </PhilNotice>
      ) : null}

      {pdfs.map((pdf) => {
        const sendsForPdf = sends.filter((s) => s.pdfId === pdf.id);
        const last = lastSuccessfulSend(sendsForPdf);
        const badge = pdfRowBadge(pdf, last ? { kind: last.kind, sentAt: last.sentAt } : null);
        const busy = busyPdfId === pdf.id;
        const contents = pdf.nameIsAuto && pdf.name !== "All areas" ? null : areaNamesFor(pdf);
        return (
          <section
            key={pdf.id}
            className="space-y-2 rounded-card border border-border bg-surface p-4"
          >
            <button
              type="button"
              onClick={() => onRename(pdf)}
              aria-label={`Rename ${pdf.name}`}
              className="flex min-h-[44px] w-full items-center gap-2 text-left font-display text-[17px] font-bold text-text focus-visible:outline-brand-navy"
            >
              <span className="line-clamp-2 min-w-0 break-words">{pdf.name}</span>
              <Pencil aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
            </button>
            <p className="text-[14px] font-semibold text-text-muted">
              {contents ? `${contents} · ` : `${plural(pdf.areaCount, "area", "areas")} · `}
              {plural(pdf.photoCount, "photo", "photos")} · made {madeWhen(pdf.madeAt)}
            </p>
            <ItpBadge tone={badge.tone}>{badge.label}</ItpBadge>
            <div className="flex items-center gap-2 pt-1">
              <a
                href={pdf.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-[44px] items-center rounded-card px-2 font-display text-[16px] font-bold text-state-info focus-visible:outline-brand-navy"
              >
                Open
              </a>
              {pdf.stale ? (
                <ItpSecondaryButton
                  size="md"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => onMakeAgain(pdf)}
                >
                  {busy ? "Making the PDF…" : "Make again"}
                </ItpSecondaryButton>
              ) : (
                <ItpSecondaryButton
                  size="md"
                  className="flex-1"
                  disabled={busy || !!sendBlocker}
                  onClick={() => onSend(pdf)}
                >
                  Send
                </ItpSecondaryButton>
              )}
            </div>
          </section>
        );
      })}

      <ItpPrimaryButton onClick={onMakeAnother} disabled={busyPdfId !== null}>
        Make another PDF
      </ItpPrimaryButton>
    </ItpSheet>
  );
}
