"use client";

import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import {
  STATUS_LABEL,
  STATUS_TONE,
  UNKNOWN_SEND_MESSAGE,
  failureMessage,
  formatBp,
  formatCents,
  formatDay,
  xeroInvoiceUrl,
} from "@/domains/customer-invoices/format";
import type { Stage } from "@/domains/customer-invoices/schema";

const LINK =
  "font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2";

function basisCaption(stage: Stage): string {
  if (stage.kind === "retention_release") return "releases retention held";
  const base =
    stage.basis === "percent" ? `${formatBp(stage.percentBp)} of contract` : "fixed amount";
  const extras = stage.extraLines.length;
  return extras > 0 ? `${base} + ${extras} extra ${extras === 1 ? "line" : "lines"}` : base;
}

export interface StageRowActions {
  onEdit: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
  /** Open the send preview. */
  onSend: () => void;
  /** Look the number up in Xero: adopt what is there, or send again. */
  onCheck: () => void;
  /** Put a stage that never reached Xero back to planned. */
  onReset: () => void;
  /** The number is taken in Xero: add a planned copy that takes the next one. */
  onRaiseAgain: () => void;
}

/**
 * One stage invoice on the Getting paid card. What it shows follows where the
 * stage is on its way to Xero:
 *
 *   planned   what it works out to today · Edit · Remove · Send to Xero
 *   sending   its number, and — when Xero gave no answer — a plain warning
 *             that it may or may not be there, with Check Xero (a look-up,
 *             never a blind re-send)
 *   failed    Xero's own reason · Try again · Edit and resend — or, when the
 *             number is taken in Xero, Use the next number
 *   sent      its number, XERO'S figures (subtotal, GST, total), a link to
 *             open it in Xero, and a warning if it no longer matches what
 *             was sent
 *
 * Stacked on a phone (name and details, then the amount and actions
 * underneath); side by side from sm up.
 */
