"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardKicker } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import {
  JOB_CONTRACT_CHANGED_EVENT,
  errorCodeOf,
  jobBillable,
  jobInvoicing,
  setPaymentClaim,
  addRetentionRelease,
  raiseAgain,
  refreshJobInvoices,
  removeStage,
  resetSend,
  retrySend,
  saveRetention,
} from "@/domains/customer-invoices/client";
import {
  bpToInput,
  errorMessage,
  formatBp,
  formatCents,
  centsToInput,
  parseDollarsToCents,
  parsePercentToBp,
  agoLabel,
  refreshMessage,
  sendOutcomeMessage,
} from "@/domains/customer-invoices/format";
import { announceJobMoneyChanged } from "@/domains/jobs/job-materials-client";
import type {
  JobInvoicingResponse,
  SendResponse,
  Stage,
} from "@/domains/customer-invoices/schema";
import type { HttpResult } from "@/lib/http";
import { formatHours } from "@/domains/customer-invoices/itemised";
import { ItemisedEditor } from "./ItemisedEditor";
import { SendToXeroPreview } from "./SendToXeroPreview";
import { StageEditor } from "./StageEditor";
import { VariationsSection } from "./VariationsSection";
import { StageRow } from "./StageRow";
import { XeroClientLine } from "./XeroClientLine";

/**
 * Admin job hub — "Getting paid" (customer_invoices, dark; #1148 + #1149,
 * docs/customer-invoices.md). The job's payment stages: a fixed schedule added
 * up front, or one stage added each month for a monthly claim. Each stage is
 * dollars or a % of the contract, with optional extra lines and an optional
 * retention % held back. Below the retention line, the job's client is linked
 * to a Xero contact (#1149) so an invoice will know who it is for.
 *
 * A planned stage is SENT TO XERO AS A DRAFT from here (#1150): "Send to Xero"
 * opens a preview of exactly what will be created; the send is create-only,
 * read back and compared, and can never go twice. A stage that didn't land
 * says why — in Xero's own words when it gave any — and offers the one safe
 * next step. BuhlOS never approves or emails an invoice; the card says so.
 *
 * What happens AFTER the send comes back from Xero (#1151): an hourly check,
 * and "Check Xero now" here, mirror Xero's status and amounts onto each row —
 * approved, part paid, paid, overdue, voided, deleted, or changed in Xero.
 * Once anything has been sent a second strip shows Approved in Xero · Paid ·
 * Owing, all XERO'S figures, with how long ago they were checked. BuhlOS
 * never works out "paid" for itself. A stage Xero shows as deleted or voided
 * drops out of the totals and can be raised again under the next number.
 *
 * Honesty rules (same as the Money card):
 *   - A figure that cannot be worked out is named, never shown as $0 — a %
 *     stage on a job with no contract value says so.
 *   - Planned stages adding up past the contract is a plain warning, not a
 *     block (variations are real).
 *   - A failed read says so and offers a retry; only a 401/403/404 (a viewer
 *     who mustn't see money, or the feature switched off) hides the card.
 *
 * Part 2 (docs/product/job-invoicing-part-2-plan.md): a second kind of
 * invoice, ITEMISED (#1161/#1162), for small jobs — lines with a quantity and
 * a unit price, typed or pulled from the job's own hours and materials; the
 * job's VARIATIONS (#1163), whose approved amounts add to the contract; a line
 * saying what on the job is not on an invoice yet; and optional payment-claim
 * wording (#1164). A stage invoice is unchanged: one line and its amount.
 */
