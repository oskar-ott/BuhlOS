"use client";

import { useState } from "react";
import { Check, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { formatHoursLabel } from "@/domains/timesheets/format";

/**
 * Send-to-accounts card (owner pull 2026-08-15) — the pay-run handoff while
 * the Xero push is out of action: email the approved-hours PDF (the exact
 * document Download PDF serves) to Tia at accounts, from timesheets@buhlos.com
 * (api/time-entries-email.js).
 *
 * The page renders this ONLY when TIMESHEETS_EMAIL_TO is set — that env var is
 * the switch for the whole interim process; unset it and Xero's surfaces get
 * their slot back.
 *
 * Two-step confirm: an email to accounts is an outward-facing send, so no
 * single misclick can fire it. A not-closed period WARNS inside the confirm
 * (approved hours only go in the PDF) but never blocks — same philosophy as
 * the downloads card. Sending stamps nothing (ADR #609); a re-send just emails
 * the sheet again.
 */

interface SentReceipt {
  to: string;
  workerCount: number;
  totalHours: number;
}

type Phase =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "sending" }
  | { kind: "sent"; receipt: SentReceipt }
  | { kind: "error"; message: string };

interface Props {
  fromDate: string;
  toDate: string;
  /** The page's own range label, e.g. "11 Aug – 17 Aug". */
  periodLabel: string;
  /** The period still has undecided days — warn in the confirm, never block. */
  notClosed: boolean;
  workersNeedingAction: number;
}

export function SendTimesheetsCard({
  fromDate,
  toDate,
  periodLabel,
  notClosed,
  workersNeedingAction,
}: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const send = async () => {
    setPhase({ kind: "sending" });
    try {
      const res = await fetch("/api/time-entries-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromDate, toDate }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setPhase({
          kind: "error",
          message: data?.error || `The send failed (${res.status}) — nothing was emailed.`,
        });
        return;
      }
      setPhase({
        kind: "sent",
        receipt: {
          to: String(data?.to || "accounts"),
          workerCount: Number(data?.workerCount) || 0,
          totalHours: Number(data?.totalHours) || 0,
        },
      });
    } catch {
      setPhase({
        kind: "error",
        message: "Couldn't reach the server — nothing was emailed. Check the connection and try again.",
      });
    }
  };

  return (
    <Card>
      <CardTitle>Send to Tia</CardTitle>
      <CardDescription className="mt-1">
        Email the approved-hours PDF for this period straight to Tia at accounts, sent from
        timesheets@buhlos.com — the pay-run handoff while Xero is out of action. Approved hours
        only; it&rsquo;s the same sheet as Download PDF below.
      </CardDescription>

      {phase.kind === "sent" ? (
        <p
          data-testid="period-send-receipt"
          className="mt-3 flex items-start gap-2 rounded-card border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
          role="status"
        >
          <Check aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Sent — {phase.receipt.workerCount}{" "}
            {phase.receipt.workerCount === 1 ? "worker" : "workers"},{" "}
            {formatHoursLabel(phase.receipt.totalHours)} emailed to{" "}
            <b className="font-semibold">{phase.receipt.to}</b>.
          </span>
        </p>
      ) : null}

      {phase.kind === "error" ? (
        <p
          className="mt-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900"
          role="status"
        >
          {phase.message}
        </p>
      ) : null}

      {phase.kind === "confirm" ? (
        <div className="mt-3 rounded-card border border-border bg-surface-subtle p-3">
          <p className="text-sm text-text">
            Email the approved-hours PDF for <b className="font-semibold">{periodLabel}</b> to Tia?
          </p>
          {notClosed ? (
            <p className="mt-2 text-xs text-amber-900">
              {workersNeedingAction} worker(s) still have undecided days in this period — those
              days won&rsquo;t be in the PDF. You can send now and send again once they&rsquo;re
              decided.
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button data-testid="period-send-confirm" onClick={send}>
              <Mail aria-hidden="true" className="h-4 w-4" />
              Yes, email it
            </Button>
            <Button variant="secondary" onClick={() => setPhase({ kind: "idle" })}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3">
          <Button
            data-testid="period-send-accounts"
            onClick={() => setPhase({ kind: "confirm" })}
            disabled={phase.kind === "sending"}
          >
            {phase.kind === "sending" ? (
              <>
                <Loader2
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                />
                Emailing…
              </>
            ) : (
              <>
                <Mail aria-hidden="true" className="h-4 w-4" />
                {phase.kind === "sent" ? "Send again" : "Send to Tia"}
              </>
            )}
          </Button>
        </div>
      )}
    </Card>
  );
}
