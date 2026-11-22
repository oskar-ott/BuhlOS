"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardKicker } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import {
  JOB_CONTRACT_CHANGED_EVENT,
  errorCodeOf,
  jobInvoicing,
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
import { SendToXeroPreview } from "./SendToXeroPreview";
import { StageEditor } from "./StageEditor";
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
        <p className="text-xs text-text-muted">Stage invoices for this job · all figures ex GST</p>
      </div>

      {state === "error" ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-4 sm:px-6">
          <p className="text-sm text-text-muted" role="alert">
            Couldn&rsquo;t load the stage invoices. {loadError}
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
  const [removing, setRemoving] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sendFor, setSendFor] = useState<Stage | null>(null);
  const [checking, setChecking] = useState(false);
  const [banner, setBanner] = useState<{ tone: "success" | "warning" | "danger"; text: string } | null>(null);

  const t = data.totals;
  const contract = data.job.contractCents;
  const notPlanned =
    contract == null ? null : contract - t.claimedCents - t.plannedGrossCents;

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
      : `${t.plannedCount} ${t.plannedCount === 1 ? "stage" : "stages"}${
          t.unresolvedCount > 0 ? ` · ${t.unresolvedCount} not worked out` : ""
        }`;

  const overdueCount = data.stages.filter((s) => s.display === "overdue").length;

  const stillCaption =
    contract == null
      ? "set the contract value on the Money card"
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
            label="Contract"
            value={contract == null ? "—" : formatCents(contract)}
            muted={contract == null}
            caption={contract == null ? "not set" : undefined}
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
        <RetentionLine data={data} run={run} />
        <RetentionHeldLine data={data} run={run} />
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
          No stage invoices yet. Add the stages this job will be paid in — all of them up front for
          a fixed schedule, or one each month for a monthly claim.
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
                    setEditor({ mode: "edit", stage: s });
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

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-6">
        <p className="text-xs text-text-muted" data-testid="gp-drafts-only">
          A stage is sent to Xero as a draft. Approve and email it from Xero — BuhlOS never does
          either. What Xero says about payment shows here.
        </p>
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