export function JobGettingPaidCard({ jobId }: { jobId: string }) {
  const [data, setData] = useState<JobInvoicingResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "hidden" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await jobInvoicing(jobId);
    if (!res.ok) {
      if (res.error.status === 401 || res.error.status === 403 || res.error.status === 404) {
        setState("hidden");
        return;
      }
      setLoadError(errorMessage(errorCodeOf(res.error.body), res.error.status));
      setState((prev) => (prev === "ready" ? prev : "error"));
      return;
    }
    setData(res.data);
    setLoadError(null);
    setState("ready");
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onContract = (ev: Event) => {
      const detail = (ev as CustomEvent<{ jobId?: string }>).detail;
      if (!detail?.jobId || detail.jobId === jobId) void load();
    };
    window.addEventListener(JOB_CONTRACT_CHANGED_EVENT, onContract);
    return () => window.removeEventListener(JOB_CONTRACT_CHANGED_EVENT, onContract);
  }, [jobId, load]);

  if (state === "hidden") return null;

  return (
    <Card role="region" aria-label="Getting paid" className="p-0" data-testid="getting-paid-card">
      <div className="flex flex-wrap items-baseline justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
        <CardKicker>Getting paid</CardKicker>
        <p className="text-xs text-text-muted">Invoices for this job · all figures ex GST</p>
      </div>

      {state === "error" ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-4 sm:px-6">
          <p className="text-sm text-text-muted" role="alert">
            Couldn&rsquo;t load the invoices. {loadError}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </div>
      ) : state === "loading" || !data ? (
        <div
          className="mx-4 my-4 h-16 animate-pulse rounded bg-surface-subtle sm:mx-6"
          data-testid="getting-paid-skeleton"
          aria-hidden="true"
        />
      ) : (
        <JobGettingPaidBody data={data} onData={setData} onStale={load} />
      )}
    </Card>
  );
}

// Figure-strip cell borders: 2×2 on the phone, one divided row from sm up.
const CELLS = [
  "border-b border-r border-border sm:border-b-0 sm:border-r-0",
  "border-b border-border sm:border-b-0 sm:border-l",
  "border-r border-border sm:border-r-0 sm:border-l",
  "border-border sm:border-l",
];

// The money-in strip (three cells): stacked on the phone, a divided row from sm.
const IN_CELLS = [
  "border-b border-border sm:border-b-0",
  "border-b border-border sm:border-b-0 sm:border-l",
  "border-border sm:border-l",
];

type Mutation = Promise<HttpResult<JobInvoicingResponse>>;

/**
 * The loaded card body. `onData` receives the refreshed payload every
 * mutation answers with; `onStale` re-reads after a conflict so the person is
 * never left looking at a row that has moved on.
 */
