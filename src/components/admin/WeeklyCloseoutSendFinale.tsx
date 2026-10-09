"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  outstandingWeekLabel,
  type OutstandingLine,
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
import { formatPeriodSend, usePeriodEmailStatus } from "./usePeriodEmailStatus";
import { sendPeriodTimesheets } from "./sendPeriodTimesheets";

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
 * - Days approved seconds ago can't be read back for up to a minute; the
 *   server refuses rather than send a short sheet and says when to retry, and
 *   this screen waits it out and sends by itself (sendPeriodTimesheets —
 *   2026-10-05, the week that never went).
 */

type Stage = "review" | "sending" | "sent";

interface SentReceipt {
  recipients: string[];
  workerCount: number;
  totalHours: number;
  sentAtLabel: string;
  /** What the sheet left off, by name — the server's own list (the same one
   *  the email and PDF print). Absent when the server didn't say: then the
   *  receipt says nothing about it, never a hopeful "Nothing" (P7). */
  notOnSheet?: { dayCount: number; lines: Array<{ workerName: string; reason: string; days: string }> };
}

/** "Dylan Sinclair · nothing logged: Fri 2 Oct" — one line per worker per reason. */
function NamedDays({
  lines,
  testId,
}: {
  lines: ReadonlyArray<{ workerName: string; reason: string; days: string }>;
  testId: string;
}) {
  if (!lines.length) return null;
  return (
    <ul data-testid={testId} className="mt-2 space-y-1">
      {lines.map((l) => (
        <li key={`${l.workerName}|${l.reason}`} className="leading-snug">
          <b className="font-semibold">{l.workerName}</b> · {l.reason}: {l.days}
        </li>
      ))}
    </ul>
  );
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
   * Only ACTIONABLE days (sent-back + not-reviewed) flip the footer to lead
   * with "Wait for the full week" — those days are mid-flight and will land.
   * Days never sent in (crew on holiday — normal, owner call 2026-08-17) get
   * an FYI notice but never hold the send: they'd block every real pay run.
   * Send always stays available: the interim email stamps nothing and a
   * re-send is safe, so sending early is a judgement call, not an error.
   */
  outstanding?: OutstandingWeek;
  /**
   * WHO and WHICH DAYS behind `outstanding` (2026-10-09 — the 5 Oct finale said
   * "2 days never came in" and nobody could tell it meant two people's
   * Fridays). Same reasons + day format as the sheet's own "Not on this sheet"
   * list, so what the boss reads here is what accounts reads in the email.
   */
  outstandingLines?: ReadonlyArray<OutstandingLine>;
  /**
   * Hours actions from this review still saving (the review sheet's per-worker
   * busyIds — approve, send back, fix a day, undo). Approvals are fired in the
   * background so the boss never waits between people, so this screen can
   * open while the last few are still being written. A send in that window
   * reads those days as still "submitted" and leaves them off the sheet with
   * NO error (no freshness refusal can see a write that hasn't happened yet —
   * 2026-10-06 audit of the 5 Oct send). While anything is saving, the send
   * waits; it unlocks by itself when the saves land.
   */
  savingCount?: number;
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
  outstandingLines = [],
  savingCount = 0,
  onClose,
  onBusyChange,
}: Props) {
  // No validation call — there is no Xero in this path. The plan is purely
  // the approved hours already on screen.
  const plan = buildReviewPlan(candidates, null);
  // This review's own approvals are still being written — nothing below is
  // settled yet, so the send (and the wait/FYI notices, which would count the
  // in-flight days as "still waiting for review") hold until they land.
  const saving = savingCount > 0;
  // Days mid-flight (sent back / not reviewed) lead with waiting; days that
  // will never arrive (holiday crew) only inform.
  const holdsSend = !saving && (outstanding?.actionableDays ?? 0) > 0;
  const notInYet = outstanding?.notInYetDays ?? 0;

  // Who the email really goes to + whether this week already went (the audit
  // journal) — shown before the send, so a second tap isn't a blind re-send.
  const { status: emailStatus, refresh: refreshEmailStatus } = usePeriodEmailStatus(
    weekStart,
    weekEnd
  );
  const recipients = emailStatus.kind === "loading" ? [] : emailStatus.recipients;
  const lastSent = emailStatus.kind === "ready" ? emailStatus.lastSent : null;

  const [stage, setStage] = useState<Stage>("review");
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<SentReceipt | null>(null);
  // Set while the send waits for just-approved days to settle (ms it waits).
  const [settleWaitMs, setSettleWaitMs] = useState<number | null>(null);
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
    setSettleWaitMs(null);
    onBusyChange?.(true);
    try {
      const outcome = await sendPeriodTimesheets({
        fromDate: weekStart,
        toDate: weekEnd,
        onSettling: (ms) => {
          if (alive.current) setSettleWaitMs(ms);
        },
        isActive: () => alive.current,
      });
      if (!alive.current || !outcome) return;
      if (!outcome.ok) throw new Error(outcome.error);
      setReceipt({
        ...outcome.receipt,
        sentAtLabel: new Date().toLocaleTimeString("en-AU", {
          hour: "numeric",
          minute: "2-digit",
        }),
      });
      setStage("sent");
      refreshEmailStatus();
    } catch (e) {
      if (!alive.current) return;
      // A dropped connection can't say whether the send landed — re-read the
      // journal and say so, never "nothing was emailed" on a guess.
      refreshEmailStatus();
      setError(
        e instanceof Error && !(e instanceof TypeError)
          ? e.message
          : "Lost the connection mid-send, so we can't tell if it went. Check whether it shows as already emailed before sending again.",
      );
      setStage("review");
    } finally {
      if (alive.current) setSettleWaitMs(null);
      onBusyChange?.(false);
    }
  }, [weekStart, weekEnd, onBusyChange, refreshEmailStatus]);

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
          <p className="text-sm text-text-muted">
            Sending the {periodLabel} PDF to {recipients.join(", ") || "accounts"}.
          </p>
          {settleWaitMs != null ? (
            <p
              role="status"
              data-testid="wha-send-settling"
              className="mx-auto max-w-[32ch] text-sm leading-relaxed text-text-muted"
            >
              The days you just approved are still saving. It sends by itself in about{" "}
              {Math.ceil(settleWaitMs / 1000)} seconds — keep this screen open.
            </p>
          ) : null}
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
            . Accounts finishes the pay run in Xero.
          </p>
        </div>

        <dl className="rounded-card border border-border px-3.5 py-1">
          <ReceiptRow label="Workers" value={String(receipt.workerCount)} />
          <ReceiptRow label="Approved hours" value={formatHoursLabel(receipt.totalHours)} />
          {receipt.notOnSheet ? (
            <ReceiptRow
              label="Not on the sheet"
              value={
                receipt.notOnSheet.dayCount > 0
                  ? `${receipt.notOnSheet.dayCount} day${receipt.notOnSheet.dayCount === 1 ? "" : "s"}`
                  : "Nothing"
              }
            />
          ) : null}
          <ReceiptRow label="Sent" value={receipt.sentAtLabel} last />
        </dl>
        {receipt.notOnSheet && receipt.notOnSheet.lines.length > 0 ? (
          <div data-testid="wha-send-sent-missing">
            <Notice tone="warn" title="Listed in the email so nothing is missed">
              These days have no approved hours, so they aren&rsquo;t on the sheet — the email and
              PDF name them for Tia.
              <NamedDays lines={receipt.notOnSheet.lines} testId="wha-send-sent-missing-lines" />
            </Notice>
          </div>
        ) : null}
      </FinaleShell>
    );
  }

  return (
    <FinaleShell
      title="Week reviewed"
      onClose={onClose}
      footer={
        <div className="space-y-1.5">
          {saving ? (
            <Button className="w-full" data-testid="wha-send-saving" disabled>
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
              />
              Saving approvals…
            </Button>
          ) : plan.rows.length > 0 ? (
            holdsSend ? (
              /* Fixes are coming back — waiting is the sensible default.
                 Sending early is a REAL button (secondary, not ghost): the
                 boss must always be able to find it (2026-08-17 — a demoted
                 ghost read as "can't send" on the very first live pay run). */
              <>
                <Button className="w-full" data-testid="wha-send-wait" onClick={onClose}>
                  Wait for the full week
                </Button>
                <Button
                  variant="secondary"
                  className="w-full"
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
                  {lastSent ? "Send a second copy" : "Send to Tia"}
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

      {saving ? (
        <div data-testid="wha-send-saving-note" role="status">
          <Notice tone="muted" title="Still saving">
            {savingCount} {savingCount === 1 ? "person’s" : "people’s"} hours are
            still saving. Sending unlocks as soon as they land — usually a few seconds — so
            nothing you just approved is left off the sheet.
          </Notice>
        </div>
      ) : null}

      {error ? (
        <Notice tone="danger" title="The email didn&rsquo;t send">
          {error}
        </Notice>
      ) : null}

      {lastSent && plan.rows.length > 0 ? (
        <div data-testid="wha-send-last">
          <Notice tone="warn" title="This week was already emailed">
            {formatPeriodSend(lastSent)} to {lastSent.recipients.join(", ") || "accounts"} —{" "}
            {formatHoursLabel(lastSent.totalHours)}. Only send again if hours changed since.
          </Notice>
        </div>
      ) : null}

      {holdsSend && outstanding && plan.rows.length > 0 ? (
        <div data-testid="wha-send-outstanding">
          <Notice tone="warn" title="The week isn&rsquo;t finished">
            {outstandingWeekLabel(outstanding)}. The PDF only carries approved hours — days
            that land later won&rsquo;t be on it. Waiting costs nothing; this screen is here
            whenever you&rsquo;re ready.
            <NamedDays
              lines={outstandingLines.filter((l) => l.kind !== "notInYet")}
              testId="wha-send-outstanding-lines"
            />
          </Notice>
        </div>
      ) : null}

      {!saving && !holdsSend && notInYet > 0 && plan.rows.length > 0 ? (
        /* Crew who never sent a week in — holiday, away, or just didn't log.
           Normal (owner call 2026-08-17), so it informs and never holds. */
        <div data-testid="wha-send-fyi">
          <Notice tone="muted" title="Not everyone&rsquo;s week is here">
            {notInYet} day{notInYet === 1 ? "" : "s"} never came in — crew on holiday or
            nothing logged. The sheet carries approved hours only, so it sends without them —
            and names them for Tia, so nothing is missed.
            <NamedDays
              lines={outstandingLines.filter((l) => l.kind === "notInYet")}
              testId="wha-send-fyi-lines"
            />
          </Notice>
        </div>
      ) : null}

      {saving ? null : plan.rows.length === 0 ? (
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
              <p className="font-mono text-[11px] uppercase tracking-widest text-text-muted">
                Sending to
              </p>
              <p
                className="truncate font-display text-[15px] font-bold text-text"
                data-testid="wha-send-recipients"
              >
                {recipients.length > 0 ? recipients.join(", ") : "Accounts"}
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
