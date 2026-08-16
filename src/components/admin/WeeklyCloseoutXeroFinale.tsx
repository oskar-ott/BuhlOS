"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { formatHoursLabel } from "@/domains/timesheets/format";
import {
  buildReviewPlan,
  chooseBatchForPeriod,
  nextBatchStep,
  pushNeedsAttention,
  summarisePushResult,
  xeroFinaleAccess,
  type ExcludedWorker,
  type PushResultSummary,
  type ReviewCandidate,
  type ReviewPlan,
  type ValidationLike,
  type XeroFinaleAccess,
} from "@/domains/timesheets/xero-closeout";

/**
 * WeeklyCloseoutXeroFinale (#249 consumer) — the last screen of the phone
 * weekly closeout (lean-reset redesign, replica mobile frames). Once the boss
 * has reviewed the crew, the approved week goes to Xero as DRAFT timesheets;
 * he reviews and posts the pay run in Xero.
 *
 * It replaces the old "Week reviewed" panel outright, so there is no flicker
 * between "done" and "here's the Xero state" — one screen that tells the truth
 * about whichever situation it's in.
 *
 * HONESTY (P7 / ADR #609 P8):
 * - Opening this screen WRITES NOTHING. The review reads the batch engine's
 *   `preview` action, which persists nothing — backing out never leaves a
 *   stray batch behind.
 * - Unmapped workers are rendered from the engine's OWN validation findings:
 *   reported as an ERROR they block the push and this screen says so; reported
 *   as a WARNING (skip-with-warning engine) their hours are named as staying
 *   out of this push. Never a partial-push promise the engine will refuse.
 * - "Created" counts only timesheets Xero accepted AND that read back matching.
 * - A disconnected or read-only Xero is stated, never hidden.
 *
 * Every decision behind this UI is a pure function in domains/timesheets/
 * xero-closeout.ts — the repo's vitest env is node-only, so logic in JSX is
 * logic nobody can test.
 */

type Stage = "review" | "sending" | "pushed";

export interface XeroFinaleGate {
  isAdmin: boolean;
  connectionFlag: boolean;
  exportFlag: boolean;
  /**
   * Owner pull 2026-08-15/16: the /settings recipient list has at least one
   * address, so the temporary email-to-accounts process owns the closeout
   * finale slot — the review sheet mounts WeeklyCloseoutSendFinale instead of
   * this Xero finale (whatever the Xero flags say). Empty the list and Xero
   * gets the slot back.
   */
  accountsConfigured?: boolean;
}

interface Props {
  /** ISO YYYY-MM-DD — the closeout week, fed straight to the batch engine. */
  weekStart: string;
  weekEnd: string;
  /** Human period label, e.g. "Mon 20 May – Sun 26 May". Display only. */
  periodLabel: string;
  /** How many workers the boss just stepped through. */
  reviewedCount: number;
  /** Server-resolved flags + role. Unavailable → the plain reviewed panel. */
  gate: XeroFinaleGate;
  /** Approved hours per worker, already computed for the crew cards. */
  candidates: ReviewCandidate[];
  onClose: () => void;
  /** Raised while a push is in flight so the sheet can't be dismissed under it. */
  onBusyChange?: (busy: boolean) => void;
}

type Batch = { id: string; status: string; revision?: number };

