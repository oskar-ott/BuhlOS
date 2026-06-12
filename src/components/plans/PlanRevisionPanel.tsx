"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, History } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import { DocumentUploadButton } from "@/components/admin/DocumentUploadButton";
import { ackRevision, myPlanAcks, planAcks } from "@/domains/documents/client";
import { displayTitle } from "@/domains/documents/format";
import type { Document } from "@/domains/documents/types";

/**
 * Revision context for the selected drawing (#299) — mounted above the
 * viewer in PlansClient.
 *
 *   admin → what changed + lineage walk + "Who's seen it" ack rollup +
 *           the one-step "New revision" action (current rows only).
 *   phil  → what changed + the acknowledge tap. The ack — never push
 *           delivery — is the only "seen" claim recorded.
 *
 * Renders nothing when the selected document carries no revision context
 * (first issue, no summary, nothing superseded) so Phase-1 jobs look
 * exactly as before.
 */

interface PlanRevisionPanelProps {
  mode: "admin" | "phil";
  jobId: string;
  selected: Document;
  /** Full visible list — the lineage walk + revision history derive from it. */
  documents: ReadonlyArray<Document>;
}

export function PlanRevisionPanel({ mode, jobId, selected, documents }: PlanRevisionPanelProps) {
  const byId = useMemo(() => {
    const map = new Map<string, Document>();
    for (const d of documents) map.set(d.id, d);
    return map;
  }, [documents]);

  // Lineage chain ending at the selected revision (oldest → selected).
  const chain = useMemo(() => {
    const out: Document[] = [];
    let cursor: Document | undefined = selected;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      out.unshift(cursor);
      cursor = cursor.supersedes ? byId.get(cursor.supersedes) : undefined;
    }
    return out;
  }, [selected, byId]);

  const isRevision = Boolean(selected.supersedes) || Boolean(selected.changeSummary);

  if (mode === "admin") {
    return (
      <AdminRevisionTools
        jobId={jobId}
        selected={selected}
        chain={chain}
        isRevision={isRevision}
      />
    );
  }
  if (!isRevision || selected.status !== "current") return null;
  return <PhilRevisionAck jobId={jobId} selected={selected} />;
}

// ── Admin ────────────────────────────────────────────────────────────────

function AdminRevisionTools({
  jobId,
  selected,
  chain,
  isRevision,
}: {
  jobId: string;
  selected: Document;
  chain: ReadonlyArray<Document>;
  isRevision: boolean;
}) {
  const [rollup, setRollup] = useState<{
    acked: Array<{ userId: string; userName: string; ackAt: string }>;
    outstanding: Array<{ userId: string; userName: string }>;
  } | null>(null);
  const [rollupError, setRollupError] = useState<string | null>(null);
  const [loadingRollup, setLoadingRollup] = useState(false);

  // Reset the rollup when the selection changes — acks are per revision.
  useEffect(() => {
    setRollup(null);
    setRollupError(null);
  }, [selected.id]);

  async function loadRollup() {
    setLoadingRollup(true);
    setRollupError(null);
    const res = await planAcks(jobId, selected.id);
    setLoadingRollup(false);
    if (!res.ok) {
      setRollupError(res.error.message);
      return;
    }
    setRollup(res.data);
  }

  return (
    <div className="mb-3 space-y-2" data-testid="plan-revision-tools">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {chain.length > 1 ? (
            <p className="inline-flex flex-wrap items-center gap-1 text-xs text-text-muted">
              <History aria-hidden="true" className="h-3.5 w-3.5" />
              {chain.map((d, i) => (
                <span key={d.id}>
                  {i > 0 ? " → " : ""}
                  Rev {d.revision || "?"}
                  {d.status === "current" ? " (current)" : ""}
                </span>
              ))}
            </p>
          ) : null}
        </div>
        {selected.status === "current" ? (
          <DocumentUploadButton
            jobId={jobId}
            revises={{
              id: selected.id,
              drawingNumber: selected.drawingNumber,
              title: displayTitle(selected),
              revision: selected.revision,
            }}
          />
        ) : null}
      </div>

      {selected.changeSummary ? (
        <p className="rounded-card bg-surface-subtle px-3 py-2 text-sm text-text">
          <span className="font-medium">What changed:</span> {selected.changeSummary}
        </p>
      ) : null}

      {isRevision ? (
        <div>
          {rollup === null ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={loadRollup}
              disabled={loadingRollup}
              data-testid="plan-acks-load"
            >
              {loadingRollup ? "Checking…" : "Who's seen it?"}
            </Button>
          ) : (
            <div className="space-y-1 text-xs" data-testid="plan-acks-rollup">
              <p>
                <Pill tone={rollup.outstanding.length === 0 ? "success" : "warning"}>
                  {rollup.acked.length} acknowledged · {rollup.outstanding.length} outstanding
                </Pill>
              </p>
              {rollup.acked.length > 0 ? (
                <p className="text-text-muted">
                  Seen: {rollup.acked.map((a) => a.userName).join(", ")}
                </p>
              ) : null}
              {rollup.outstanding.length > 0 ? (
                <p className="text-text-muted">
                  Waiting on: {rollup.outstanding.map((o) => o.userName).join(", ")}
                </p>
              ) : null}
            </div>
          )}
          {rollupError ? <p className="text-xs text-text-muted">{rollupError}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

// ── Phil ─────────────────────────────────────────────────────────────────

function PhilRevisionAck({ jobId, selected }: { jobId: string; selected: Document }) {
  const [ackedIds, setAckedIds] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await myPlanAcks(jobId);
      if (cancelled) return;
      // Fail-soft to "nothing acked": the worker can still ack (idempotent
      // server-side), we just may show the button to someone who already has.
      setAckedIds(new Set(res.ok ? res.data.planIds : []));
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  async function ack() {
    setSaving(true);
    setError(null);
    const res = await ackRevision(jobId, selected.id);
    setSaving(false);
    if (!res.ok) {
      setError(res.error.message);
      return;
    }
    setAckedIds((prev) => new Set([...(prev ?? []), selected.id]));
  }

  const acked = ackedIds?.has(selected.id) ?? false;

  return (
    <div className="mb-3 space-y-2" data-testid="phil-revision-notice">
      {selected.changeSummary ? (
        <p className="rounded-card bg-surface-subtle px-3 py-2 text-sm text-text">
          <span className="font-medium">
            What changed{selected.revision ? ` in Rev ${selected.revision}` : ""}:
          </span>{" "}
          {selected.changeSummary}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-state-danger">
          {error}
        </p>
      ) : null}
      {acked ? (
        <p className="inline-flex items-center gap-1.5 text-sm text-state-success">
          <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
          You&rsquo;ve acknowledged this revision.
        </p>
      ) : ackedIds !== null ? (
        <Button size="sm" onClick={ack} disabled={saving} data-testid="plan-ack-confirm">
          {saving ? "Recording…" : `Got it — working from${selected.revision ? ` Rev ${selected.revision}` : " the current sheet"}`}
        </Button>
      ) : null}
    </div>
  );
}
