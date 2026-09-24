"use client";

import { useCallback, useEffect, useState } from "react";
import { Camera, ReceiptText, X } from "lucide-react";
import { PhilActionButton } from "./ui/PhilActionButton";
import { PhilNotice } from "./ui/PhilNotice";
import { resizeImageToDataUrl } from "@/domains/evidence/service";
import { receiptOutcomeText, submitReceipt, type ReceiptResult } from "@/domains/invoices/receipt-client";

/**
 * My Day — "Log a receipt" (receipt_capture, owner pull 2026-09-25).
 *
 * Enters the EXISTING Quick grid slot (P10 — no new section): a card
 * purchase at Bunnings or a trade counter, recorded where it happens (P13).
 * The common path is photo → send (P6): the job defaults to the worker's only
 * job, and the photo is read on the server, so no typing. The worker is told
 * exactly what was read — or that the office will check (P7); a failed send
 * keeps the photo in the sheet so nothing is lost (P8).
 *
 * Self-contained: owns the sheet and the result notice (the outcome must
 * survive the sheet closing). The notice spans both grid columns.
 */
export interface PhilReceiptJob {
  id: string;
  name: string;
  code?: string | null;
}

export function PhilReceiptEntry({
  jobs,
  defaultJobId,
  tileClassName,
}: {
  jobs: ReadonlyArray<PhilReceiptJob>;
  defaultJobId: string | null;
  tileClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<ReceiptResult | null>(null);
  const outcome = result ? receiptOutcomeText(result) : null;

  return (
    <>
      <button
        type="button"
        className={tileClassName}
        data-testid="phil-my-day-receipt"
        onClick={() => {
          setResult(null);
          setOpen(true);
        }}
      >
        <span className="inline-flex h-9 w-9 items-center justify-center rounded-[10px] bg-surface-subtle text-brand-navy">
          <ReceiptText className="h-[18px] w-[18px]" aria-hidden="true" />
        </span>
        <span className="text-sm font-semibold leading-tight text-text">Log a receipt</span>
        <span className="text-xs leading-tight text-text-muted">Paid by card? Snap it</span>
      </button>

      {outcome ? (
        <div className="col-span-2" data-testid="phil-receipt-outcome">
          <PhilNotice tone={outcome.tone} role="status" title={outcome.title}>
            <p>{outcome.body}</p>
          </PhilNotice>
        </div>
      ) : null}

      {open ? (
        <ReceiptSheet
          jobs={jobs}
          defaultJobId={defaultJobId}
          onClose={() => setOpen(false)}
          onSent={(r) => {
            setResult(r);
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}

function ReceiptSheet({
  jobs,
  defaultJobId,
  onClose,
  onSent,
}: {
  jobs: ReadonlyArray<PhilReceiptJob>;
  defaultJobId: string | null;
  onClose: () => void;
  onSent: (r: ReceiptResult) => void;
}) {
  const [photo, setPhoto] = useState<{ status: "none" | "resizing" } | { status: "ready"; dataUrl: string; name: string }>({ status: "none" });
  const [jobId, setJobId] = useState<string>(defaultJobId ?? (jobs.length === 1 ? jobs[0]!.id : ""));
  const [ownMoney, setOwnMoney] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const onPick = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPhoto({ status: "resizing" });
    try {
      // ≤1600 px JPEG: legible for reading, small enough for a site signal.
      const dataUrl = await resizeImageToDataUrl(file, 1600, 0.8);
      setPhoto({ status: "ready", dataUrl, name: file.name || "receipt.jpg" });
    } catch {
      setPhoto({ status: "none" });
      setError("Couldn't open that photo — take it again.");
    }
  }, []);

  const canSend = !busy && photo.status === "ready" && jobId !== "";

  const send = useCallback(async () => {
    if (photo.status !== "ready" || !jobId || busy) return;
    setBusy(true);
    setError(null);
    const r = await submitReceipt({ jobId, filename: photo.name, dataUrl: photo.dataUrl, paidPersonally: ownMoney });
    setBusy(false);
    if (r.ok) {
      onSent(r.data);
      return;
    }
    const code = (r.error.body as { error?: string } | null)?.error;
    setError(
      r.error.status === 0
        ? "No signal — nothing was sent. Your photo is still here; try again when you've got signal."
        : code === "job_not_available"
          ? "That job isn't open any more — pick another."
          : code === "file_too_large"
            ? "That photo is too big — take it again a bit further back."
            : "Couldn't send it — your photo is still here. Try again."
    );
  }, [photo, jobId, busy, ownMoney, onSent]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Log a receipt" className="fixed inset-0 z-50 flex items-stretch justify-center bg-accent-ink/40">
      <div className="flex h-full w-full flex-col bg-surface sm:my-6 sm:h-auto sm:max-w-lg sm:rounded-card sm:shadow-raised">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <ReceiptText aria-hidden="true" className="h-5 w-5 text-brand-navy" />
            <h2 className="font-display text-lg text-text">Log a receipt</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="inline-flex h-11 w-11 items-center justify-center rounded-card text-text-muted hover:bg-surface-subtle disabled:opacity-50"
            aria-label="Close"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          <div>
            <p className="font-display text-sm font-semibold text-text">Photo of the receipt</p>
            <div className="mt-1.5">
              {photo.status === "ready" ? (
                <div className="flex items-center gap-3">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local data: preview */}
                  <img src={photo.dataUrl} alt="Receipt preview" className="h-24 w-24 rounded-card border border-border object-cover" />
                  <label className="inline-flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-brand-navy">
                    Retake
                    <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => void onPick(e.target.files?.[0])} />
                  </label>
                </div>
              ) : (
                <label
                  className={`flex h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-border text-text-muted${photo.status === "resizing" ? " opacity-60" : ""}`}
                  data-testid="phil-receipt-photo"
                >
                  <Camera aria-hidden="true" className="h-8 w-8" />
                  <span className="text-sm font-semibold">{photo.status === "resizing" ? "Opening photo…" : "Take a photo of the receipt"}</span>
                  <span className="text-xs">Flat, in good light, the whole receipt in frame</span>
                  <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => void onPick(e.target.files?.[0])} />
                </label>
              )}
            </div>
          </div>

          <label className="block">
            <span className="font-display text-sm font-semibold text-text">Which job?</span>
            <select
              value={jobId}
              onChange={(e) => setJobId(e.target.value)}
              className="mt-1.5 h-12 w-full rounded-card border border-border bg-surface px-3 text-base text-text"
              data-testid="phil-receipt-job"
            >
              <option value="" disabled>
                Pick the job
              </option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.code ? `${j.code} · ${j.name}` : j.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-h-[48px] cursor-pointer items-center gap-3 rounded-card border border-border px-3">
            <input type="checkbox" checked={ownMoney} onChange={(e) => setOwnMoney(e.target.checked)} className="h-5 w-5" data-testid="phil-receipt-own-money" />
            <span className="text-sm text-text">I paid with my own money</span>
          </label>

          {error ? (
            <PhilNotice tone="danger" role="alert">
              {error}
            </PhilNotice>
          ) : null}
        </div>

        <footer className="border-t border-border px-4 py-3">
          <PhilActionButton size="lg" disabled={!canSend} onClick={() => void send()} aria-busy={busy} data-testid="phil-receipt-send">
            {busy ? "Reading the receipt…" : "Send receipt"}
          </PhilActionButton>
          {busy ? <p className="mt-2 text-center text-xs text-text-muted">This can take up to half a minute.</p> : null}
        </footer>
      </div>
    </div>
  );
}
