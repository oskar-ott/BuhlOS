"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  outstandingWeekLabel,
  type OutstandingWeek,
} from "@/domains/timesheets/weekly-review";
import { buildReviewPlan, type ReviewCandidate } from "@/domains/timesheets/xero-closeout";
import {
  FinaleShell,
  Notice,
  PushRowList,
  ReceiptRow,
  ReviewedMark,
} from "@/components/admin/WeeklyCloseoutXeroFinale";

/**
 * WeeklyCloseoutSendFinale (owner pull 2026-08-15) — the closeout's last
 * screen while the Xero push is out of action: instead of draft timesheets,
 * the approved week goes to Tia at accounts as an emailed PDF
 * (api/time-entries-email.js — the same sheet as Download PDF on desktop).
 *
 * Takes the Xero finale's slot whenever gate.accountsConfigured
 * (TIMESHEETS_EMAIL_TO set) — the branch lives in WeeklyHoursApprovalMobile's
 * review sheet. Same honesty rules as the Xero finale:
 * - Opening this screen writes nothing; the list is the approved hours the
 *   boss just reviewed (buildReviewPlan with no validation — no Xero calls).
 * - Emailing stamps nothing (ADR #609) — a re-send just emails again.
 * - The receipt quotes the SERVER's numbers, never a local guess; a failed
 *   send says so and stays on this screen for a retry.
 */

type Stage = "review" | "sending" | "sent";

interface SentReceipt {
  recipients: string[];
  workerCount: number;
  totalHours: number;
  sentAtLabel: string;
}

interface Props {
  /** ISO YYYY-MM-DD — the closeout week, sent verbatim to the endpoint. */
  weekStart: string;
  weekEnd: string;
  /** Human period label, e.g. "Mon 20 May – Sun 26 May". Display only. */
  periodLabel: string;
  /** How many workers the boss just stepped through. */
  reviewedCount: number;
  /** Approved hours per worker, already computed for the crew cards. */
  candidates: ReviewCandidate[];
  /**
   * What's still to come in across the WHOLE week (owner pull 2026-08-16):
   * days sent back for a fix, days not yet reviewed, days never sent in.
   * total > 0 flips the footer to lead with "Wait for the full week" — the
   * boss who just rejected days shouldn't email a sheet those days will miss.
   * Send stays available (demoted): the interim email stamps nothing and a
   * re-send is safe, so sending early is a judgement call, not an error.
   */
  outstanding?: OutstandingWeek;
  onClose: () => void;
  /** Raised while the send is in flight so the sheet can't be dismissed under it. */
  onBusyChange?: (busy: boolean) => void;
}

