"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Building2, Download, Mail } from "lucide-react";
import { PhilDictateButton } from "@/components/phil/ui/PhilDictateButton";
import { PhilNotice } from "@/components/phil/ui/PhilNotice";
import { countsLine, isEmailAddress, shortWhen } from "@/domains/itp-simple/model";
import type { ItpPdf } from "@/domains/itp-simple/schema";
import { cn } from "@/lib/cn";
import { ItpChip, ItpInput, ItpLabel, ItpPrimaryButton, ItpSecondaryButton } from "./ItpControls";
import { ItpSheet } from "./ItpSheet";

export type SendPhase =
  | { kind: "idle" }
  | { kind: "making"; target: "office" | "email" | "save" }
  | { kind: "sending"; target: "office" | "email" }
  | { kind: "saving" };

export interface SendError {
  title: string;
  body: string;
  retry: "office" | "email" | null;
}

/**
 * Send this ITP (board 11): PDF row (name, contents, Open) · Send to office
 * (office@…) · Email it (From reports@buhlos.com) · Save PDF to phone. A
 * stale PDF shows the "Photos changed since this PDF" notice and gets made
 * again before it goes; while that runs the chosen button reads "Making the
 * PDF…", then "Sending…". With any photo pending or failed all three grey
 * out and the blocker says why. Email it is a second view inside the same
 * sheet (back = Send): Used on this job chips · To · Note — optional.
 */