export function StageRow({
  stage,
  busy,
  confirmingRemove,
  sendReady,
  actions,
}: {
  stage: Stage;
  busy: boolean;
  confirmingRemove: boolean;
  /** Everything a send needs at job level is in place. */
  sendReady: boolean;
  actions: StageRowActions;
}) {
  const c = stage.computed;
  const planned = stage.state === "planned";
  const sending = stage.state === "sending";
  const failed = stage.state === "failed";
  const sent = stage.state === "sent";
  const hasRetention = c.retentionCents != null && c.retentionCents > 0;
  const numberTaken = failed && stage.failureCategory === "number_taken";
  // Deleted or voided in Xero: history only.
  const dead = sent && (stage.xeroStatus === "DELETED" || stage.xeroStatus === "VOIDED");
  const dueDay = stage.xeroDueDate ?? stage.dueDate ?? null;
  // What Xero says about payment — its GST-inclusive figures, as given.
  const paid = stage.xeroAmountPaidCents ?? null;
  const owing = stage.xeroAmountDueCents ?? null;
  const paidLine =
    stage.display === "paid"
      ? `Paid in full${stage.xeroFullyPaidOn ? ` on ${formatDay(stage.xeroFullyPaidOn)}` : ""}.`
      : stage.display === "part_paid" || stage.display === "overdue" || stage.display === "awaiting_payment"
        ? [
            paid != null && paid > 0 ? `${formatCents(paid)} paid` : null,
            owing != null ? `${formatCents(owing)} owing` : null,
          ]
            .filter(Boolean)
            .join(" · ") + (owing != null || (paid != null && paid > 0) ? " (inc GST)" : "")
        : "";

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 sm:flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {stage.invoiceNumber ? (
            <span className="font-mono text-xs font-semibold text-text" data-testid="gp-stage-number">
              {stage.invoiceNumber}
            </span>
          ) : null}
          <span className="font-medium text-text">{stage.title}</span>
          <Pill tone={STATUS_TONE[stage.display]} dot>
            {STATUS_LABEL[stage.display]}
          </Pill>
        </div>
        <p className="mt-0.5 text-xs text-text-muted">
          {basisCaption(stage)}
          {planned && stage.plannedDate ? ` · planned for ${formatDay(stage.plannedDate)}` : ""}
          {!planned && stage.invoiceDate ? ` · dated ${formatDay(stage.invoiceDate)}` : ""}
          {!planned && dueDay && !dead ? ` · due ${formatDay(dueDay)}` : ""}
        </p>
        {stage.extraLines.length > 0 ? (
          <ul className="mt-1 grid gap-0.5 text-xs text-text-muted">
            {stage.extraLines.map((l, i) => (
              <li key={`${l.description}-${i}`}>
                + {l.description} · <span className="tabular-nums">{formatCents(l.amountCents)}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {sending ? (
          <p className="mt-1.5 text-sm text-state-warning-subtle-text" data-testid="gp-stage-unknown">
            {stage.failureCategory
              ? UNKNOWN_SEND_MESSAGE
              : "Sending to Xero… If this stays here, check Xero — it won't be sent twice."}
          </p>
        ) : null}
        {failed ? (
          <p className="mt-1.5 text-sm text-state-danger-subtle-text" role="alert" data-testid="gp-stage-failed">
            {failureMessage(stage.failureCategory, stage.failureDetail)}
          </p>
        ) : null}
        {sent && stage.drift && !dead ? (
          <p className="mt-1.5 text-sm text-state-warning-subtle-text" data-testid="gp-stage-drift">
            {stage.drift.mismatches.includes("not_found_in_xero")
              ? "Xero no longer has this invoice under the id BuhlOS stored. The figures shown are the last ones Xero gave. Check Xero."
              : "This invoice has been changed in Xero since BuhlOS sent it. The figures shown here are Xero's."}
          </p>
        ) : null}
        {sent && !dead && paidLine ? (
          <p className="mt-1 text-xs text-text-muted" data-testid="gp-stage-paid">
            {paidLine}
          </p>
        ) : null}
        {dead ? (
          <p className="mt-1.5 text-sm text-text-muted" data-testid="gp-stage-dead">
            This invoice was {stage.xeroStatus === "DELETED" ? "deleted" : "voided"} in Xero, so it
            no longer counts toward the job. Its number isn&rsquo;t used again.
            {stage.replacedById ? " It has been raised again as a new stage." : ""}
          </p>
        ) : null}
      </div>

      <div className="sm:text-right">
        {sent && stage.xeroSubtotalCents != null ? (
          <>
            <p
              className={`font-display text-lg font-bold tabular-nums ${dead ? "text-text-muted line-through" : "text-text"}`}
              data-testid="gp-stage-xero-subtotal"
            >
              {formatCents(stage.xeroSubtotalCents)}
            </p>
            <p className="text-xs text-text-muted" data-testid="gp-stage-xero-total">
              {stage.xeroTaxCents != null && stage.xeroTotalCents != null
                ? `+ ${formatCents(stage.xeroTaxCents)} GST = ${formatCents(stage.xeroTotalCents)} · Xero's figures`
                : "Xero's figure"}
            </p>
          </>
        ) : c.grossCents == null ? (
          <p className="text-sm text-text-muted" data-testid="gp-stage-unresolved">
            {c.reason === "no_contract_value" ? "needs a contract value" : "can't be worked out"}
          </p>
        ) : (
          <>
            <p className="font-display text-lg font-bold tabular-nums text-text">
              {formatCents(hasRetention && !planned ? c.netCents : c.grossCents)}
            </p>
            {hasRetention ? (
              <p className="text-xs text-text-muted" data-testid="gp-stage-retention">
                {planned
                  ? `less ${formatBp(c.retentionBp)} retention ${formatCents(c.retentionCents)} · ${formatCents(c.netCents)} to invoice`
                  : `${formatCents(c.grossCents)} less ${formatBp(c.retentionBp)} retention ${formatCents(c.retentionCents)}`}
              </p>
            ) : null}
          </>
        )}

        {sent && hasRetention && !dead ? (
          <p className="text-xs text-text-muted">
            {formatCents(c.retentionCents)} retention held ({formatBp(c.retentionBp)})
          </p>
        ) : null}

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 sm:justify-end">
          {planned && confirmingRemove ? (
            <>
              <span className="w-full text-xs text-text-muted sm:w-auto">Remove this stage?</span>
              <Button size="sm" variant="danger" onClick={actions.onRemove} disabled={busy}>
                Yes, remove
              </Button>
              <Button size="sm" variant="ghost" onClick={actions.onCancelRemove} disabled={busy}>
                Keep
              </Button>
            </>
          ) : null}
          {planned && !confirmingRemove ? (
            <>
              <Button size="sm" variant="secondary" onClick={actions.onEdit} disabled={busy}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={actions.onAskRemove} disabled={busy}>
                Remove
              </Button>
              {sendReady && c.netCents != null && c.netCents > 0 ? (
                <Button size="sm" onClick={actions.onSend} disabled={busy} data-testid="gp-stage-send">
                  Send to Xero
                </Button>
              ) : null}
            </>
          ) : null}
          {sending ? (
            <Button size="sm" variant="secondary" onClick={actions.onCheck} disabled={busy} data-testid="gp-stage-check">
              {busy ? "Checking Xero…" : "Check Xero"}
            </Button>
          ) : null}
          {failed && numberTaken ? (
            <Button size="sm" onClick={actions.onRaiseAgain} disabled={busy} data-testid="gp-stage-raise-again">
              Use the next number
            </Button>
          ) : null}
          {failed && !numberTaken ? (
            <>
              <Button size="sm" onClick={actions.onCheck} disabled={busy} data-testid="gp-stage-retry">
                {busy ? "Trying…" : "Try again"}
              </Button>
              <Button size="sm" variant="secondary" onClick={actions.onReset} disabled={busy} data-testid="gp-stage-reset">
                Edit and resend
              </Button>
            </>
          ) : null}
          {sent && stage.canRaiseAgain ? (
            <Button size="sm" onClick={actions.onRaiseAgain} disabled={busy} data-testid="gp-stage-raise-dead">
              Raise again
            </Button>
          ) : null}
          {sent && stage.xeroInvoiceId ? (
            <a
              href={xeroInvoiceUrl(stage.xeroInvoiceId)}
              target="_blank"
              rel="noreferrer"
              className={`${LINK} text-sm`}
              data-testid="gp-stage-open-xero"
            >
              Open in Xero
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}