export function WeeklyCloseoutSendFinale({
  weekStart,
  weekEnd,
  periodLabel,
  reviewedCount,
  candidates,
  outstanding,
  onClose,
  onBusyChange,
}: Props) {
  // No validation call — there is no Xero in this path. The plan is purely
  // the approved hours already on screen.
  const plan = buildReviewPlan(candidates, null);
  const weekUnfinished = (outstanding?.total ?? 0) > 0;

  const [stage, setStage] = useState<Stage>("review");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SentReceipt | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const send = useCallback(async () => {
    setStage("sending");
    setError(null);
    onBusyChange?.(true);
    try {
      const res = await fetch("/api/time-entries-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fromDate: weekStart, toDate: weekEnd }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || `The send failed (${res.status}) — nothing was emailed.`);
      }
      if (!alive.current) return;
      setReceipt({
        recipients: Array.isArray(data?.recipients)
          ? (data.recipients as unknown[]).filter((r): r is string => typeof r === "string")
          : [],
        workerCount: Number(data?.workerCount) || 0,
        totalHours: Number(data?.totalHours) || 0,
        sentAtLabel: new Date().toLocaleTimeString("en-AU", {
          hour: "numeric",
          minute: "2-digit",
        }),
      });
      setStage("sent");
    } catch (e) {
      if (!alive.current) return;
      setError(
        e instanceof Error
          ? e.message
          : "Couldn't reach the server — nothing was emailed. Try again.",
      );
      setStage("review");
    } finally {
      onBusyChange?.(false);
    }
  }, [weekStart, weekEnd, onBusyChange]);

  if (stage === "sending") {
    return (
      <FinaleShell title="Sending to Tia" onClose={onClose}>
        <div
          data-testid="wha-send-sending"
          className="flex flex-col items-center gap-3 py-10 text-center"
        >
          <Loader2
            aria-hidden="true"
            className="h-10 w-10 animate-spin text-brand-navy motion-reduce:animate-none"
          />
          <p className="font-display text-lg font-bold text-text">Emailing the timesheets…</p>
          <p className="text-sm text-text-muted">Sending the {periodLabel} PDF to Tia at accounts.</p>
        </div>
      </FinaleShell>
    );
  }

  if (stage === "sent" && receipt) {
    return (
      <FinaleShell
        title="Sent to Tia"
        onClose={onClose}
        footer={
          <Button className="w-full" onClick={onClose}>
            Done
          </Button>
        }
      >
        <div
          data-testid="wha-send-sent"
          className="flex flex-col items-center gap-3 py-2 text-center"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
            <Check aria-hidden="true" className="h-7 w-7" />
          </span>
          <p className="mx-auto max-w-[32ch] text-sm leading-relaxed text-text-muted">
            The approved-hours PDF for{" "}
            <b className="font-semibold text-text">{periodLabel}</b> is on its way to{" "}
            <b className="font-semibold text-text">
              {receipt.recipients.join(", ") || "accounts"}
            </b>
            . Tia takes the pay run from here.
          </p>
        </div>

        <dl className="rounded-card border border-border px-3.5 py-1">
          <ReceiptRow label="Workers" value={String(receipt.workerCount)} />
          <ReceiptRow label="Approved hours" value={formatHoursLabel(receipt.totalHours)} />
          <ReceiptRow label="Sent" value={receipt.sentAtLabel} last />
        </dl>
      </FinaleShell>
    );
  }

  return (
    <FinaleShell
      title="Week reviewed"
      onClose={onClose}
      footer={
        <div className="space-y-1.5">
          {plan.rows.length > 0 ? (
            weekUnfinished ? (
              /* Days are still coming in — waiting is the sensible default,
                 sending early stays one (demoted) tap away. */
              <>
                <Button className="w-full" data-testid="wha-send-wait" onClick={onClose}>
                  Wait for the full week
                </Button>
                <Button
                  variant="ghost"
                  className="w-full text-text-muted"
                  data-testid="wha-send-accounts"
                  onClick={send}
                >
                  <Mail aria-hidden="true" className="h-4 w-4" />
                  Send anyway
                </Button>
              </>
            ) : (
              <>
                <Button className="w-full" data-testid="wha-send-accounts" onClick={send}>
                  <Mail aria-hidden="true" className="h-4 w-4" />
                  Send to Tia
                </Button>
                <Button variant="ghost" className="w-full text-text-muted" onClick={onClose}>
                  Not now
                </Button>
              </>
            )
          ) : (
            <Button variant="secondary" className="w-full" onClick={onClose}>
              Done
            </Button>
          )}
        </div>
      }
    >
      <ReviewedMark
        count={reviewedCount}
        sub={
          plan.rows.length > 0
            ? "Approved hours are ready to email to Tia at accounts."
            : undefined
        }
      />

      {error ? (
        <Notice tone="danger" title="The email didn&rsquo;t send">
          {error}
        </Notice>
      ) : null}

      {weekUnfinished && outstanding && plan.rows.length > 0 ? (
        <div data-testid="wha-send-outstanding">
          <Notice tone="warn" title="The week isn&rsquo;t finished">
            {outstandingWeekLabel(outstanding)}. The PDF only carries approved hours — days
            that land later won&rsquo;t be on it. Waiting costs nothing; this screen is here
            whenever you&rsquo;re ready.
          </Notice>
        </div>
      ) : null}

      {plan.rows.length === 0 ? (
        <Notice tone="muted" title="No approved hours">
          Nothing was approved this week, so there&rsquo;s nothing to email. Approve the days
          first, then send.
        </Notice>
      ) : (
        <>
          {/* Sending-to card — mirrors the Xero finale's, pointed at accounts. */}
          <div className="flex items-center gap-3 rounded-card border border-border p-3.5">
            <span
              aria-hidden="true"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card bg-brand-navy text-accent-yellow"
            >
              <Mail aria-hidden="true" className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[9px] uppercase tracking-widest text-text-muted">
                Sending to
              </p>
              <p className="truncate font-display text-[15px] font-bold text-text">
                Tia · accounts
              </p>
              <p className="text-xs text-text-muted">Pay period {periodLabel} · emailed as a PDF</p>
            </div>
          </div>

          <PushRowList plan={plan} />

          <p className="rounded-card border border-border bg-surface-subtle p-3 text-xs leading-relaxed text-text-muted">
            While Xero is out of action, the pay run goes to accounts as an emailed PDF — the same
            sheet as Download PDF on desktop. Sending doesn&rsquo;t lock anything.
          </p>
        </>
      )}
    </FinaleShell>
  );
}