export function ItpSendSheet({
  open,
  onClose,
  pdf,
  officeEmail,
  emailSuggestions,
  blocker,
  phase,
  error,
  onSendOffice,
  onSendEmail,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  pdf: ItpPdf | null;
  /** null = not set up → Send to office hidden. */
  officeEmail: string | null;
  emailSuggestions: ReadonlyArray<string>;
  blocker: string | null;
  phase: SendPhase;
  error: SendError | null;
  onSendOffice: () => void;
  onSendEmail: (email: string, note: string) => void;
  onSave: () => void;
}) {
  const [view, setView] = useState<"send" | "email">("send");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLInputElement | null>(null);
  const toId = useId();
  const noteId = useId();

  useEffect(() => {
    if (open) {
      setView("send");
      setEmail("");
      setNote("");
    }
  }, [open]);

  if (!pdf) return null;
  const busy = phase.kind !== "idle";
  const disabled = busy || !!blocker;
  const emailOk = isEmailAddress(email);

  function label(target: "office" | "email" | "save", idle: string): string {
    if (phase.kind === "making" && phase.target === target) return "Making the PDF…";
    if (phase.kind === "sending" && phase.target === target) return "Sending…";
    if (phase.kind === "saving" && target === "save") return "Making the PDF…";
    return idle;
  }

  const two = (main: string, sub: string) => (
    <span className="flex min-w-0 flex-col text-left leading-tight">
      <span>{main}</span>
      <span className="text-[14px] font-semibold opacity-85">{sub}</span>
    </span>
  );

  if (view === "email") {
    return (
      <ItpSheet
        open={open}
        onClose={onClose}
        back={{ label: "Send", onClick: () => setView("send") }}
        title="Email it"
        testId="itp-email-sheet"
      >
        {error && error.retry === "email" ? (
          <PhilNotice tone="danger" title={error.title} role="alert">
            {error.body}
          </PhilNotice>
        ) : null}
        {emailSuggestions.length ? (
          <div>
            <ItpLabel className="mb-2">Used on this job</ItpLabel>
            <div className="flex flex-wrap gap-2">
              {emailSuggestions.map((addr) => (
                <ItpChip
                  key={addr}
                  selected={email === addr}
                  disabled={busy}
                  onClick={() => setEmail(addr)}
                >
                  {addr}
                </ItpChip>
              ))}
            </div>
          </div>
        ) : null}
        <div className="space-y-2">
          <ItpLabel htmlFor={toId}>To</ItpLabel>
          <ItpInput
            id={toId}
            type="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            value={email}
            placeholder="name@company.com.au"
            disabled={busy}
            onChange={(e) => setEmail(e.target.value)}
          />
          {email.trim() && !emailOk ? (
            <p className="text-[14px] font-semibold text-state-danger-subtle-text" role="status">
              That doesn&rsquo;t look like an email address.
            </p>
          ) : null}
        </div>
        <div className="space-y-2">
          <ItpLabel htmlFor={noteId}>Note — optional</ItpLabel>
          <ItpInput
            id={noteId}
            ref={noteRef}
            value={note}
            maxLength={1000}
            placeholder="e.g. Rough-in done, ready for inspection"
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
          <PhilDictateButton
            value={note}
            onAppend={setNote}
            max={1000}
            disabled={busy}
            onFocusField={() => noteRef.current?.focus()}
          />
        </div>
        <p className="rounded-[10px] bg-surface-subtle px-3 py-2.5 text-[15px] leading-snug text-text">
          Comes from <b>reports@buhlos.com</b> with the PDF attached. Replies go to the office.
        </p>
        <ItpPrimaryButton
          disabled={disabled || !emailOk}
          onClick={() => onSendEmail(email.trim(), note.trim())}
        >
          {label("email", "Send email")}
        </ItpPrimaryButton>
      </ItpSheet>
    );
  }

  return (
    <ItpSheet open={open} onClose={onClose} title="Send this ITP" testId="itp-send-sheet">
      {error && error.retry !== "email" ? (
        <PhilNotice tone="danger" title={error.title} role="alert">
          {error.body}
        </PhilNotice>
      ) : null}
      {blocker ? (
        <PhilNotice tone="warning" role="status">
          {blocker}
        </PhilNotice>
      ) : null}
      {pdf.stale && !blocker ? (
        <PhilNotice tone="warning" title="Photos changed since this PDF" role="status">
          It gets made again before it goes, so they get the lot.
        </PhilNotice>
      ) : null}

      <div className="flex items-center gap-3 rounded-card border border-border bg-surface-subtle p-3">
        <span
          aria-hidden="true"
          className="flex h-[52px] w-[44px] shrink-0 items-center justify-center rounded-[6px] border border-border-strong bg-surface text-[12px] font-extrabold text-state-danger"
        >
          PDF
        </span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 break-words text-[16px] font-bold text-text">{pdf.name}</p>
          <p className="text-[14px] font-semibold text-text-muted">
            {countsLine(pdf.areaCount, pdf.photoCount)} · made {shortWhen(pdf.madeAt)}
          </p>
        </div>
        <a
          href={pdf.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-h-[44px] shrink-0 items-center px-1.5 font-display text-[16px] font-bold text-state-info focus-visible:outline-brand-navy"
        >
          Open
        </a>
      </div>

      {error && error.retry === "office" ? (
        <ItpPrimaryButton disabled={disabled} onClick={onSendOffice}>
          {label("office", "Try again")}
        </ItpPrimaryButton>
      ) : officeEmail ? (
        <ItpPrimaryButton
          disabled={disabled}
          onClick={onSendOffice}
          className={cn("justify-start")}
        >
          <Building2 aria-hidden="true" className="h-6 w-6 shrink-0" />
          {two(label("office", "Send to office"), officeEmail)}
        </ItpPrimaryButton>
      ) : null}

      <ItpSecondaryButton
        disabled={disabled}
        onClick={() => setView("email")}
        className="justify-start"
      >
        <Mail aria-hidden="true" className="h-6 w-6 shrink-0" />
        {two(label("email", "Email it"), "From reports@buhlos.com")}
      </ItpSecondaryButton>

      <ItpSecondaryButton disabled={disabled} onClick={onSave} className="justify-start">
        <Download aria-hidden="true" className="h-6 w-6 shrink-0" />
        {two(
          label("save", "Save PDF to phone"),
          pdf.stale ? "Made again first" : "Files, Drive, or share it your way"
        )}
      </ItpSecondaryButton>
    </ItpSheet>
  );
}