export function JobGettingPaidBody({
  data,
  onData,
  onStale,
}: {
  data: JobInvoicingResponse;
  onData: (next: JobInvoicingResponse) => void;
  onStale: () => Promise<void> | void;
}) {
  const [editor, setEditor] = useState<{ mode: "add" } | { mode: "edit"; stage: Stage } | null>(null);
  const [itemised, setItemised] = useState<{ mode: "add" } | { mode: "edit"; stage: Stage } | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendFor, setSendFor] = useState<Stage | null>(null);
  const [checking, setChecking] = useState(false);
  const [banner, setBanner] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);

  const t = data.totals;
  const contract = data.job.contractCents;
  // What there is to invoice in the end: the contract plus approved variations.
  const variationsApproved = t.variationsApprovedCents ?? 0;
  const jobTotal = contract == null ? null : (t.revisedContractCents ?? contract);
  const notPlanned =
    jobTotal == null ? null : jobTotal - t.claimedCents - t.plannedGrossCents;

  /** Run a mutation; on a conflict re-read so the list is true again. */
  async function run(call: () => Mutation): Promise<boolean> {
    setError(null);
    const res = await call();
    if (res.ok) {
      onData(res.data);
      return true;
    }
    const code = errorCodeOf(res.error.body);
    setError(errorMessage(code, res.error.status));
    // A conflict means the list has moved on; a Xero failure may mean the
    // connection has changed. Either way re-read so the card is true again.
    if (
      code === "stale_version" ||
      code === "stage_not_editable" ||
      code === "stage_not_found" ||
      (code !== null && code.startsWith("xero_"))
    ) {
      await onStale();
    }
    return false;
  }

  /** A problem that stopped a call being made at all: say it, and re-read. */
  async function problem(code: string | null, status: number) {
    setBanner(null);
    setError(errorMessage(code, status));
    await onStale();
  }

  /** A send / check / reset that reached the server: show how it ended. */
  function settled(res: SendResponse) {
    onData(res);
    setError(null);
    setBanner(sendOutcomeMessage(res.send));
    // What the job has been invoiced has changed — the Money card follows.
    announceJobMoneyChanged(res.jobId);
  }

  /** "Check Xero now": ask Xero what happened to this job's sent invoices. */
  async function checkNow() {
    setChecking(true);
    setError(null);
    setBanner(null);
    const res = await refreshJobInvoices(data.jobId);
    setChecking(false);
    if (!res.ok) {
      await problem(errorCodeOf(res.error.body), res.error.status);
      return;
    }
    onData(res.data);
    setBanner(refreshMessage(res.data.refresh));
    if (res.data.refresh.changed > 0) announceJobMoneyChanged(res.data.jobId);
  }

  async function runSend(stage: Stage, call: () => Promise<HttpResult<SendResponse>>) {
    setBusyId(stage.id);
    setError(null);
    setBanner(null);
    const res = await call();
    setBusyId(null);
    if (res.ok) settled(res.data);
    else await problem(errorCodeOf(res.error.body), res.error.status);
  }

  async function doRaiseAgain(stage: Stage) {
    setBusyId(stage.id);
    setBanner(null);
    const ok = await run(() => raiseAgain(stage.id));
    setBusyId(null);
    if (ok) {
      announceJobMoneyChanged(data.jobId);
      setBanner({
        tone: "success",
        text: `${stage.invoiceNumber ?? "That number"} is left as it is. A new copy of the stage is ready to send under the next number.`,
      });
    } else {
      await onStale();
    }
  }

  async function doRemove(stage: Stage) {
    setBusyId(stage.id);
    await run(() => removeStage(stage.id, stage.version));
    setBusyId(null);
    setRemoving(null);
  }

  // A sum only exists for the stages that could be worked out. If none could,
  // there is no figure to show — a dash, never $0.00.
  const plannedKnown = t.plannedCount - t.unresolvedCount > 0;
  const plannedCaption =
    t.plannedCount === 0
      ? // "no stages yet" would be untrue once everything planned has been sent
        t.sentCount > 0
        ? "nothing waiting to be sent"
        : "no stages yet"
      : `${t.plannedCount} ${t.plannedCount === 1 ? "invoice" : "invoices"} not sent yet${
          t.unresolvedCount > 0 ? ` · ${t.unresolvedCount} not worked out` : ""
        }`;

  const overdueCount = data.stages.filter((s) => s.display === "overdue").length;

  const hasItemised = data.stages.some((s) => s.kind === "itemised");
  const stillCaption =
    contract == null
      ? hasItemised
        ? "this job has no contract value"
        : "set the contract value on the Money card"
      : notPlanned != null && notPlanned > 0
        ? `${formatCents(notPlanned)} not yet planned`
        : notPlanned === 0
          ? "all of it is planned"
          : undefined;

  return (
    <>
      <dl className="mt-4 grid grid-cols-2 border-t border-border sm:grid-cols-4">
        <div className={cn("px-4 py-3 sm:px-6 sm:py-4", CELLS[0])}>
          <Figure
            label={variationsApproved > 0 && contract != null ? "Contract + variations" : "Contract"}
            value={jobTotal == null ? "—" : formatCents(jobTotal)}
            muted={jobTotal == null}
            caption={
              contract == null
                ? "not set"
                : variationsApproved > 0
                  ? `${formatCents(contract)} + ${formatCents(variationsApproved)} approved variations`
                  : undefined
            }
            testid="gp-contract"
          />
        </div>
        <div className={cn("px-4 py-3 sm:px-6 sm:py-4", CELLS[1])}>
          <Figure
            label="Planned"
            value={plannedKnown ? formatCents(t.plannedGrossCents) : "—"}
            muted={!plannedKnown}
            caption={plannedCaption}
            testid="gp-planned"
          />
        </div>
        <div className={cn("px-4 py-3 sm:px-6 sm:py-4", CELLS[2])}>
          <Figure
            label="Sent to Xero"
            value={t.sentCount > 0 ? formatCents(t.claimedCents) : "—"}
            muted={t.sentCount === 0}
            caption={
              t.sentCount === 0
                ? "nothing sent yet"
                : `${t.sentCount} ${t.sentCount === 1 ? "invoice" : "invoices"} · before retention`
            }
            testid="gp-sent"
          />
        </div>
        <div className={cn("px-4 py-3 sm:px-6 sm:py-4", CELLS[3])}>
          <Figure
            label="Still to invoice"
            value={t.stillToInvoiceCents == null ? "—" : formatCents(t.stillToInvoiceCents)}
            muted={t.stillToInvoiceCents == null}
            caption={stillCaption}
            testid="gp-still"
          />
        </div>
      </dl>

      {t.sentCount > 0 ? (
        <div className="border-t border-border" data-testid="gp-money-in">
          <dl className="grid grid-cols-1 sm:grid-cols-3">
            <div className={cn("px-4 py-3 sm:px-6 sm:py-4", IN_CELLS[0])}>
              <Figure
                label="Approved in Xero"
                value={formatCents(t.invoicedCents)}
                muted={t.invoicedCents === 0}
                caption={
                  t.draftedCents > 0
                    ? `${formatCents(t.draftedCents)} more is still a draft`
                    : "ex GST"
                }
                testid="gp-invoiced"
              />
            </div>
            <div className={cn("px-4 py-3 sm:px-6 sm:py-4", IN_CELLS[1])}>
              <Figure
                label="Paid"
                value={formatCents(t.paidIncGstCents)}
                muted={t.paidIncGstCents === 0}
                caption={
                  t.paidIncGstCents === 0
                    ? "nothing paid yet"
                    : t.paidCents != null
                      ? `inc GST · ${formatCents(t.paidCents)} ex GST`
                      : "inc GST"
                }
                testid="gp-paid"
              />
            </div>
            <div className={cn("px-4 py-3 sm:px-6 sm:py-4", IN_CELLS[2])}>
              <Figure
                label="Owing"
                value={formatCents(t.dueIncGstCents)}
                muted={t.dueIncGstCents === 0}
                caption={overdueCount > 0 ? `inc GST · ${overdueCount} overdue` : "inc GST · on approved invoices"}
                testid="gp-owing"
              />
            </div>
          </dl>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 sm:px-6">
            <p className="text-xs text-text-muted" data-testid="gp-as-of">
              These are Xero&rsquo;s figures, last checked {agoLabel(data.statusAsOf)}. BuhlOS checks
              every hour.
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void checkNow()}
              disabled={checking}
              data-testid="gp-check-now"
            >
              {checking ? "Checking Xero…" : "Check Xero now"}
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-2 border-t border-border px-4 py-3 text-sm sm:px-6">
        {t.overContract && notPlanned != null ? (
          <p className="text-state-warning-subtle-text" data-testid="gp-over-contract">
            The planned stages add up to {formatCents(-notPlanned)} more than the contract. That is
            fine if it covers variations — otherwise check the amounts.
          </p>
        ) : null}
        {t.unresolvedCount > 0 ? (
          <p className="text-state-warning-subtle-text" data-testid="gp-unresolved">
            {t.unresolvedCount === 1 ? "One stage is" : `${t.unresolvedCount} stages are`} a
            percentage of the contract, and this job has no contract value yet. Set it on the Money
            card above and the amount fills in.
          </p>
        ) : null}
        <UnbilledLine data={data} onStart={() => setItemised({ mode: "add" })} />
        <RetentionLine data={data} run={run} />
        <RetentionHeldLine data={data} run={run} />
        <PaymentClaimLine data={data} run={run} />
        <XeroClientLine data={data} run={run} />
      </div>

      {banner ? (
        <p
          className={cn(
            "border-t border-border px-4 py-3 text-sm sm:px-6",
            banner.tone === "success"
              ? "text-state-success-subtle-text"
              : banner.tone === "warning"
                ? "text-state-warning-subtle-text"
                : "text-state-danger-subtle-text"
          )}
          role={banner.tone === "success" ? "status" : "alert"}
          data-testid="gp-banner"
        >
          {banner.text}
        </p>
      ) : null}

      {error ? (
        <p
          className="border-t border-border px-4 py-3 text-sm text-state-danger-subtle-text sm:px-6"
          role="alert"
          data-testid="gp-error"
        >
          {error}
        </p>
      ) : null}

      {data.stages.length === 0 ? (
        <p className="border-t border-border px-4 py-4 text-sm text-text-muted sm:px-6" data-testid="gp-empty">
          No invoices yet. For a job paid in stages, add the stages — all of them up front for a
          fixed schedule, or one each month for a monthly claim. For a small job, add an itemised
          invoice.
        </p>
      ) : (
        <ul className="border-t border-border" data-testid="gp-stages">
          {data.stages.map((s, i) => (
            <li
              key={s.id}
              className={cn("px-4 py-3 sm:px-6", i > 0 && "border-t border-border")}
              data-testid={`gp-stage-${s.id}`}
            >
              <StageRow
                stage={s}
                busy={busyId === s.id}
                confirmingRemove={removing === s.id}
                sendReady={data.xero.sendReady}
                actions={{
                  onEdit: () => {
                    setError(null);
                    if (s.kind === "itemised") setItemised({ mode: "edit", stage: s });
                    else setEditor({ mode: "edit", stage: s });
                  },
                  onAskRemove: () => setRemoving(s.id),
                  onCancelRemove: () => setRemoving(null),
                  onRemove: () => void doRemove(s),
                  onSend: () => {
                    setError(null);
                    setBanner(null);
                    setSendFor(s);
                  },
                  onCheck: () => void runSend(s, () => retrySend(s.id)),
                  onReset: () => void runSend(s, () => resetSend(s.id)),
                  onRaiseAgain: () => void doRaiseAgain(s),
                }}
              />
            </li>
          ))}
        </ul>
      )}

      <VariationsSection data={data} run={run} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-6">
        <p className="text-xs text-text-muted sm:flex-1" data-testid="gp-drafts-only">
          An invoice is sent to Xero as a draft. Approve and email it from Xero — BuhlOS never does
          either. What Xero says about payment shows here.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setError(null);
              setItemised({ mode: "add" });
            }}
            data-testid="gp-add-itemised"
          >
            Add itemised invoice
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setError(null);
              setEditor({ mode: "add" });
            }}
            data-testid="gp-add-stage"
          >
            Add stage
          </Button>
        </div>
      </div>

      {sendFor ? (
        <SendToXeroPreview
          stage={sendFor}
          onClose={() => setSendFor(null)}
          onSent={(res) => {
            setSendFor(null);
            settled(res);
          }}
          onProblem={async (code, status) => {
            setSendFor(null);
            await problem(code, status);
          }}
        />
      ) : null}

      {itemised ? (
        <ItemisedEditor
          jobId={data.jobId}
          jobRetentionBp={data.profile.retentionBp}
          stage={itemised.mode === "edit" ? itemised.stage : null}
          onClose={() => setItemised(null)}
          onSaved={(next) => {
            onData(next);
            setItemised(null);
            announceJobMoneyChanged(next.jobId);
          }}
          onStale={onStale}
        />
      ) : null}

      {editor ? (
        <StageEditor
          jobId={data.jobId}
          contractCents={contract}
          jobRetentionBp={data.profile.retentionBp}
          stage={editor.mode === "edit" ? editor.stage : null}
          onClose={() => setEditor(null)}
          onSaved={(next) => {
            onData(next);
            setEditor(null);
          }}
          onStale={onStale}
        />
      ) : null}
    </>
  );
}

