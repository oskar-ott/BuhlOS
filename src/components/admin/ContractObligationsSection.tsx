"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { httpGet, httpPost } from "@/lib/http";
import { DocumentListResponseSchema } from "@/domains/documents/schema";
import { categoryLabel, normaliseCategory } from "@/domains/documents/format";
import { cn } from "@/lib/cn";

/**
 * #373 (safe slice) — contract obligations review queue, co-located with the
 * scope surface. Flag-gated (`ai_contract_obligations`, admin-tier) by the
 * server page — this component never renders when the flag is dark.
 *
 * TEXT-FIRST honestly: server-side PDF text extraction is not built (#197),
 * so the admin PASTES the contract text; a documents-register row can be
 * attached for provenance only. No fake uploader.
 *
 * Nothing is auto-accepted: every AI proposal needs an explicit Accept /
 * Edit-then-accept / Reject. Accepted items land in the job's scope of work
 * (through the #200 write path, server-side) and flow into reconciliation as
 * 'unclear' — the suggestedClassification chip is a hint for the human
 * classifying in Job control, never applied automatically.
 */

const ProposalSchema = z
  .object({
    id: z.string(),
    status: z.string(),
    title: z.string(),
    detail: z.string(),
    obligationType: z.string(),
    sourceQuote: z.string(),
    sourceLocation: z.string().nullable().optional(),
    suggestedClassification: z.string(),
    riskLevel: z.string(),
    confidence: z.number().nullable().optional(),
    documentName: z.string().nullable().optional(),
    scopeItemId: z.string().nullable().optional(),
    reviewedByName: z.string().nullable().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

const RunSchema = z
  .object({
    id: z.string(),
    createdAt: z.string(),
    proposalCount: z.number(),
    droppedInvalid: z.number().optional(),
    documentName: z.string().nullable().optional(),
  })
  .passthrough();

const StoreSchema = z.object({
  runs: z.array(RunSchema),
  proposals: z.array(ProposalSchema),
});
type StoreState = z.infer<typeof StoreSchema>;

const ReviewResponseSchema = z
  .object({ proposal: ProposalSchema, scopeItemId: z.string().optional() })
  .passthrough();

/** Below this the proposal is visually marked uncertain; at/above 0.8 it
 *  qualifies for the batch button. A missing confidence counts as uncertain. */
const UNCERTAIN_BELOW = 0.5;
const BATCH_MIN_CONFIDENCE = 0.8;

const chip = "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium";

function confidenceText(c: number | null | undefined): string {
  return typeof c === "number" ? `${Math.round(c * 100)}% confidence` : "no confidence returned";
}

export function ContractObligationsSection({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [store, setStore] = useState<StoreState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [docs, setDocs] = useState<Array<{ id: string; label: string }>>([]);

  const [text, setText] = useState("");
  const [docId, setDocId] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [lastRunNote, setLastRunNote] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDetail, setEditDetail] = useState("");

  const [batchRunning, setBatchRunning] = useState(false);
  const [batchReport, setBatchReport] = useState<string | null>(null);

  const reload = useCallback(async () => {
    const res = await httpGet(`/api/contract-extractions?jobId=${encodeURIComponent(jobId)}`, {
      schema: StoreSchema,
    });
    if (res.ok) {
      setStore(res.data);
      setLoadError(null);
    } else {
      setLoadError(res.error.message || "Couldn't load the extraction queue");
    }
  }, [jobId]);

  useEffect(() => {
    void reload();
    // Register rows for the provenance picker — contract / spec categories first.
    void httpGet(`/api/plans?jobId=${encodeURIComponent(jobId)}`, {
      schema: DocumentListResponseSchema,
    }).then((res) => {
      if (!res.ok) return; // picker is optional — pasting still works without it
      const rank = (c: string | null | undefined) => {
        const n = normaliseCategory(c);
        return n === "contract" ? 0 : n === "spec" ? 1 : 2;
      };
      const rows = res.data.plans
        .filter((p) => p.status !== "archived")
        .slice()
        .sort((a, b) => rank(a.category) - rank(b.category))
        .map((p) => ({
          id: p.id,
          label: `${p.fileName || p.title || p.id} (${categoryLabel(p.category)})`,
        }));
      setDocs(rows);
    });
  }, [jobId, reload]);

  async function extract() {
    setExtracting(true);
    setExtractError(null);
    setLastRunNote(null);
    const res = await httpPost(
      `/api/contract-extractions?jobId=${encodeURIComponent(jobId)}&action=extract`,
      { sourceText: text, ...(docId ? { documentId: docId } : {}) },
      { schema: StoreSchema.extend({ run: RunSchema }) }
    );
    setExtracting(false);
    if (!res.ok) {
      const body = res.error.body as { error?: string } | null;
      setExtractError(
        res.error.status === 503
          ? "AI isn't configured on this server — extraction can't run. No suggestions were invented."
          : (body && body.error) || res.error.message
      );
      return;
    }
    setStore({ runs: res.data.runs, proposals: res.data.proposals });
    const dropped = res.data.run.droppedInvalid ?? 0;
    setLastRunNote(
      `Extracted ${res.data.run.proposalCount} proposal${res.data.run.proposalCount === 1 ? "" : "s"} for review` +
        (dropped ? ` — ${dropped} invalid item${dropped === 1 ? "" : "s"} dropped` : "")
    );
    setText("");
  }

  async function review(
    proposalId: string,
    decision: "accept" | "edit" | "reject",
    edited?: { title: string; detail: string }
  ): Promise<string | null> {
    const res = await httpPost(
      `/api/contract-extractions?jobId=${encodeURIComponent(jobId)}&action=review`,
      { proposalId, decision, ...(edited ? { edited } : {}) },
      { schema: ReviewResponseSchema }
    );
    if (!res.ok) {
      const body = res.error.body as { error?: string } | null;
      return (body && body.error) || res.error.message;
    }
    return null;
  }

  async function decide(
    proposalId: string,
    decision: "accept" | "edit" | "reject",
    edited?: { title: string; detail: string }
  ) {
    setBusyId(proposalId);
    setRowError(null);
    const err = await review(proposalId, decision, edited);
    setBusyId(null);
    if (err) {
      setRowError({ id: proposalId, message: err });
      return;
    }
    setEditingId(null);
    await reload();
    router.refresh(); // the scope surface above reflects the new clause
  }

  const suggested = useMemo(
    () => (store?.proposals ?? []).filter((p) => p.status === "suggested"),
    [store]
  );
  const reviewed = useMemo(
    () => (store?.proposals ?? []).filter((p) => p.status === "accepted" || p.status === "edited"),
    [store]
  );
  const rejected = useMemo(
    () => (store?.proposals ?? []).filter((p) => p.status === "rejected"),
    [store]
  );
  const supersededCount = useMemo(
    () => (store?.proposals ?? []).filter((p) => p.status === "superseded").length,
    [store]
  );

  const batchable = suggested.filter(
    (p) => typeof p.confidence === "number" && p.confidence >= BATCH_MIN_CONFIDENCE
  );

  async function acceptAllHighConfidence() {
    setBatchRunning(true);
    setBatchReport(null);
    const failures: string[] = [];
    let ok = 0;
    // One review call per item — the server stays simple and each accept is
    // individually audit-trailed.
    for (const p of batchable) {
      const err = await review(p.id, "accept");
      if (err) failures.push(`"${p.title}": ${err}`);
      else ok++;
    }
    setBatchRunning(false);
    setBatchReport(
      failures.length === 0
        ? `Accepted ${ok} high-confidence item${ok === 1 ? "" : "s"}.`
        : `Accepted ${ok}; ${failures.length} failed — ${failures.join(" · ")}`
    );
    await reload();
    router.refresh();
  }

  return (
    <Card role="region" aria-label="Contract obligations">
      <CardTitle>Contract obligations (AI-extracted, review required)</CardTitle>
      <CardDescription className="mt-1">
        Paste the contract or scope-of-works text below — the AI proposes candidate obligations
        and every one needs your accept or reject before it touches the job. Reading text out of
        a PDF on the server isn&rsquo;t built yet (#197), so copy the text out of the document and
        paste it here; picking a register document only records where the text came from.
      </CardDescription>

      {/* ── paste form ─────────────────────────────────────────────── */}
      <div className="mt-3 space-y-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          placeholder="Paste the contract / scope-of-works text (up to 50,000 characters)…"
          className="w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm"
          data-testid="contract-extract-text"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-text-muted">
            <span>Source document (optional)</span>
            <select
              value={docId}
              onChange={(e) => setDocId(e.target.value)}
              className="h-9 rounded-card border border-border bg-surface px-2 text-sm"
              data-testid="contract-extract-doc"
            >
              <option value="">Pasted text only</option>
              {docs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            onClick={extract}
            disabled={extracting || text.trim() === ""}
            data-testid="contract-extract-run"
          >
            {extracting ? "Extracting…" : "Extract obligations"}
          </Button>
        </div>
        {extractError ? (
          <p role="alert" className="rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {extractError}
          </p>
        ) : null}
        {lastRunNote ? <p className="text-xs text-text-muted">{lastRunNote}</p> : null}
      </div>

      {loadError ? (
        <p role="alert" className="mt-3 rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {loadError}
        </p>
      ) : null}

      {/* ── suggested queue ────────────────────────────────────────── */}
      <div className="mt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Waiting for review ({suggested.length})</h3>
          {batchable.length > 0 ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={acceptAllHighConfidence}
              disabled={batchRunning || busyId !== null}
              data-testid="contract-accept-high-confidence"
            >
              {batchRunning
                ? "Accepting…"
                : `Accept all high-confidence (${batchable.length} at ≥${Math.round(BATCH_MIN_CONFIDENCE * 100)}%)`}
            </Button>
          ) : null}
        </div>
        {batchReport ? <p className="mt-1 text-xs text-text-muted">{batchReport}</p> : null}

        {store === null && !loadError ? (
          <p className="mt-2 text-sm text-text-muted">Loading…</p>
        ) : suggested.length === 0 ? (
          <p className="mt-2 text-sm text-text-muted">
            {(store?.runs.length ?? 0) === 0
              ? "No extraction run yet — paste the contract text above to get proposals."
              : "Nothing waiting for review."}
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {suggested.map((p) => {
              const uncertain = typeof p.confidence !== "number" || p.confidence < UNCERTAIN_BELOW;
              const editing = editingId === p.id;
              return (
                <li key={p.id} className="rounded-card border border-border p-3" data-testid="contract-proposal">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-semibold">{p.title}</span>
                    <span className={cn(chip, "border-border text-text-muted")}>{p.obligationType}</span>
                    <span
                      className={cn(chip, "border-sky-200 bg-sky-50 text-sky-800")}
                      title="A hint for the human — reconciliation still starts at 'unclear'"
                    >
                      hint: {p.suggestedClassification}
                    </span>
                    <span
                      className={cn(
                        chip,
                        p.riskLevel === "high"
                          ? "border-rose-200 bg-rose-50 text-rose-800"
                          : p.riskLevel === "medium"
                            ? "border-amber-200 bg-amber-50 text-amber-900"
                            : "border-border text-text-muted"
                      )}
                    >
                      {p.riskLevel} risk
                    </span>
                    <span className={cn(chip, "border-border text-text-muted")}>{confidenceText(p.confidence)}</span>
                    {uncertain ? (
                      <span className={cn(chip, "border-amber-200 bg-amber-50 text-amber-900")}>uncertain</span>
                    ) : null}
                  </div>

                  <p className="mt-1.5 text-sm">{p.detail}</p>
                  <blockquote className="mt-1.5 border-l-2 border-border pl-2 text-xs italic text-text-muted">
                    &ldquo;{p.sourceQuote}&rdquo;
                  </blockquote>
                  <p className="mt-1 text-xs text-text-muted">
                    {p.documentName ? `From ${p.documentName}` : "From pasted contract text"}
                    {" — "}
                    {p.sourceLocation ? p.sourceLocation : "no clause ref in text"}
                  </p>

                  {editing ? (
                    <div className="mt-2 space-y-2">
                      <input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="h-9 w-full rounded-card border border-border bg-surface px-2 text-sm"
                        aria-label="Edited title"
                        data-testid="contract-edit-title"
                      />
                      <textarea
                        value={editDetail}
                        onChange={(e) => setEditDetail(e.target.value)}
                        rows={3}
                        className="w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm"
                        aria-label="Edited detail"
                        data-testid="contract-edit-detail"
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() =>
                            decide(p.id, "edit", { title: editTitle.trim(), detail: editDetail.trim() })
                          }
                          disabled={busyId !== null || editTitle.trim() === "" || editDetail.trim() === ""}
                          data-testid="contract-edit-save"
                        >
                          Accept with edits
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingId(null)} disabled={busyId !== null}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => decide(p.id, "accept")}
                        disabled={busyId !== null || batchRunning}
                        data-testid="contract-accept"
                      >
                        {busyId === p.id ? "Saving…" : "Accept"}
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setEditingId(p.id);
                          setEditTitle(p.title);
                          setEditDetail(p.detail);
                        }}
                        disabled={busyId !== null || batchRunning}
                      >
                        Edit, then accept
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => decide(p.id, "reject")}
                        disabled={busyId !== null || batchRunning}
                        data-testid="contract-reject"
                      >
                        Reject
                      </Button>
                    </div>
                  )}
                  {rowError && rowError.id === p.id ? (
                    <p role="alert" className="mt-2 text-xs text-rose-700">
                      {rowError.message}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* ── reviewed history ───────────────────────────────────────── */}
      {reviewed.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-sm font-semibold">Accepted ({reviewed.length})</h3>
          <p className="mt-1 text-xs text-text-muted">
            Accepted items are now scope-of-work clauses on this job and flow into reconciliation
            as &lsquo;unclear&rsquo; until classified in Job control — the AI&rsquo;s classification
            hint is never applied automatically.
          </p>
          <ul className="mt-2 space-y-1">
            {reviewed.map((p) => (
              <li key={p.id} className="rounded-card border border-border px-3 py-2 text-sm">
                <span className="font-medium">{p.title}</span>
                <span className="ml-2 text-xs text-text-muted">
                  {p.status === "edited" ? "accepted with edits" : "accepted"}
                  {p.reviewedByName ? ` by ${p.reviewedByName}` : ""}
                  {p.scopeItemId ? ` — scope clause ${p.scopeItemId}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {rejected.length > 0 ? (
        <div className="mt-3">
          <h3 className="text-sm font-semibold">Rejected ({rejected.length})</h3>
          <ul className="mt-1 space-y-1">
            {rejected.map((p) => (
              <li key={p.id} className="rounded-card border border-border px-3 py-2 text-sm text-text-muted">
                {p.title}
                {p.reviewedByName ? ` — rejected by ${p.reviewedByName}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {supersededCount > 0 ? (
        <p className="mt-3 text-xs text-text-muted">
          {supersededCount} earlier unreviewed proposal{supersededCount === 1 ? "" : "s"} superseded
          by a re-extraction.
        </p>
      ) : null}
    </Card>
  );
}
