"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Loader2, Mail, RotateCcw, Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { formatHoursLabel } from "@/domains/timesheets/format";
import { buildReviewPlan, type ReviewCandidate } from "@/domains/timesheets/xero-closeout";
import {
  dayCount,
  HOLD_UP_REASON,
  holdsTheSend,
  holdUpHelp,
  type HoldUpLine,
} from "@/domains/timesheets/week-holdups";
import {
  allSkippable,
  unreadableDayLabel,
  type UnreadableDay,
} from "@/domains/timesheets/payroll-refusal";
import {
  FinaleShell,
  Notice,
  PushRowList,
  ReceiptRow,
  ReviewedMark,
} from "@/components/admin/WeeklyCloseoutXeroFinale";
import { formatPeriodSend, usePeriodEmailStatus } from "./usePeriodEmailStatus";
import { sendPeriodTimesheets } from "./sendPeriodTimesheets";
import { PayrollDownloadButton } from "./PayrollDownloadButton";
import { ProblemDialog } from "@/components/ui/ProblemDialog";
import { explainHoursProblem, type HoursProblem } from "@/domains/timesheets/problem";

/**
 * WeeklyCloseoutSendFinale (owner pull 2026-08-15) — the closeout's last
 * screen while the Xero push is out of action: instead of draft timesheets,
 * the approved week goes to Tia at accounts as an emailed PDF
 * (api/time-entries-email.js — the same sheet as Download PDF on desktop).
 *
 * Takes the Xero finale's slot whenever gate.accountsConfigured (the /settings
 * recipient list) — the branch lives in WeeklyHoursApprovalMobile's review
 * sheet. Same honesty rules as the Xero finale:
 * - Opening this screen writes nothing; the list is the approved hours the
 *   boss just reviewed (buildReviewPlan with no validation — no Xero calls).
 * - Emailing stamps nothing (ADR #609) — a re-send just emails again.
 * - The receipt quotes the SERVER's numbers, never a local guess; a failed
 *   send says so and stays on this screen for a retry.
 * - Days approved seconds ago can't be read back for up to a minute; the
 *   server refuses rather than send a short sheet and says when to retry, and
 *   this screen waits it out and sends by itself (sendPeriodTimesheets —
 *   2026-10-05, the week that never went).
 *
 * NOTHING HALTS THE PAY RUN (owner pull 2026-10-12: "if any problems come up
 * approving and exporting timesheets it doesn't halt the process — clear
 * instructions and simple remedies to the problems holding it up"):
 * - Every day holding the week up is named WITH its fix, right here
 *   (week-holdups.ts): Approve · Approve again · Take it back · Send it in for
 *   them · Check. The screen used to name them and offer only "Wait for the
 *   full week" — nothing on it could move a day forward.
 * - Sending without them is always one tap; the sheet names every day it
 *   leaves off, so nothing is missed (the 2026-10-09 integrity rule).
 * - A send that fails always has a way through: try again, send without the
 *   days that couldn't be read (named on the sheet), or download the same PDF
 *   and email it yourself.
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

/** The one-tap fixes behind the hold-up lines (WeeklyHoursApprovalMobile owns
 *  the writes). take back / send in are office-tier only — absent for anyone
 *  else, and the line then just names the day. */