function Figure({
  label,
  value,
  caption,
  muted,
  testid,
}: {
  label: string;
  value: string;
  caption?: string;
  muted?: boolean;
  testid: string;
}) {
  return (
    <div data-testid={testid}>
      <dt className="font-mono text-xs font-medium uppercase tracking-[0.14em] text-text-muted">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 font-display text-[26px] font-bold tabular-nums leading-none",
          muted ? "text-text-muted" : "text-text"
        )}
      >
        {value}
      </dd>
      {caption ? <p className="mt-1 text-xs text-text-muted">{caption}</p> : null}
    </div>
  );
}

/** Retention held back from each stage — optional, per job, edited inline. */
function RetentionLine({
  data,
  run,
}: {
  data: JobInvoicingResponse;
  run: (call: () => Mutation) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const bp = data.profile.retentionBp;

  async function save() {
    const next = parsePercentToBp(value || "0", { allowZero: true });
    if (next == null) {
      setInvalid(true);
      return;
    }
    setBusy(true);
    const ok = await run(() => saveRetention(data.jobId, next, data.profile.version));
    setBusy(false);
    if (ok) setEditing(false);
  }

  if (editing) {
    return (
      <div data-testid="gp-retention-edit">
        <label htmlFor="gp-retention-input" className="text-sm text-text">
          Retention held back from each stage (%)
        </label>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <input
            id="gp-retention-input"
            inputMode="decimal"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setInvalid(false);
            }}
            disabled={busy}
            placeholder="0"
            className="h-8 w-20 rounded-card border border-border bg-surface px-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy"
          />
          <Button size="sm" onClick={() => void save()} disabled={busy}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
        {invalid ? (
          <p className="mt-1 text-xs text-state-danger-subtle-text" role="alert">
            Enter a percentage between 0 and 100. Use 0 for no retention.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-text-muted" data-testid="gp-retention">
      <span>
        {bp > 0
          ? `Retention: ${formatBp(bp)} held back from each stage.`
          : "Retention: none on this job."}
      </span>
      <button
        type="button"
        className="font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        onClick={() => {
          setValue(bp > 0 ? bpToInput(bp) : "");
          setInvalid(false);
          setEditing(true);
        }}
      >
        Change
      </button>
    </p>
  );
}

