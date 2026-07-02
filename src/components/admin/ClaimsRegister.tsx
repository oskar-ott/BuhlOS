"use client";

import { useCallback, useMemo, useState } from "react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import {
  claimCsvHref,
  claimPrintHref,
  fetchClaimsView,
  postClaimsAction,
  type ClaimsViewWire,
} from "@/domains/progress-claims/client";
import {
  bpToPct,
  formatBpPct,
  formatCentsAud,
  pctToBp,
  withComputedValues,
} from "@/domains/progress-claims/math";
import type {
  ProgressClaim,
  ProgressClaimLine,
  ProgressClaimStatus,
} from "@/domains/progress-claims/types";

/**
 * Per-job progress-claims register (#372) — the admin workbench:
 *
 *   - Register: Claim N · period · status · this-claim / to-date money ·
 *     certified-vs-claimed variance · aging on unpaid claims.
 *   - Draft editing: per-line this-claim % (ADMIN-ENTERED — the package task
 *     completion shows ALONGSIDE as a reference, never a competing auto-%),
 *     over-claim override, evidence linking from the job's REAL records,
 *     manual lines, variation/daywork attachments.
 *   - Submit freezes the claim (immutable + evidence manifest); corrections go
 *     on the next claim. Export: Payapps-keying CSV + print view.
 *
 * All money renders from integer cents; lines with no evidence are visibly
 * marked "No evidence linked" (allowed, never hidden); unpriced lines are
 * flagged and excluded from totals — never treated as $0 (P7).
 */

const STATUS_TONE: Record<ProgressClaimStatus, "neutral" | "info" | "warning" | "success"> = {
  draft: "neutral",
  submitted: "info",
  certified: "warning",
  paid: "success",
};

const STATUS_LABEL: Record<ProgressClaimStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  certified: "Certified",
  paid: "Paid",
};

interface ClaimsRegisterProps {
  jobId: string;
  initialView: ClaimsViewWire | null;
  fetchError: string | null;
}

export function ClaimsRegister({ jobId, initialView, fetchError }: ClaimsRegisterProps) {
  const [view, setView] = useState<ClaimsViewWire | null>(initialView);
  const [error, setError] = useState<string | null>(fetchError);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Open the draft if one exists, else the latest claim — the row the office
  // is most likely working with.
  const [openClaimId, setOpenClaimId] = useState<string | null>(() => {
    const claims = initialView?.claims ?? [];
    const draftClaim = claims.find((c) => c.status === "draft");
    if (draftClaim) return draftClaim.id;
    const latest = [...claims].sort((a, b) => b.number - a.number)[0];
    return latest?.id ?? null;
  });

  const reload = useCallback(async () => {
    const loaded = await fetchClaimsView(jobId);
    if (loaded.kind === "ok") {
      setView(loaded.view);
      setError(null);
    } else {
      setError(loaded.message);
    }
  }, [jobId]);

  const act = useCallback(
    async (body: Record<string, unknown>): Promise<boolean> => {
      if (!view) return false;
      setBusy(true);
      setNotice(null);
      setError(null);
      const result = await postClaimsAction({ ...body, jobId, expectedRevision: view.revision });
      if (result.kind === "stale") {
        setError("The register changed since you loaded it — refreshed, please retry.");
        await reload();
        setBusy(false);
        return false;
      }
      if (result.kind === "error") {
        setError(result.message);
        setBusy(false);
        return false;
      }
      if (result.rollupWarning) setNotice(result.rollupWarning);
      await reload();
      setBusy(false);
      return true;
    },
    [jobId, view, reload],
  );

  if (!view) {
    return (
      <Card className="border-amber-200 bg-amber-50" role="alert">
        <CardTitle>Couldn&rsquo;t load the claims register</CardTitle>
        <CardDescription className="mt-2 text-amber-900">
          {error ?? "Try again in a moment."}
        </CardDescription>
      </Card>
    );
  }

  const draft = view.claims.find((c) => c.status === "draft") ?? null;
  const referenceByPackage = new Map(view.references.map((r) => [r.workPackageId, r]));

  return (
    <div className="space-y-4" data-testid="claims-register">
      {error ? (
        <Card className="border-rose-200 bg-rose-50" role="alert">
          <p className="text-sm text-rose-800">{error}</p>
        </Card>
      ) : null}
      {notice ? (
        <Card className="border-amber-200 bg-amber-50" role="status">
          <p className="text-sm text-amber-900">{notice}</p>
        </Card>
      ) : null}

      <SummaryCard view={view} />

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Claims</CardTitle>
            <CardDescription className="mt-1">
              {view.claims.length === 0
                ? "No claims yet. A new claim seeds its lines from " +
                  (view.seed.source === "quote"
                    ? "the linked quote's priced lines."
                    : view.seed.source === "packages"
                      ? "the compiled work packages (unpriced until you enter contract values)."
                      : "scratch — no linked quote or work packages exist, add lines by hand.")
                : "Submitted claims are frozen — corrections go on the next claim."}
            </CardDescription>
          </div>
          <button
            type="button"
            disabled={busy || draft != null}
            onClick={() => void act({ action: "create" })}
            className="rounded-card bg-brand-navy px-3 py-2 text-sm font-medium text-text-inverse transition-colors hover:bg-accent-ink disabled:opacity-50"
            data-testid="claims-new"
          >
            {draft ? "Draft in progress" : "New claim"}
          </button>
        </div>

        {view.claims.length > 0 ? (
          <ul className="mt-4 space-y-3">
            {[...view.claims]
              .sort((a, b) => b.number - a.number)
              .map((claim) => (
                <ClaimRow
                  key={claim.id}
                  claim={claim}
                  view={view}
                  open={openClaimId === claim.id}
                  onToggle={() =>
                    setOpenClaimId((cur) => (cur === claim.id ? null : claim.id))
                  }
                  busy={busy}
                  act={act}
                  jobId={jobId}
                  referenceByPackage={referenceByPackage}
                />
              ))}
          </ul>
        ) : null}
      </Card>
    </div>
  );
}