export interface HoldUpRemedies {
  approve: (line: HoldUpLine) => void;
  takeBack?: (line: HoldUpLine) => void;
  sendIn?: (line: HoldUpLine) => void;
  /** Open that person's days in the review, then come back here. */
  check?: (workerId: string) => void;
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

function HoldUpRow({
  line,
  remedies,
  busy,
}: {
  line: HoldUpLine;
  remedies?: HoldUpRemedies;
  busy: boolean;
}) {
  const days = line.dates.length;
  const daysWord = `${days} day${days === 1 ? "" : "s"}`;
  const actions: ReactNode[] = [];
  if (remedies && !busy) {
    if (line.kind === "waiting" || line.kind === "failed") {
      actions.push(
        <Button
          key="approve"
          size="sm"
          data-testid="wha-holdup-approve"
          onClick={() => remedies.approve(line)}
        >
          <Check aria-hidden="true" className="h-4 w-4" />
          {line.kind === "failed" ? "Approve again" : `Approve ${formatHoursLabel(line.hours)}`}
        </Button>,
      );
    }
    if (line.kind === "sentBack" && remedies.takeBack) {
      actions.push(
        <Button
          key="takeBack"
          size="sm"
          variant="secondary"
          data-testid="wha-holdup-takeback"
          onClick={() => remedies.takeBack!(line)}
        >
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
          Take {days === 1 ? "it" : "them"} back
        </Button>,
      );
    }
    if (line.kind === "draft" && remedies.sendIn) {
      actions.push(
        <Button
          key="sendIn"
          size="sm"
          variant="secondary"
          data-testid="wha-holdup-sendin"
          onClick={() => remedies.sendIn!(line)}
        >
          <Send aria-hidden="true" className="h-4 w-4" />
          Send {days === 1 ? "it" : "them"} in for them
        </Button>,
      );
    }
    if (line.kind !== "missing" && remedies.check) {
      actions.push(
        <Button
          key="check"
          size="sm"
          variant="ghost"
          data-testid="wha-holdup-check"
          onClick={() => remedies.check!(line.workerId)}
        >
          Check {daysWord}
        </Button>,
      );
    }
  }
  return (
    <li data-testid="wha-holdup-row" data-kind={line.kind} className="py-2.5 first:pt-0 last:pb-0">
      <p className="text-sm leading-snug text-text">
        <b className="font-semibold">{line.workerName}</b> · {HOLD_UP_REASON[line.kind]}: {line.days}
        {line.hours > 0 ? <span className="text-text-muted"> · {formatHoursLabel(line.hours)}</span> : null}
      </p>
      <p className="mt-0.5 text-xs leading-relaxed text-text-muted">{holdUpHelp(line)}</p>
      {busy ? (
        <p role="status" className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-text-muted">
          <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          Saving…
        </p>
      ) : actions.length ? (
        <div className="mt-2 flex flex-wrap gap-2">{actions}</div>
      ) : null}
    </li>
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
   * Everything holding the week up, by name and day (week-holdups.ts). Only
   * days mid-flight (waiting / didn't go through / sent back) hold the send;
   * drafts and days nothing was logged inform (owner call 2026-08-17 — crew
   * on holiday never submit, and waiting on them would block every pay run).
   * Send is always available: the email stamps nothing, the sheet names every
   * day it leaves off, and a re-send is safe.
   */
  holdUps?: ReadonlyArray<HoldUpLine>;
  /** The one-tap fixes for those lines. Absent → names only. */
  remedies?: HoldUpRemedies;
  /** Workers with a write in flight — their lines show "Saving…". */
  busyIds?: ReadonlyArray<string>;
  /**
   * Hours actions from this review still saving (the review sheet's per-worker
   * busyIds — approve, send back, fix a day, undo, take back, send in).
   * Approvals are fired in the background so the boss never waits between
   * people, so this screen can open while the last few are still being
   * written. A send in that window reads those days as still "submitted" and
   * leaves them off the sheet with NO error (2026-10-06 audit of the 5 Oct
   * send). While anything is saving, the send waits; it unlocks by itself
   * when the saves land — and every save now ENDS (a timeout), so it can't
   * wait forever (2026-10-12).
   */
  savingCount?: number;
  /** Who is saving, for the note ("Mick's and Sam's hours are still saving"). */
  savingNames?: ReadonlyArray<string>;
  onClose: () => void;
  /** Raised while the send is in flight so the sheet can't be dismissed under it. */
  onBusyChange?: (busy: boolean) => void;
}

function firstNames(names: ReadonlyArray<string>): string {
  const firsts = names.map((n) => `${n.split(" ")[0] || n}’s`);
  if (firsts.length <= 1) return firsts[0] ?? "";
  return `${firsts.slice(0, -1).join(", ")} and ${firsts[firsts.length - 1]}`;
}

export function WeeklyCloseoutSendFinale({
  weekStart,
  weekEnd,
  periodLabel,
  reviewedCount,
  candidates,
  holdUps = [],
  remedies,
  busyIds = [],
  savingCount = 0,
  savingNames = [],
  onClose,
  onBusyChange,
}: Props) {
  // No validation call — there is no Xero in this path. The plan is purely
  // the approved hours already on screen.
  const plan = buildReviewPlan(candidates, null);
  // This review's own approvals are still being written — nothing below is
  // settled yet, so the send holds until they land.
  const saving = savingCount > 0;
  const blocking = holdUps.filter(holdsTheSend);
  const notIn = holdUps.filter((l) => !holdsTheSend(l));
  const blockingDays = dayCount(blocking);
  const busy = new Set(busyIds);

  // Who the email really goes to + whether this week already went (the audit
  // journal) — shown before the send, so a second tap isn't a blind re-send.
  const { status: emailStatus, refresh: refreshEmailStatus } = usePeriodEmailStatus(
    weekStart,
    weekEnd
  );
  const recipients = emailStatus.kind === "loading" ? [] : emailStatus.recipients;
  const lastSent = emailStatus.kind === "ready" ? emailStatus.lastSent : null;

  const [stage, setStage] = useState<Stage>("review");
  const [problem, setProblem] = useState<HoursProblem | null>(null);
  const [problemOpen, setProblemOpen] = useState(false);
  // Days the last refusal couldn't read — offered as "send without them".
  const [unreadable, setUnreadable] = useState<UnreadableDay[]>([]);
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

  const send = useCallback(
    async (skipUnreadable: string[] = []) => {
      setStage("sending");
      setProblem(null);
      setProblemOpen(false);
      setSettleWaitMs(null);
      onBusyChange?.(true);
      try {
        const outcome = await sendPeriodTimesheets({
          fromDate: weekStart,
          toDate: weekEnd,
          skipUnreadable,
          onSettling: (ms) => {
            if (alive.current) setSettleWaitMs(ms);
          },
          isActive: () => alive.current,
        });
        if (!alive.current || !outcome) return;
        if (!outcome.ok) {
          // Plain words in a pop-up (what went wrong, why, what to do); the
          // same words — and the ways through — stay on the finale after.
          setProblem(outcome.problem);
          setProblemOpen(true);
          setUnreadable(outcome.unreadable);
          setStage("review");
          return;
        }
        setUnreadable([]);
        setReceipt({
          ...outcome.receipt,
          sentAtLabel: new Date().toLocaleTimeString("en-AU", {
            hour: "numeric",
            minute: "2-digit",
          }),
        });
        setStage("sent");
        refreshEmailStatus();
      } catch {
        if (!alive.current) return;
        // A dropped connection can't say whether the send landed — re-read the
        // journal and say so, never "nothing was emailed" on a guess.
        refreshEmailStatus();
        setProblem(explainHoursProblem("send", { status: 0, kind: "timeout" }));
        setProblemOpen(true);
        setUnreadable([]);
        setStage("review");
      } finally {
        if (alive.current) setSettleWaitMs(null);
        onBusyChange?.(false);
      }
    },
    [weekStart, weekEnd, onBusyChange, refreshEmailStatus],
  );

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
              These days aren&rsquo;t on the sheet — the email and PDF name them for Tia, each
              with why. Approve any of them later and send again to add them.
              <NamedDays lines={receipt.notOnSheet.lines} testId="wha-send-sent-missing-lines" />
            </Notice>
          </div>
        ) : null}
      </FinaleShell>
    );
  }

  const canLeaveOff = allSkippable(unreadable);

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
            blockingDays > 0 ? (
              /* Days still to settle: the fixes above lead (they ARE how the
                 week gets finished). Sending without them is a REAL button,
                 never hidden — the sheet names every day it leaves off. */
              <>
                <Button
                  variant="secondary"
                  className="w-full"
                  data-testid="wha-send-accounts"
                  onClick={() => void send()}
                >
                  <Mail aria-hidden="true" className="h-4 w-4" />
                  Send without {blockingDays === 1 ? "that day" : `those ${blockingDays} days`}
                </Button>
                <Button
                  variant="ghost"
                  className="w-full text-text-muted"
                  data-testid="wha-send-later"
                  onClick={onClose}
                >
                  Finish later
                </Button>
              </>
            ) : (
              <>
                <Button className="w-full" data-testid="wha-send-accounts" onClick={() => void send()}>
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
              {blockingDays > 0 ? "Finish later" : "Done"}
            </Button>
          )}
        </div>
      }
    >
      <ReviewedMark
        count={reviewedCount}
        sub={
          plan.rows.length > 0
            ? blockingDays > 0
              ? "Approved hours are ready. Settle the days below, or send without them."
              : "Approved hours are ready to email to Tia at accounts."
            : undefined
        }
      />

      {saving ? (
        <div data-testid="wha-send-saving-note" role="status">
          <Notice tone="muted" title="Still saving">
            {savingNames.length > 0
              ? `${firstNames(savingNames)} hours are`
              : `${savingCount} ${savingCount === 1 ? "person’s" : "people’s"} hours are`}{" "}
            still saving. Sending unlocks as soon as they land — usually a few seconds — so
            nothing you just approved is left off the sheet.
          </Notice>
        </div>
      ) : null}

      <ProblemDialog
        problem={problemOpen ? problem : null}
        onClose={() => setProblemOpen(false)}
        onRetry={() => void send()}
      />
      {problem ? (
        <div
          data-testid="wha-send-problem"
          role="status"
          className="rounded-card border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900"
        >
          <p className="font-display text-[13px] font-bold">The email didn&rsquo;t send</p>
          <p className="mt-1 leading-relaxed">
            {problem.title}. {problem.todo}
          </p>
          {unreadable.length > 0 ? (
            <ul data-testid="wha-send-unreadable" className="mt-2 list-disc space-y-0.5 pl-4">
              {unreadable.map((d) => (
                <li key={d.key}>{unreadableDayLabel(d)}</li>
              ))}
            </ul>
          ) : null}
          <div className="mt-2.5 flex flex-wrap items-start gap-2">
            {problem.canRetry ? (
              <Button size="sm" variant="secondary" onClick={() => void send()}>
                Try again
              </Button>
            ) : null}
            {canLeaveOff ? (
              <Button
                size="sm"
                data-testid="wha-send-without"
                onClick={() => void send(unreadable.map((d) => d.key))}
              >
                Send without {unreadable.length === 1 ? "it" : "them"}
              </Button>
            ) : null}
          </div>
          {/* The way through that never depends on the email service: the
              same sheet, to send yourself. */}
          <div className="mt-2.5 border-t border-rose-200 pt-2.5">
            <p className="mb-1.5 leading-relaxed">
              Or download the same PDF and email it to Tia yourself:
            </p>
            <PayrollDownloadButton
              fromDate={weekStart}
              toDate={weekEnd}
              format="pdf"
              label="Download the PDF"
              fallbackFilename={`buhlos-hours-${weekStart}-to-${weekEnd}.pdf`}
              testId="wha-send-fallback-pdf"
              className="bg-surface"
            />
          </div>
        </div>
      ) : null}

      {lastSent && plan.rows.length > 0 ? (
        <div data-testid="wha-send-last">
          <Notice tone="warn" title="This week was already emailed">
            {formatPeriodSend(lastSent)} to {lastSent.recipients.join(", ") || "accounts"} —{" "}
            {formatHoursLabel(lastSent.totalHours)}. Only send again if hours changed since.
          </Notice>
        </div>
      ) : null}

      {!saving && blocking.length > 0 ? (
        <section
          data-testid="wha-holdups"
          aria-label="Still to settle"
          className="rounded-card border border-amber-200 bg-amber-50 p-3.5"
        >
          <p className="font-display text-[13px] font-bold text-amber-900">
            Still to settle · {blockingDays} day{blockingDays === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-900">
            These aren&rsquo;t approved, so they won&rsquo;t be on the sheet. Settle them here —
            or send without them: the sheet names every day it leaves off, for Tia.
          </p>
          <ul className="mt-3 divide-y divide-amber-200">
            {blocking.map((l) => (
              <HoldUpRow
                key={`${l.workerId}|${l.kind}`}
                line={l}
                remedies={remedies}
                busy={busy.has(l.workerId)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {!saving && notIn.length > 0 ? (
        /* Days that never came in — holiday, away, or saved but not sent.
           Normal (owner call 2026-08-17), so they inform and never hold; a
           saved draft can be sent in from here so real hours aren't lost. */
        <section
          data-testid="wha-notin"
          aria-label="Not in"
          className="rounded-card border border-border bg-surface-subtle p-3.5"
        >
          <p className="font-display text-[13px] font-bold text-text">
            Not in · {dayCount(notIn)} day{dayCount(notIn) === 1 ? "" : "s"}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">
            No approved hours on these days, so the sheet sends without them — and names them for
            Tia, so nothing is missed.
          </p>
          <ul className="mt-3 divide-y divide-border">
            {notIn.map((l) => (
              <HoldUpRow
                key={`${l.workerId}|${l.kind}`}
                line={l}
                remedies={remedies}
                busy={busy.has(l.workerId)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {saving ? null : plan.rows.length === 0 ? (
        <Notice tone="muted" title="No approved hours yet">
          {blockingDays > 0
            ? "Nothing's approved yet, so there's nothing to email. Approve the days above, then send."
            : "Nothing was approved this week, so there’s nothing to email. Approve the days first, then send."}
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