/**
 * Retention already held on sent stages, and the way to get it back: a
 * release is its own stage, added here and then sent like any other.
 */
function RetentionHeldLine({
  data,
  run,
}: {
  data: JobInvoicingResponse;
  run: (call: () => Mutation) => Promise<boolean>;
}) {
  const held = data.totals.retentionHeldCents;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<string | null>(null);
  if (held <= 0) return null;

  async function add() {
    const cents = parseDollarsToCents(value);
    if (cents == null) return setInvalid("Enter the amount to release in dollars.");
    if (cents > held) return setInvalid(`Only ${formatCents(held)} is held on this job.`);
    setBusy(true);
    const ok = await run(() => addRetentionRelease(data.jobId, cents));
    setBusy(false);
    if (ok) setEditing(false);
  }

  if (editing) {
    return (
      <div data-testid="gp-release-edit">
        <label htmlFor="gp-release-input" className="text-sm text-text">
          Retention to release ($ ex GST) — {formatCents(held)} is held
        </label>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <input
            id="gp-release-input"
            inputMode="decimal"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setInvalid(null);
            }}
            disabled={busy}
            className="h-8 w-32 rounded-card border border-border bg-surface px-2 text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-navy"
          />
          <Button size="sm" onClick={() => void add()} disabled={busy}>
            Add release stage
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
        {invalid ? (
          <p className="mt-1 text-xs text-state-danger-subtle-text" role="alert">
            {invalid}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-text-muted" data-testid="gp-retention-held">
      <span>
        Retention held so far: <span className="font-medium text-text">{formatCents(held)}</span>.
      </span>
      <button
        type="button"
        className="font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        onClick={() => {
          setValue(centsToInput(held));
          setInvalid(null);
          setEditing(true);
        }}
      >
        Release retention
      </button>
    </p>
  );
}