function SummaryCard({ view }: { view: ClaimsViewWire }) {
  const d = view.derived;
  const drift =
    d.scalarClaimedToDateCents != null && d.scalarClaimedToDateCents !== d.claimedToDateCents;
  return (
    <Card>
      <CardTitle>Position</CardTitle>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <SummaryStat label="Contract value" value={formatCentsAud(d.contractValueCents)} />
        <SummaryStat
          label="Claimed to date (from claims)"
          value={formatCentsAud(d.claimedToDateCents)}
        />
        <SummaryStat
          label="Oldest unpaid claim"
          value={d.oldestUnpaidDays == null ? "—" : `${d.oldestUnpaidDays}d`}
        />
        <SummaryStat
          label="Job card figure"
          value={formatCentsAud(d.scalarClaimedToDateCents)}
        />
      </dl>
      {drift ? (
        <p className="mt-3 rounded-card border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">
          The job&rsquo;s hand-set claimed-to-date differs from the claim records — submitting or
          updating a claim re-derives it.
        </p>
      ) : null}
    </Card>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-border bg-surface px-3 py-2">
      <div className="font-display text-base text-text">{value}</div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
}

interface ClaimRowProps {
  claim: ProgressClaim;
  view: ClaimsViewWire;
  open: boolean;
  onToggle: () => void;
  busy: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
  jobId: string;
  referenceByPackage: Map<string, { tasksComplete: number; tasksTotal: number }>;
}

function ClaimRow({ claim, view, open, onToggle, busy, act, jobId, referenceByPackage }: ClaimRowProps) {
  const variance = view.derived.certifiedVarianceByClaimId[claim.id] ?? null;
  return (
    <li className="rounded-card border border-border" data-testid={`claim-${claim.number}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-2 text-left"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2">
          <span className="font-display font-semibold text-text">Claim {claim.number}</span>
          {claim.periodLabel ? (
            <span className="text-sm text-text-muted">{claim.periodLabel}</span>
          ) : null}
          <Pill tone={STATUS_TONE[claim.status]}>{STATUS_LABEL[claim.status]}</Pill>
        </span>
        <span className="flex items-center gap-3 text-sm">
          <span className="text-text-muted">
            This claim <strong className="text-text">{formatCentsAud(claim.totals.thisClaimValueCents)}</strong>
          </span>
          <span className="text-text-muted">
            To date <strong className="text-text">{formatCentsAud(claim.totals.toDateValueCents)}</strong>
          </span>
          {variance != null ? (
            <span className={variance < 0 ? "text-rose-700" : "text-emerald-700"}>
              Certified {variance === 0 ? "in full" : `${variance > 0 ? "+" : ""}${formatCentsAud(variance)}`}
            </span>
          ) : null}
        </span>
      </button>
      {open ? (
        <div className="border-t border-border px-3 py-3">
          <ClaimDetail
            claim={claim}
            view={view}
            busy={busy}
            act={act}
            jobId={jobId}
            referenceByPackage={referenceByPackage}
          />
        </div>
      ) : null}
    </li>
  );
}

function ClaimDetail({ claim, view, busy, act, jobId, referenceByPackage }: Omit<ClaimRowProps, "open" | "onToggle">) {
  const editable = claim.status === "draft";
  const lines = useMemo(
    () => [...claim.lines].sort((a, b) => a.order - b.order).map(withComputedValues),
    [claim.lines],
  );

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-border text-left font-mono text-[10px] uppercase tracking-wider text-text-muted">
              <th className="py-1.5 pr-2">Ref</th>
              <th className="py-1.5 pr-2">Description</th>
              <th className="py-1.5 pr-2 text-right">Contract</th>
              <th className="py-1.5 pr-2 text-right">Prev %</th>
              <th className="py-1.5 pr-2 text-right">This %</th>
              <th className="py-1.5 pr-2 text-right">This value</th>
              <th className="py-1.5 pr-2 text-right">To date</th>
              <th className="py-1.5">Evidence</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <LineRow
                key={line.id}
                claim={claim}
                line={line}
                editable={editable}
                busy={busy}
                act={act}
                view={view}
                reference={
                  line.workPackageId ? referenceByPackage.get(line.workPackageId) ?? null : null
                }
              />
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-medium text-text">
              <td className="py-2 pr-2" colSpan={2}>
                Total{claim.totals.unpricedLineCount > 0
                  ? ` (${claim.totals.unpricedLineCount} unpriced line${claim.totals.unpricedLineCount === 1 ? "" : "s"} excluded)`
                  : ""}
              </td>
              <td className="py-2 pr-2 text-right">{formatCentsAud(claim.totals.contractValueCents)}</td>
              <td className="py-2 pr-2" />
              <td className="py-2 pr-2" />
              <td className="py-2 pr-2 text-right">{formatCentsAud(claim.totals.thisLinesValueCents)}</td>
              <td className="py-2 pr-2 text-right">{formatCentsAud(claim.totals.toDateValueCents)}</td>
              <td className="py-2" />
            </tr>
          </tfoot>
        </table>
      </div>

      <AttachmentsSection claim={claim} view={view} editable={editable} busy={busy} act={act} />

      {editable ? <AddLineForm claim={claim} busy={busy} act={act} /> : null}

      <ClaimActions claim={claim} busy={busy} act={act} jobId={jobId} />
    </div>
  );
}

interface LineRowProps {
  claim: ProgressClaim;
  line: ProgressClaimLine;
  editable: boolean;
  busy: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
  view: ClaimsViewWire;
  reference: { tasksComplete: number; tasksTotal: number } | null;
}

function LineRow({ claim, line, editable, busy, act, view, reference }: LineRowProps) {
  const [pctInput, setPctInput] = useState<string>(String(bpToPct(line.thisPctBp)));
  const [linking, setLinking] = useState(false);
  const overClaim = line.toDatePctBp > 10_000;
  const unsupported = line.evidenceRefs.length === 0;

  const savePct = async () => {
    const parsed = Number(pctInput);
    if (!Number.isFinite(parsed)) {
      setPctInput(String(bpToPct(line.thisPctBp)));
      return;
    }
    const bp = pctToBp(parsed);
    if (bp === line.thisPctBp) return;
    const ok = await act({
      action: "update-line",
      claimId: claim.id,
      lineId: line.id,
      thisPctBp: bp,
    });
    if (!ok) setPctInput(String(bpToPct(line.thisPctBp)));
  };

  return (
    <>
      <tr className="border-b border-border/60 align-top" data-testid={`claim-line-${line.lineRef}`}>
        <td className="py-2 pr-2 font-mono text-xs text-text-muted">{line.lineRef}</td>
        <td className="py-2 pr-2">
          <div className="text-text">{line.description}</div>
          {line.sectionLabel ? (
            <div className="text-xs text-text-muted">{line.sectionLabel}</div>
          ) : null}
          <div className="mt-0.5 flex flex-wrap gap-1.5">
            {line.contractValueCents == null ? <Pill tone="warning">Unpriced</Pill> : null}
            {overClaim ? (
              <Pill tone={line.overClaimOverride ? "warning" : "danger"}>
                Over 100%{line.overClaimOverride ? " (override)" : ""}
              </Pill>
            ) : null}
            {reference && reference.tasksTotal > 0 ? (
              <span className="text-xs text-text-muted">
                Tasks {reference.tasksComplete}/{reference.tasksTotal} complete (reference)
              </span>
            ) : null}
          </div>
        </td>
        <td className="py-2 pr-2 text-right tabular-nums">{formatCentsAud(line.contractValueCents)}</td>
        <td className="py-2 pr-2 text-right tabular-nums text-text-muted">{formatBpPct(line.previousPctBp)}</td>
        <td className="py-2 pr-2 text-right">
          {editable ? (
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              value={pctInput}
              disabled={busy}
              onChange={(e) => setPctInput(e.target.value)}
              onBlur={() => void savePct()}
              className="w-20 rounded-card border border-border bg-surface px-2 py-1 text-right text-sm"
              aria-label={`This claim percent for ${line.description}`}
            />
          ) : (
            <span className="tabular-nums">{formatBpPct(line.thisPctBp)}</span>
          )}
        </td>
        <td className="py-2 pr-2 text-right tabular-nums">{formatCentsAud(line.thisValueCents)}</td>
        <td className="py-2 pr-2 text-right tabular-nums">
          {formatCentsAud(line.toDateValueCents)}
          <div className="text-xs text-text-muted">{formatBpPct(line.toDatePctBp)}</div>
        </td>
        <td className="py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {unsupported ? (
              <Pill tone="warning">No evidence linked</Pill>
            ) : (
              <span className="text-xs text-text-muted">
                {line.evidenceRefs.length} linked
              </span>
            )}
            {editable ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setLinking((v) => !v)}
                className="text-xs underline decoration-accent-yellow decoration-2 underline-offset-2"
              >
                {linking ? "Close" : "Link evidence"}
              </button>
            ) : null}
            {editable && overClaim && !line.overClaimOverride ? (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act({
                    action: "update-line",
                    claimId: claim.id,
                    lineId: line.id,
                    overClaimOverride: true,
                  })
                }
                className="text-xs underline decoration-accent-yellow decoration-2 underline-offset-2"
              >
                Allow over-claim
              </button>
            ) : null}
            {editable ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => void act({ action: "remove-line", claimId: claim.id, lineId: line.id })}
                className="text-xs text-rose-700 underline underline-offset-2"
              >
                Remove
              </button>
            ) : null}
          </div>
        </td>
      </tr>
      {linking && editable ? (
        <tr>
          <td colSpan={8} className="border-b border-border/60 bg-surface-subtle px-2 py-2">
            <EvidencePicker claim={claim} line={line} view={view} busy={busy} act={act} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function EvidencePicker({
  claim,
  line,
  view,
  busy,
  act,
}: {
  claim: ProgressClaim;
  line: ProgressClaimLine;
  view: ClaimsViewWire;
  busy: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const linkedIds = new Set(line.evidenceRefs.map((r) => r.id));
  const available = view.linkable.filter((r) => !linkedIds.has(r.id));
  return (
    <div className="space-y-2 text-sm">
      {line.evidenceRefs.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {line.evidenceRefs.map((r) => (
            <span key={r.id} className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface px-2 py-0.5 text-xs">
              {r.label ?? r.id}
              <button
                type="button"
                disabled={busy}
                aria-label={`Unlink ${r.label ?? r.id}`}
                onClick={() =>
                  void act({
                    action: "link-evidence",
                    claimId: claim.id,
                    lineId: line.id,
                    removeIds: [r.id],
                  })
                }
                className="text-text-muted hover:text-rose-700"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {available.length === 0 ? (
        <p className="text-xs text-text-muted">
          No more evidence or ITP records on this job to link — proof is captured in the field
          first, then cited here.
        </p>
      ) : (
        <ul className="max-h-40 space-y-1 overflow-y-auto">
          {available.slice(0, 50).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-xs text-text">
                <span className="font-mono uppercase text-text-muted">[{r.kind}]</span> {r.label}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act({
                    action: "link-evidence",
                    claimId: claim.id,
                    lineId: line.id,
                    add: [{ kind: r.kind, id: r.id }],
                  })
                }
                className="shrink-0 text-xs underline decoration-accent-yellow decoration-2 underline-offset-2"
              >
                Link
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AttachmentsSection({
  claim,
  view,
  editable,
  busy,
  act,
}: {
  claim: ProgressClaim;
  view: ClaimsViewWire;
  editable: boolean;
  busy: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const attachableHere = view.attachable.filter((a) => a.attachedToClaimNumber == null);
  if (claim.attachments.length === 0 && (!editable || attachableHere.length === 0)) return null;
  return (
    <div className="rounded-card border border-border bg-surface-subtle p-3">
      <h4 className="font-display text-sm font-semibold text-text">
        Variations &amp; dayworks (by link)
      </h4>
      {claim.attachments.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm">
          {claim.attachments.map((a) => (
            <li key={`${a.kind}:${a.id}`} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                <span className="font-mono text-xs uppercase text-text-muted">[{a.kind}]</span>{" "}
                {a.ref ? `${a.ref} — ` : ""}
                {a.label}
              </span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="tabular-nums">
                  {a.valueCents == null ? "support only" : formatCentsAud(a.valueCents)}
                </span>
                {editable ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act({ action: "detach", claimId: claim.id, kind: a.kind, recordId: a.id })
                    }
                    className="text-xs text-rose-700 underline underline-offset-2"
                  >
                    Detach
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {editable && attachableHere.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-border pt-2 text-sm">
          {attachableHere.map((a) => (
            <li key={`${a.kind}:${a.id}`} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-text-muted">
                <span className="font-mono text-xs uppercase">[{a.kind}]</span>{" "}
                {a.ref ? `${a.ref} — ` : ""}
                {a.label}
                {a.valueCents != null ? ` · ${formatCentsAud(a.valueCents)}` : ""}
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act({ action: "attach", claimId: claim.id, kind: a.kind, recordId: a.id })
                }
                className="shrink-0 text-xs underline decoration-accent-yellow decoration-2 underline-offset-2"
              >
                Attach
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AddLineForm({
  claim,
  busy,
  act,
}: {
  claim: ProgressClaim;
  busy: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
}) {
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const submit = async () => {
    const d = description.trim();
    if (!d) return;
    const dollars = Number(value);
    const contractValueCents =
      value.trim() !== "" && Number.isFinite(dollars) && dollars >= 0
        ? Math.round(dollars * 100)
        : null;
    const ok = await act({ action: "add-line", claimId: claim.id, description: d, contractValueCents });
    if (ok) {
      setDescription("");
      setValue("");
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs text-text-muted">
        Add a line (manual scope)
        <input
          type="text"
          value={description}
          disabled={busy}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Description"
          className="rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
        />
      </label>
      <label className="flex w-36 flex-col gap-1 text-xs text-text-muted">
        Contract value ($ ex GST)
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          placeholder="optional"
          className="rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
        />
      </label>
      <button
        type="button"
        disabled={busy || !description.trim()}
        onClick={() => void submit()}
        className="rounded-card border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-subtle disabled:opacity-50"
      >
        Add line
      </button>
    </div>
  );
}

function ClaimActions({
  claim,
  busy,
  act,
  jobId,
}: {
  claim: ProgressClaim;
  busy: boolean;
  act: (body: Record<string, unknown>) => Promise<boolean>;
  jobId: string;
}) {
  const [certValue, setCertValue] = useState("");
  const [certRef, setCertRef] = useState("");
  const [paidRef, setPaidRef] = useState("");
  // House rule: no window.confirm — inline arm/confirm (the DefectsRegister
  // bulk-close pattern). First click arms and names the consequence; the
  // second click executes; touching anything else disarms.
  const [armed, setArmed] = useState<"submit" | "delete" | null>(null);

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
      <a
        href={claimCsvHref(jobId, claim.id)}
        className="rounded-card border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-subtle"
      >
        CSV for Payapps keying{claim.status === "draft" ? " (draft)" : ""}
      </a>
      <a
        href={claimPrintHref(jobId, claim.id)}
        target="_blank"
        rel="noreferrer"
        className="rounded-card border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-subtle"
      >
        Print / PDF
      </a>

      {claim.status === "draft" ? (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (armed === "submit") {
                setArmed(null);
                void act({ action: "submit", claimId: claim.id });
              } else {
                setArmed("submit");
              }
            }}
            className="rounded-card bg-brand-navy px-3 py-1.5 text-sm font-medium text-text-inverse hover:bg-accent-ink disabled:opacity-50"
            data-testid={`claim-submit-${claim.number}`}
          >
            {armed === "submit"
              ? `Really submit Claim ${claim.number}? It freezes — click again`
              : "Submit claim"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (armed === "delete") {
                setArmed(null);
                void act({ action: "delete-draft", claimId: claim.id });
              } else {
                setArmed("delete");
              }
            }}
            className="rounded-card border border-rose-200 bg-surface px-3 py-1.5 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            {armed === "delete" ? `Really delete draft ${claim.number}? Click again` : "Delete draft"}
          </button>
        </>
      ) : null}

      {claim.status === "submitted" ? (
        <span className="flex flex-wrap items-end gap-2">
          <label className="flex w-36 flex-col gap-1 text-xs text-text-muted">
            Certified value ($)
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={certValue}
              disabled={busy}
              onChange={(e) => setCertValue(e.target.value)}
              className="rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
            />
          </label>
          <label className="flex w-36 flex-col gap-1 text-xs text-text-muted">
            Certificate ref
            <input
              type="text"
              value={certRef}
              disabled={busy}
              onChange={(e) => setCertRef(e.target.value)}
              className="rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
            />
          </label>
          <button
            type="button"
            disabled={busy || certValue.trim() === "" || !Number.isFinite(Number(certValue))}
            onClick={() =>
              void act({
                action: "set-status",
                claimId: claim.id,
                to: "certified",
                certifiedValueCents: Math.round(Number(certValue) * 100),
                certifiedRef: certRef.trim() || null,
              })
            }
            className="rounded-card border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-subtle disabled:opacity-50"
          >
            Mark certified
          </button>
        </span>
      ) : null}

      {claim.status === "submitted" || claim.status === "certified" ? (
        <span className="flex flex-wrap items-end gap-2">
          <label className="flex w-36 flex-col gap-1 text-xs text-text-muted">
            Payment ref
            <input
              type="text"
              value={paidRef}
              disabled={busy}
              onChange={(e) => setPaidRef(e.target.value)}
              className="rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
            />
          </label>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act({
                action: "set-status",
                claimId: claim.id,
                to: "paid",
                paidRef: paidRef.trim() || null,
              })
            }
            className="rounded-card border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-subtle disabled:opacity-50"
          >
            Mark paid
          </button>
        </span>
      ) : null}

      {claim.submittedAt ? (
        <span className="ml-auto text-xs text-text-muted">
          Submitted {new Date(claim.submittedAt).toLocaleDateString("en-AU")}
          {claim.submittedBy ? ` by ${claim.submittedBy}` : ""}
        </span>
      ) : null}
    </div>
  );
}
