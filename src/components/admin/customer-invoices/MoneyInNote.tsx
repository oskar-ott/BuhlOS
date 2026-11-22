import { formatCents } from "@/domains/customer-invoices/format";
import type { JobProfitabilityResponse } from "@/domains/jobs/profitability-client";

/**
 * "Money in" on the job's Money card (#1151, customer_invoices): what the job
 * has been invoiced and paid, beside what it has cost — the answer to "is this
 * job making or losing money, in actual cash".
 *
 * Every figure about a sent invoice is XERO'S, as last mirrored. Nothing here
 * is worked out beyond adding them up and one subtraction:
 *   cash so far = paid (ex GST) − labour − materials
 * and that line never claims more certainty than its inputs — uncosted labour
 * is named beside it, and it is left out when the paid figure can't be split.
 *
 * Renders nothing while the feature is off for the viewer (no trace).
 */
export function MoneyInNote({
  moneyIn,
  labourUnderstated,
  hasContract = true,
}: {
  moneyIn: JobProfitabilityResponse["customerInvoices"];
  /** Some approved hours carry no cost rate, so the costs are too low. */
  labourUnderstated: boolean;
  /** The job has a contract value. Without one (a small do-and-charge job)
   *  the margin is measured against what has been invoiced instead. */
  hasContract?: boolean;
}) {
  if (!moneyIn) return null;
  const variations =
    moneyIn.variationsApprovedCents > 0 && moneyIn.revisedContractCents != null ? (
      <p className="text-xs text-text-muted" data-testid="money-in-variations">
        Approved variations add {formatCents(moneyIn.variationsApprovedCents)}: with them the job is
        worth <span className="font-semibold text-text">{formatCents(moneyIn.revisedContractCents)}</span>{" "}
        ex GST. The margin above is on the contract alone.
      </p>
    ) : null;

  if (moneyIn.unavailable) {
    return (
      <div className="border-t border-border px-4 py-3 sm:px-6" data-testid="money-in">
        <p className="text-xs text-text-muted" role="alert">
          The invoices couldn&rsquo;t be read just now, so money in isn&rsquo;t shown. That is
          not the same as nothing invoiced.
        </p>
      </div>
    );
  }

  if (moneyIn.sentCount === 0) {
    return (
      <div className="border-t border-border px-4 py-3 sm:px-6" data-testid="money-in">
        <p className="text-xs text-text-muted">
          Money in: nothing has been invoiced on this job yet
          {moneyIn.plannedCount > 0
            ? ` — ${moneyIn.plannedCount} ${moneyIn.plannedCount === 1 ? "invoice is" : "invoices are"} planned in Getting paid below.`
            : "."}
        </p>
        {variations}
      </div>
    );
  }

  const cash = moneyIn.cashCents;
  return (
    <div className="space-y-1 border-t border-border px-4 py-3 sm:px-6" data-testid="money-in">
      <p className="text-sm text-text">
        Money in:{" "}
        <span className="font-semibold tabular-nums">{formatCents(moneyIn.invoicedCents)}</span>{" "}
        invoiced ·{" "}
        <span className="font-semibold tabular-nums">{formatCents(moneyIn.paidIncGstCents)}</span>{" "}
        paid ·{" "}
        <span
          className={
            moneyIn.overdueCount > 0
              ? "font-semibold tabular-nums text-state-danger-subtle-text"
              : "font-semibold tabular-nums"
          }
        >
          {formatCents(moneyIn.dueIncGstCents)}
        </span>{" "}
        owing
        {moneyIn.overdueCount > 0
          ? ` (${moneyIn.overdueCount} overdue)`
          : ""}
        .
      </p>
      <p className="text-xs text-text-muted">
        Invoiced is ex GST and counts invoices approved in Xero; paid and owing include GST, as Xero
        shows them.
        {moneyIn.draftedCents > 0
          ? ` Another ${formatCents(moneyIn.draftedCents)} is still a draft in Xero.`
          : ""}
      </p>
      {cash != null ? (
        <p className="text-xs text-text-muted" data-testid="money-in-cash">
          Cash so far:{" "}
          <span
            className={
              cash < 0
                ? "font-semibold tabular-nums text-state-danger-subtle-text"
                : "font-semibold tabular-nums text-state-success-subtle-text"
            }
          >
            {formatCents(cash)}
          </span>{" "}
          — what has been paid (ex GST) less labour and materials to date
          {labourUnderstated ? ", before uncosted labour" : ""}.
        </p>
      ) : moneyIn.paidIncGstCents > 0 ? (
        <p className="text-xs text-text-muted" data-testid="money-in-cash-unknown">
          Cash so far can&rsquo;t be worked out: Xero&rsquo;s figures for a paid invoice
          haven&rsquo;t all come through yet.
        </p>
      ) : null}
      {!hasContract && moneyIn.billedMarginCents != null ? (
        <p className="text-xs text-text-muted" data-testid="money-in-billed-margin">
          On the {formatCents(moneyIn.billedCents)} sent to Xero so far:{" "}
          <span
            className={
              moneyIn.billedMarginCents < 0
                ? "font-semibold tabular-nums text-state-danger-subtle-text"
                : "font-semibold tabular-nums text-state-success-subtle-text"
            }
          >
            {formatCents(moneyIn.billedMarginCents)}
          </span>{" "}
          left after labour and materials to date{labourUnderstated ? ", before uncosted labour" : ""}. This
          job has no contract value, so that is its margin so far.
        </p>
      ) : null}
      {variations}
    </div>
  );
}