/**
 * What on this job is not on an invoice yet (#1162) — the hours and materials
 * that have been logged and never billed, including ones that arrived after an
 * invoice went out. Only asked for on a job that is billed by the hour: one
 * with no contract value, or one that already has an itemised invoice. Reads
 * every time sheet, so it loads after the card and never holds it up.
 */
function UnbilledLine({ data, onStart }: { data: JobInvoicingResponse; onStart: () => void }) {
  const relevant = data.job.contractCents == null || data.stages.some((s) => s.kind === "itemised");
  // Re-read only when what is on an invoice could have changed.
  const stamp = data.stages
    .filter((s) => s.kind === "itemised")
    .map((s) => `${s.id}:${s.version}:${s.xeroStatus ?? ""}`)
    .join("|");
  const [found, setFound] = useState<{ hoursMilli: number; count: number; costCents: number; anyBilled: boolean } | null>(null);

  useEffect(() => {
    if (!relevant) return;
    let live = true;
    void jobBillable(data.jobId).then((res) => {
      if (!live || !res.ok) return;
      const s = res.data.summary;
      setFound({ hoursMilli: s.unbilledHoursMilli, count: s.unbilledMaterialCount, costCents: s.unbilledMaterialCostCents, anyBilled: s.anyBilled });
    });
    return () => {
      live = false;
    };
  }, [relevant, data.jobId, stamp]);

  if (!relevant || !found) return null;
  const parts = [
    found.hoursMilli > 0 ? `${formatHours(found.hoursMilli)} of approved hours` : null,
    found.count > 0
      ? `${found.count} materials ${found.count === 1 ? "item" : "items"} (cost ${formatCents(found.costCents)})`
      : null,
  ].filter(Boolean);
  if (parts.length === 0) {
    return found.anyBilled ? (
      <p className="text-text-muted" data-testid="gp-unbilled-none">
        Everything logged on this job is on an invoice.
      </p>
    ) : null;
  }
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-state-warning-subtle-text" data-testid="gp-unbilled">
      <span>Not yet on an invoice: {parts.join(" and ")}.</span>
      <button
        type="button"
        className="font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        onClick={onStart}
      >
        Start an invoice
      </button>
    </p>
  );
}

