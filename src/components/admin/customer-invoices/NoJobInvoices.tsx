"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import {
  errorCodeOf,
  jobInvoicing,
  raiseAgain,
  refreshJobInvoices,
  removeStage,
  resetSend,
  retrySend,
} from "@/domains/customer-invoices/client";
import {
  XERO_SETTINGS_PATH,
  agoLabel,
  errorMessage,
  formatCents,
  refreshMessage,
  sendOutcomeMessage,
  xeroBlocker,
} from "@/domains/customer-invoices/format";
import {
  NO_JOB_ID,
  type JobInvoicingResponse,
  type SendResponse,
  type Stage,
} from "@/domains/customer-invoices/schema";
import type { HttpResult } from "@/lib/http";
import { ItemisedEditor } from "./ItemisedEditor";
import { SendToXeroPreview } from "./SendToXeroPreview";
import { StageRow } from "./StageRow";

const LINK =
  "font-medium text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2";

/**
 * /getting-paid — invoices that are NOT tied to a job (#1166,
 * customer_invoices, dark; docs/customer-invoices.md → "An invoice with no
 * job").
 *
 * Some money comes in once a month against a builder's payment schedule
 * (Payapps and the like), not job by job. The office raises ONE invoice for
 * it here: who it is for (a Xero contact), what it is for, and its lines.
 * It goes to Xero as a DRAFT through the same send a job's invoice uses —
 * previewed first, created once, read back and compared — and what Xero says
 * about approval and payment comes back onto its row.
 *
 * Honesty rules (the same as the job card):
 *   - nothing is totalled until something has been sent, and then the
 *     figures are Xero's, with how long ago they were checked;
 *   - an invoice that can't be sent yet says why on its Send preview;
 *   - a failed read says so and offers a retry.
 *
 * It does NOT show a job's invoices: those stay on the job.
 */
export function NoJobInvoices() {
  const [data, setData] = useState<JobInvoicingResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await jobInvoicing(NO_JOB_ID);
    if (!res.ok) {
      setLoadError(errorMessage(errorCodeOf(res.error.body), res.error.status));
      setState((prev) => (prev === "ready" ? prev : "error"));
      return;
    }
    setData(res.data);
    setLoadError(null);
    setState("ready");
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card role="region" aria-label="Invoices with no job" className="p-0" data-testid="no-job-invoices">
      {state === "error" ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
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
          data-testid="no-job-skeleton"
          aria-hidden="true"
        />
      ) : (
        <NoJobInvoicesBody data={data} onData={setData} onStale={load} />
      )}
    </Card>
  );
}

// The money-in strip (three cells): stacked on the phone, a divided row from sm.
const IN_CELLS = [
  "border-b border-border sm:border-b-0",
  "border-b border-border sm:border-b-0 sm:border-l",
  "border-border sm:border-l",
];

type Mutation = Promise<HttpResult<JobInvoicingResponse>>;

/** Can this invoice be sent as far as the page can tell (the preview says
 *  the rest)? Xero is ready, and a client from THIS organisation is chosen. */
export function canSend(data: JobInvoicingResponse, stage: Stage): boolean {
  return data.xero.sendReady && !!stage.clientContactId && !stage.clientOtherOrganisation;
}

/**
 * The loaded page body. `onData` receives the refreshed list every mutation
 * answers with; `onStale` re-reads after a conflict so nobody is left looking
 * at a row that has moved on.
 */