export function WeeklyCloseoutXeroFinale({
  weekStart,
  weekEnd,
  periodLabel,
  reviewedCount,
  gate,
  candidates,
  onClose,
  onBusyChange,
}: Props) {
  const available = gate.isAdmin && gate.connectionFlag && gate.exportFlag;

  const [stage, setStage] = useState<Stage>("review");
  const [loading, setLoading] = useState(available);
  const [access, setAccess] = useState<XeroFinaleAccess>({ kind: "unavailable" });
  const [orgName, setOrgName] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationLike | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PushResultSummary | null>(null);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Read-only reconnaissance on open: is Xero usable, and does this period
  // validate? Neither call writes.
  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    (async () => {
      try {
        const statusRes = await fetch("/api/xero/status", { cache: "no-store" });
        const status = statusRes.ok ? await statusRes.json() : null;
        const gated = xeroFinaleAccess({
          ...gate,
          connectionState: status?.state ?? null,
          grantedScopes: status?.grantedScopes ?? null,
        });
        if (cancelled) return;
        setAccess(gated);
        setOrgName(status?.organisationName ?? null);
        if (gated.kind !== "ready") {
          setLoading(false);
          return;
        }
        const res = await fetch("/api/xero/payroll-batches", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "preview", periodStart: weekStart, periodEnd: weekEnd }),
        });
        const data = await res.json().catch(() => null);
        if (cancelled) return;
        if (!res.ok) {
          setError(data?.error || "Couldn't check this week against Xero.");
        } else {
          setValidation(data?.validation ?? null);
        }
      } catch {
        if (!cancelled) setError("Couldn't reach Xero — check the connection and try again.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // gate is a stable server-resolved object for the life of the sheet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, weekStart, weekEnd]);

  const plan: ReviewPlan = buildReviewPlan(candidates, validation);

  const post = useCallback(async (url: string, body: unknown) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error || `Request failed (${res.status})`);
    }
    return data;
  }, []);

  const push = useCallback(async () => {
    setStage("sending");
    setError(null);
    onBusyChange?.(true);
    try {
      // Reuse the period's existing batch rather than forking a second one —
      // this is what keeps a retry from creating duplicate drafts.
      const listRes = await fetch(
        `/api/xero/payroll-batches?periodStart=${weekStart}&periodEnd=${weekEnd}`,
        { cache: "no-store" },
      );
      const listData = listRes.ok ? await listRes.json() : null;
      let batch: Batch | null = chooseBatchForPeriod<Batch>(listData?.batches ?? []);

      let step = nextBatchStep(batch);
      if (step === "correction") {
        // An earlier attempt at this period is sitting blocked or unlocked.
        // The push button only appears when LIVE validation is clean, so the
        // problem has since been fixed — make a fresh batch rather than
        // dead-ending the boss on a stale one. (The inert old batch stays for
        // the desktop to tidy; the engine allows several per period.)
        batch = null;
        step = "create";
      }
      if (step === "create") {
        const created = await post("/api/xero/payroll-batches", {
          action: "create",
          periodStart: weekStart,
          periodEnd: weekEnd,
        });
        batch = created?.batch ?? null;
        if (!batch) throw new Error("Xero batch wasn't created.");
        step = nextBatchStep(batch);
      }
      if (step === "correction") {
        throw new Error(
          "The week didn't pass validation when the batch was created — fix the named problems and send again.",
        );
      }
      if (step === "lock") {
        const locked = await post("/api/xero/payroll-batches", { action: "lock", id: batch!.id });
        batch = locked?.batch ?? batch;
      }
      if (nextBatchStep(batch) === "done") {
        // Already fully exported. Nothing happened, so don't show a "pushed"
        // screen — and don't enumerate who is in Xero, because this path never
        // read the per-worker state and must not assert what it didn't check.
        throw new Error(
          "This week has already been sent to Xero. Check the draft timesheets there — nothing was sent again.",
        );
      }

      const action = batch!.status === "locked" ? "export" : "retry";
      const run = await post("/api/xero/payroll-export", { action, batchId: batch!.id });
      const hoursByName = new Map(plan.rows.map((r) => [r.workerName, r.hours]));
      if (!alive.current) return;
      setResult(summarisePushResult(run?.workers ?? [], hoursByName));
      setSentAt(new Date().toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" }));
      setStage("pushed");
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof Error ? e.message : "Couldn't reach Xero — try again.");
      setStage("review");
    } finally {
      onBusyChange?.(false);
    }
  }, [post, weekStart, weekEnd, plan.rows, onBusyChange]);

  // ── the plain reviewed panel — no Xero on this device/session ──────────────
  if (!available) {
    return (
      <FinaleShell
        title="Week reviewed"
        onClose={onClose}
        footer={
          <Button className="w-full" onClick={onClose}>
            Done
          </Button>
        }
      >
        <ReviewedMark count={reviewedCount} />
        <p className="rounded-card border border-border bg-surface-subtle p-3 text-xs text-text-muted">
          Payroll export and the full audit trail run in{" "}
          <b className="font-semibold text-text">BuhlOS on desktop</b>. You approve on the move; the
          numbers land there.
        </p>
      </FinaleShell>
    );
  }

  if (stage === "sending") {
    return (
      <FinaleShell title="Sending to Xero" onClose={onClose}>
        <div
          data-testid="wha-xero-sending"
          className="flex flex-col items-center gap-3 py-10 text-center"
        >
          <Loader2
            aria-hidden="true"
            className="h-10 w-10 animate-spin text-brand-xero motion-reduce:animate-none"
          />
          <p className="font-display text-lg font-bold text-text">Sending to Xero…</p>
          <p className="text-sm text-text-muted">Creating draft timesheets for {periodLabel}.</p>
        </div>
      </FinaleShell>
    );
  }

  if (stage === "pushed" && result) {
    return (
      <PushedPanel
        result={result}
        orgName={orgName}
        periodLabel={periodLabel}
        sentAt={sentAt}
        plan={plan}
        onClose={onClose}
        onRetry={push}
      />
    );
  }

  return (
    <FinaleShell
      title="Week reviewed"
      onClose={onClose}
      footer={
        <div className="space-y-1.5">
          {access.kind === "ready" && plan.canPush ? (
            <Button
              className="w-full bg-brand-xero text-white shadow-card hover:bg-brand-xero-hover active:bg-brand-xero-hover"
              data-testid="wha-xero-push"
              onClick={push}
            >
              <UploadCloud aria-hidden="true" className="h-4 w-4" />
              Push {plan.sendCount} {plan.sendCount === 1 ? "timesheet" : "timesheets"} to Xero
            </Button>
          ) : null}
          {access.kind === "ready" && plan.canPush ? (
            <Button variant="ghost" className="w-full text-text-muted" onClick={onClose}>
              Not now
            </Button>
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
          access.kind === "ready"
            ? "Approved hours are ready to send to Xero as draft timesheets."
            : undefined
        }
      />

      {loading ? (
        <p className="flex items-center justify-center gap-2 text-sm text-text-muted">
          <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin motion-reduce:animate-none" />
          Checking Xero…
        </p>
      ) : null}

      {error ? (
        <Notice tone="danger" title="Couldn&rsquo;t reach Xero">
          {error}
        </Notice>
      ) : null}

      {!loading && access.kind === "connect" ? (
        <Notice tone="muted" title="Xero isn&rsquo;t connected">
          Connect Xero in BuhlOS on desktop, then the week can be sent from here.
        </Notice>
      ) : null}

      {!loading && access.kind === "reconnect" ? (
        <Notice tone="muted" title="Xero is connected read-only">
          This connection was made before timesheet sending was switched on. Reconnect Xero on
          desktop to grant it, then send from here.
        </Notice>
      ) : null}

      {!loading && access.kind === "ready" ? (
        <>
          {/* Sending-to card — org + period, per the replica. */}
          <div className="flex items-center gap-3 rounded-card border border-border p-3.5">
            <span
              aria-hidden="true"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-card bg-sky-50 font-display text-xs font-extrabold text-sky-700"
            >
              Xero
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[9px] uppercase tracking-widest text-text-muted">
                Sending to
              </p>
              <p className="truncate font-display text-[15px] font-bold text-text">
                {orgName || "Connected Xero organisation"}
              </p>
              <p className="text-xs text-text-muted">Pay period {periodLabel}</p>
            </div>
          </div>

          <PushRowList plan={plan} />

          {/* Withheld (skip-with-warning engine): named workers whose hours
              stay OUT of this push — the push itself still goes ahead. */}
          {plan.withheld.length > 0 ? (
            <WithheldNotice workers={plan.withheld} />
          ) : null}

          {/* Blocking, worker-scoped (all-or-nothing engine): one unmapped
              worker holds the whole period — say so, offer no push. */}
          {plan.workerIssues.length > 0 ? (
            <Notice tone="warn" title="The week can&rsquo;t be sent yet">
              <span className="font-semibold">
                {plan.workerIssues.map((i) => i.workerName).join(", ")}
              </span>{" "}
              — {plan.workerIssues[0]!.message} Xero takes the period as a whole, so nothing sends
              until that&rsquo;s fixed.
            </Notice>
          ) : null}

          {plan.generalIssues.map((issue) => (
            <Notice key={issue.code} tone="warn" title="This period isn&rsquo;t ready">
              {issue.message}
            </Notice>
          ))}

          {plan.warnings.map((w) => (
            <Notice key={w.code} tone="muted" title="Worth knowing">
              {w.message}
            </Notice>
          ))}
        </>
      ) : null}
    </FinaleShell>
  );
}

function PushedPanel({
  result,
  orgName,
  periodLabel,
  sentAt,
  plan,
  onClose,
  onRetry,
}: {
  result: PushResultSummary;
  orgName: string | null;
  periodLabel: string;
  sentAt: string | null;
  plan: ReviewPlan;
  onClose: () => void;
  onRetry: () => void;
}) {
  const needsAttention = pushNeedsAttention(result);
  // Workers still without a Xero employee ID after the push — withheld
  // (warning engine) or named blocking issues (all-or-nothing engine).
  const stillUnmapped = [...plan.withheld, ...plan.workerIssues];
  return (
    <FinaleShell
      title={result.created > 0 ? "Pushed to Xero" : "Nothing was sent"}
      onClose={onClose}
      footer={
        <div className="space-y-1.5">
          {needsAttention ? (
            <Button className="w-full" onClick={onRetry} data-testid="wha-xero-retry">
              <RefreshCw aria-hidden="true" className="h-4 w-4" />
              Try again
            </Button>
          ) : null}
          <Button
            variant={needsAttention ? "secondary" : "primary"}
            className="w-full"
            onClick={onClose}
          >
            Done
          </Button>
        </div>
      }
    >
      <div data-testid="wha-xero-pushed" className="flex flex-col items-center gap-3 py-2 text-center">
        <span
          className={cn(
            "flex h-14 w-14 items-center justify-center rounded-full",
            result.created > 0 ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-900",
          )}
        >
          {result.created > 0 ? (
            <Check aria-hidden="true" className="h-7 w-7" />
          ) : (
            <AlertTriangle aria-hidden="true" className="h-7 w-7" />
          )}
        </span>
        {result.created > 0 ? (
          <p className="mx-auto max-w-[32ch] text-sm leading-relaxed text-text-muted">
            <b className="font-semibold text-text">
              {result.created} draft {result.created === 1 ? "timesheet" : "timesheets"}
            </b>{" "}
            created in {orgName || "Xero"} for {periodLabel}. Review and post them in Xero to finish
            the pay run.
          </p>
        ) : (
          <p className="text-sm text-text-muted">No draft timesheets were created for {periodLabel}.</p>
        )}
      </div>

      {/* Receipt rows, per the replica. */}
      <dl className="rounded-card border border-border px-3.5 py-1">
        <ReceiptRow label="Draft timesheets" value={String(result.created)} />
        <ReceiptRow label="Approved hours" value={formatHoursLabel(result.createdHours)} />
        <ReceiptRow label="Sent" value={sentAt || "—"} last />
      </dl>

      {result.drifted.length > 0 ? (
        <Notice tone="warn" title="Sent, but Xero read back something different">
          {result.drifted.map((d) => `${d.workerName}: ${d.message}`).join(" · ")} Check these in
          Xero before posting the pay run.
        </Notice>
      ) : null}

      {result.failed.length > 0 ? (
        <Notice tone="danger" title="Xero didn&rsquo;t accept these">
          {result.failed.map((f) => `${f.workerName}${f.message ? ` (${f.message})` : ""}`).join(", ")}
        </Notice>
      ) : null}

      {result.blocked.length > 0 ? (
        <Notice tone="warn" title="Held back">
          {result.blocked.map((b) => `${b.workerName}${b.message ? ` — ${b.message}` : ""}`).join(" · ")}
        </Notice>
      ) : null}

      {result.skipped.length > 0 ? (
        <Notice tone="muted" title="Already in Xero">
          {result.skipped.map((s) => s.workerName).join(", ")} — nothing re-sent, so there are no
          duplicate drafts.
        </Notice>
      ) : null}

      {stillUnmapped.length > 0 ? (
        <Notice tone="warn" title="Still to map">
          <span className="font-semibold">
            {stillUnmapped.map((i) => i.workerName).join(", ")}
          </span>{" "}
          still {stillUnmapped.length === 1 ? "needs" : "need"} a Xero employee ID before those hours
          can go across. Add it in Employees on desktop.
        </Notice>
      ) : null}
    </FinaleShell>
  );
}

/** The finale's worker list — "N timesheets · total", then a row per worker.
 *  SHARED with the send-to-accounts finale (WeeklyCloseoutSendFinale) so both
 *  closeout endings show the boss exactly the same rows. */
export function PushRowList({ plan }: { plan: ReviewPlan }) {
  if (plan.rows.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 font-mono text-[9px] uppercase tracking-widest text-text-muted">
        {plan.sendCount} {plan.sendCount === 1 ? "timesheet" : "timesheets"} ·{" "}
        {formatHoursLabel(plan.totalHours)}
      </p>
      <ul className="divide-y divide-border overflow-hidden rounded-card border border-border">
        {plan.rows.map((r) => (
          <li key={r.workerId} className="flex items-center gap-3 px-3 py-2.5">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-navy font-display text-xs font-semibold text-text-inverse"
            >
              {r.initials}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-display text-sm font-semibold text-text">
                {r.workerName}
              </span>
              {r.hasOvertime ? (
                <span className="block text-xs text-amber-800">
                  incl. {formatHoursLabel(r.overtimeHours)} OT
                </span>
              ) : null}
            </span>
            <span className="shrink-0 font-display text-sm font-bold tabular-nums text-text">
              {formatHoursLabel(r.hours)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The replica's amber "stays out of this push" card, from the engine's own
 *  withheld findings — names are the API's, never a local guess. */
function WithheldNotice({ workers }: { workers: ExcludedWorker[] }) {
  const names = workers.map((w) => w.workerName).join(", ");
  return (
    <div className="flex gap-2.5 rounded-card border border-amber-200 bg-amber-50 p-3">
      <AlertTriangle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
      <p className="text-xs leading-relaxed text-amber-900">
        <b className="font-semibold">{names}</b> — no Xero employee ID yet, so those hours stay out
        of this push. Add the ID in Employees on desktop, then send separately.
      </p>
    </div>
  );
}

export function ReceiptRow({ label, value, last }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 py-2.5",
        !last && "border-b border-border",
      )}
    >
      <dt className="text-[13px] text-text-muted">{label}</dt>
      <dd className="font-display text-[13px] font-bold tabular-nums text-text">{value}</dd>
    </div>
  );
}

export function ReviewedMark({ count, sub }: { count: number; sub?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
        <Check aria-hidden="true" className="h-6 w-6" />
      </span>
      <div>
        <p className="font-display text-lg font-bold text-text">
          All {count} {count === 1 ? "week" : "weeks"} reviewed
        </p>
        {sub ? (
          <p className="mx-auto mt-1 max-w-[32ch] text-sm leading-relaxed text-text-muted">{sub}</p>
        ) : null}
      </div>
    </div>
  );
}

export function Notice({
  tone,
  title,
  children,
}: {
  tone: "warn" | "danger" | "muted";
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "warn"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : tone === "danger"
        ? "border-rose-200 bg-rose-50 text-rose-900"
        : "border-border bg-surface-subtle text-text-muted";
  return (
    <div className={cn("rounded-card border p-3 text-xs", toneClass)}>
      <p className="font-display text-[13px] font-bold">{title}</p>
      <p className="mt-1 leading-relaxed">{children}</p>
    </div>
  );
}

/** Shared sheet chrome so every finale state has the same header/body/footer. */
export function FinaleShell({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <>
      <div className="px-5 pb-2 pt-3">
        <h3 className="font-display text-lg font-bold text-text">{title}</h3>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">{children}</div>
      {footer ? (
        <div className="border-t border-border px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {footer}
        </div>
      ) : null}
      <span className="sr-only" aria-live="polite">
        {title}
      </span>
      <button type="button" className="sr-only" onClick={onClose}>
        Close
      </button>
    </>
  );
}