/** The sentence s 13(2)(c) of the SA Act asks a payment claim to carry. */
const CLAIM_SENTENCE =
  "This is a payment claim made under the Building and Construction Industry Security of Payment Act 2009 (SA).";

/**
 * Payment-claim wording (#1164): off unless the office turns it on for this
 * job. Before it is turned on, the exact sentence is shown — it goes on every
 * invoice sent for the job from then on, with where the claim stands against
 * the contract.
 */
function PaymentClaimLine({
  data,
  run,
}: {
  data: JobInvoicingResponse;
  run: (call: () => Mutation) => Promise<boolean>;
}) {
  const on = data.profile.paymentClaim === true;
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  async function set(next: boolean) {
    setBusy(true);
    const ok = await run(() => setPaymentClaim(data.jobId, next, data.profile.version));
    setBusy(false);
    if (ok) setAsking(false);
  }

  if (asking) {
    return (
      <div className="grid gap-1.5" data-testid="gp-claim-ask">
        <p className="text-sm text-text">
          {on ? "Stop adding this to this job's invoices?" : "Add this to every invoice sent for this job?"}
        </p>
        <p className="rounded-card border border-border bg-surface-subtle px-2 py-1.5 text-xs text-text">
          {CLAIM_SENTENCE}
        </p>
        {!on ? (
          <p className="text-xs text-text-muted">
            It makes each invoice a payment claim under the Act, with the contract, claimed-to-date and
            remaining figures under it. It is for builder and commercial jobs; the Act doesn&rsquo;t cover
            work for an owner who lives in the home. Check with your adviser if you are unsure.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" onClick={() => void set(!on)} disabled={busy} data-testid="gp-claim-confirm">
            {on ? "Yes, stop" : "Yes, add it"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setAsking(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <p className="flex flex-wrap items-baseline gap-x-2 text-text-muted" data-testid="gp-claim">
      <span>
        {on
          ? "Payment-claim wording: on. Invoices sent for this job say they are a claim under the SA Security of Payment Act."
          : "Payment-claim wording: off."}
      </span>
      <button
        type="button"
        className="font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
        onClick={() => setAsking(true)}
      >
        Change
      </button>
    </p>
  );
}