export function NoJobInvoicesBody({
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
  const x = data.xero;
  const blocker = xeroBlocker(x.state);
  const overdueCount = data.stages.filter((s) => s.display === "overdue").length;

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
  }

  /** "Check Xero now": ask Xero what happened to the invoices sent from here. */
  async function checkNow() {
    setChecking(true);
    setError(null);
    setBanner(null);
    const res = await refreshJobInvoices(NO_JOB_ID);
    setChecking(false);
    if (!res.ok) {
      await problem(errorCodeOf(res.error.body), res.error.status);
      return;
    }
    onData(res.data);
    setBanner(refreshMessage(res.data.refresh));
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
      setBanner({
        tone: "success",
        text: `${stage.invoiceNumber ?? "That number"} is left as it is. A new copy of the invoice is ready to send under the next number.`,
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

  return (
    <>
      {blocker ? (
        <p
          className="flex flex-wrap items-baseline gap-x-2 border-b border-border px-4 py-3 text-sm text-text-muted sm:px-6"
          data-testid="no-job-xero-blocked"
        >
          <span>{blocker.message} You can still write an invoice; it can&rsquo;t be sent until this is fixed.</span>
          <a href={XERO_SETTINGS_PATH} className={LINK}>
            {blocker.action}
          </a>
        </p>
      ) : !x.settingsComplete ? (
        <p
          className="flex flex-wrap items-baseline gap-x-2 border-b border-border px-4 py-3 text-sm text-text-muted sm:px-6"
          data-testid="no-job-settings-incomplete"
        >
          <span>
            The sales account, GST rate and payment terms aren&rsquo;t chosen yet, so an invoice
            can&rsquo;t be sent.
          </span>
          <a href={XERO_SETTINGS_PATH} className={LINK}>
            Choose them in the Xero settings
          </a>
        </p>
      ) : null}

      {t.sentCount > 0 ? (
        <div className="border-b border-border" data-testid="no-job-money-in">
          <dl className="grid grid-cols-1 sm:grid-cols-3">
            <div className={cn("px-4 py-3 sm:px-6 sm:py-4", IN_CELLS[0])}>
              <Figure
                label="Approved in Xero"
                value={formatCents(t.invoicedCents)}
                muted={t.invoicedCents === 0}
                caption={t.draftedCents > 0 ? `${formatCents(t.draftedCents)} more is still a draft` : "ex GST"}
                testid="no-job-invoiced"
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
                testid="no-job-paid"
              />
            </div>
            <div className={cn("px-4 py-3 sm:px-6 sm:py-4", IN_CELLS[2])}>
              <Figure
                label="Owing"
                value={formatCents(t.dueIncGstCents)}
                muted={t.dueIncGstCents === 0}
                caption={overdueCount > 0 ? `inc GST · ${overdueCount} overdue` : "inc GST · on approved invoices"}
                testid="no-job-owing"
              />
            </div>
          </dl>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 sm:px-6">
            <p className="text-xs text-text-muted" data-testid="no-job-as-of">
              These are Xero&rsquo;s figures, last checked {agoLabel(data.statusAsOf)}. BuhlOS checks
              every hour.
            </p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void checkNow()}
              disabled={checking}
              data-testid="no-job-check-now"
            >
              {checking ? "Checking Xero…" : "Check Xero now"}
            </Button>
          </div>
        </div>
      ) : null}

      {banner ? (
        <p
          className={cn(
            "border-b border-border px-4 py-3 text-sm sm:px-6",
            banner.tone === "success"
              ? "text-state-success-subtle-text"
              : banner.tone === "warning"
                ? "text-state-warning-subtle-text"
                : "text-state-danger-subtle-text"
          )}
          role={banner.tone === "success" ? "status" : "alert"}
          data-testid="no-job-banner"
        >
          {banner.text}
        </p>
      ) : null}

      {error ? (
        <p
          className="border-b border-border px-4 py-3 text-sm text-state-danger-subtle-text sm:px-6"
          role="alert"
          data-testid="no-job-error"
        >
          {error}
        </p>
      ) : null}

      {data.stages.length === 0 ? (
        <p className="px-4 py-4 text-sm text-text-muted sm:px-6" data-testid="no-job-empty">
          No invoices here yet. Use this for money that isn&rsquo;t billed job by job, such as one
          invoice a month against a builder&rsquo;s payment schedule.
        </p>
      ) : (
        <ul data-testid="no-job-list">
          {data.stages.map((s, i) => (
            <li
              key={s.id}
              className={cn("px-4 py-3 sm:px-6", i > 0 && "border-t border-border")}
              data-testid={`no-job-invoice-${s.id}`}
            >
              <StageRow
                stage={s}
                busy={busyId === s.id}
                confirmingRemove={removing === s.id}
                sendReady={canSend(data, s)}
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
        <p className="text-xs text-text-muted sm:flex-1" data-testid="no-job-drafts-only">
          An invoice is sent to Xero as a draft. Approve and email it from Xero — BuhlOS never does
          either. What Xero says about payment shows here. Figures are ex GST.
        </p>
        <Button
          size="sm"
          onClick={() => {
            setError(null);
            setEditor({ mode: "add" });
          }}
          data-testid="no-job-add"
        >
          New invoice
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
        <ItemisedEditor
          jobId={NO_JOB_ID}
          jobRetentionBp={0}
          stage={editor.mode === "edit" ? editor.stage : null}
          noJob={{ organisationName: x.organisationName, canChoose: x.state === "connected" }}
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
      <dt className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</dt>
      <dd
        className={cn(
          "mt-1 font-display text-xl tabular-nums",
          muted ? "text-text-muted" : "text-text"
        )}
      >
        {value}
      </dd>
      {caption ? <p className="mt-0.5 text-xs text-text-muted">{caption}</p> : null}
    </div>
  );
}
