"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardKicker } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import {
  JOB_CONTRACT_CHANGED_EVENT,
  errorCodeOf,
  jobInvoicing,
  removeStage,
  saveRetention,
} from "@/domains/customer-invoices/client";
import {
  STATUS_LABEL,
  STATUS_TONE,
  bpToInput,
  errorMessage,
  formatBp,
  formatCents,
  formatDay,
  parsePercentToBp,
} from "@/domains/customer-invoices/format";
import type { JobInvoicingResponse, Stage } from "@/domains/customer-invoices/schema";
import type { HttpResult } from "@/lib/http";
import { StageEditor } from "./StageEditor";
import { XeroClientLine } from "./XeroClientLine";

/**
 * Admin job hub — "Getting paid" (customer_invoices, dark; #1148 + #1149,
 * docs/customer-invoices.md). The job's payment stages: a fixed schedule added
 * up front, or one stage added each month for a monthly claim. Each stage is
 * dollars or a % of the contract, with optional extra lines and an optional
 * retention % held back. Below the retention line, the job's client is linked
 * to a Xero contact (#1149) so an invoice will know who it is for.
 *
 * NOTHING IS SENT TO XERO FROM HERE YET and the card says so — there is no
 * Send button, no "invoiced" and no "paid" figure, because none of those
 * exist until #1150–#1151 land (no fake UI). The Xero calls behind this card
 * are reads only.
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

// Figure-strip cell borders: stacked on the phone, one divided row from sm up.
const CELLS = [
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
      ? "no stages yet"
      : `${t.plannedCount} ${t.plannedCount === 1 ? "stage" : "stages"}${
          t.unresolvedCount > 0 ? ` · ${t.unresolvedCount} not worked out` : ""
        }`;

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
      <dl className="mt-4 grid grid-cols-1 border-t border-border sm:grid-cols-3">
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
            label="Still to invoice"
            value={t.stillToInvoiceCents == null ? "—" : formatCents(t.stillToInvoiceCents)}
            muted={t.stillToInvoiceCents == null}
            caption={stillCaption}
            testid="gp-still"
          />
        </div>
      </dl>

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
        <XeroClientLine data={data} run={run} />
      </div>

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
                onEdit={() => {
                  setError(null);
                  setEditor({ mode: "edit", stage: s });
                }}
                onAskRemove={() => setRemoving(s.id)}
                onCancelRemove={() => setRemoving(null)}
                onRemove={() => void doRemove(s)}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-6">
        <p className="text-xs text-text-muted" data-testid="gp-plan-only">
          This is the plan only. Nothing is sent to Xero from here yet.
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

function basisCaption(stage: Stage): string {
  const base =
    stage.basis === "percent" ? `${formatBp(stage.percentBp)} of contract` : "fixed amount";
  const extras = stage.extraLines.length;
  return extras > 0 ? `${base} + ${extras} extra ${extras === 1 ? "line" : "lines"}` : base;
}

function StageRow({
  stage,
  busy,
  confirmingRemove,
  onEdit,
  onAskRemove,
  onCancelRemove,
  onRemove,
}: {
  stage: Stage;
  busy: boolean;
  confirmingRemove: boolean;
  onEdit: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}) {
  const c = stage.computed;
  const planned = stage.state === "planned";
  const hasRetention = c.retentionCents != null && c.retentionCents > 0;
  return (
    // Stacked on a phone (name and details, then the amount and actions
    // underneath); side by side from sm up.
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 sm:flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-text">{stage.title}</span>
          <Pill tone={STATUS_TONE[stage.display]} dot>
            {STATUS_LABEL[stage.display]}
          </Pill>
        </div>
        <p className="mt-0.5 text-xs text-text-muted">
          {basisCaption(stage)}
          {stage.plannedDate ? ` · planned for ${formatDay(stage.plannedDate)}` : ""}
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
      </div>

      <div className="sm:text-right">
        {c.grossCents == null ? (
          <p className="text-sm text-text-muted" data-testid="gp-stage-unresolved">
            {c.reason === "no_contract_value" ? "needs a contract value" : "can't be worked out"}
          </p>
        ) : (
          <>
            <p className="font-display text-lg font-bold tabular-nums text-text">
              {formatCents(c.grossCents)}
            </p>
            {hasRetention ? (
              <p className="text-xs text-text-muted" data-testid="gp-stage-retention">
                less {formatBp(c.retentionBp)} retention {formatCents(c.retentionCents)} ·{" "}
                {formatCents(c.netCents)} to invoice
              </p>
            ) : null}
          </>
        )}
        {planned ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 sm:justify-end">
            {confirmingRemove ? (
              <>
                <span className="w-full text-xs text-text-muted sm:w-auto">Remove this stage?</span>
                <Button size="sm" variant="danger" onClick={onRemove} disabled={busy}>
                  Yes, remove
                </Button>
                <Button size="sm" variant="ghost" onClick={onCancelRemove} disabled={busy}>
                  Keep
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="secondary" onClick={onEdit} disabled={busy}>
                  Edit
                </Button>
                <Button size="sm" variant="ghost" onClick={onAskRemove} disabled={busy}>
                  Remove
                </Button>
              </>
            )}
          </div>
        ) : null}
      </div>
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
