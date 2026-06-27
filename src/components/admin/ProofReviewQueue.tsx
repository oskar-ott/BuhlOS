"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Check } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { EmptyState } from "@/components/ui/EmptyState";
import { postProofReview } from "@/components/phil/jobControlProofReviewClient";
import { proofActionMessage, proofActionShouldRefresh } from "./proofReviewQueueModel";
import type { ProofQueueItem } from "@/server/job-control/proof-queue";

/**
 * Office "Proof to sign off" surface (#503) — the admin approve / send-back UI
 * for task proof a worker submitted, wired to the EXISTING proof-review engine
 * (postProofReview → /api/job-control/proof-review → applyProofReview). No new
 * write path; the engine enforces submitter ≠ approver, the revision guard and
 * the audit log.
 *
 * Each row carries its OWN job's jobControlRevision (the precondition for that
 * job's artifact) — a stale write returns `stale`, which we surface with a
 * refresh prompt rather than silently failing. Granularity is whatever the
 * requirement was authored at (package-level by default in prod).
 */
const STAGE_LABEL: Record<string, string> = { roughIn: "Rough-in", fitOff: "Fit-off" };

export function ProofReviewQueue({ initialItems }: { initialItems: ProofQueueItem[] }) {
  const router = useRouter();
  const [items, setItems] = useState<ProofQueueItem[]>(initialItems);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sendBack, setSendBack] = useState<ProofQueueItem | null>(null);

  async function approve(item: ProofQueueItem) {
    setBusyId(item.reviewId);
    setErrors((m) => ({ ...m, [item.reviewId]: "" }));
    const r = await postProofReview({
      jobId: item.jobId,
      action: "approve",
      taskRef: item.taskRef,
      expectedJobControlRevision: item.jobControlRevision,
    });
    setBusyId(null);
    handleResult(item, r, "approved");
  }

  async function reject(item: ProofQueueItem, reason: string) {
    setBusyId(item.reviewId);
    setErrors((m) => ({ ...m, [item.reviewId]: "" }));
    const r = await postProofReview({
      jobId: item.jobId,
      action: "reject",
      taskRef: item.taskRef,
      reason,
      expectedJobControlRevision: item.jobControlRevision,
    });
    setBusyId(null);
    setSendBack(null);
    handleResult(item, r, "sent back");
  }

  function handleResult(
    item: ProofQueueItem,
    r: Awaited<ReturnType<typeof postProofReview>>,
    verb: string,
  ) {
    if (r.kind === "ok") {
      setItems((prev) => prev.filter((i) => i.reviewId !== item.reviewId));
      return;
    }
    const msg = proofActionMessage(r.kind, verb);
    if (msg) setErrors((m) => ({ ...m, [item.reviewId]: msg }));
    if (proofActionShouldRefresh(r.kind)) router.refresh();
  }

  if (items.length === 0) {
    return (
      <Card>
        <EmptyState title="Queue clear" description="No site photos waiting on your sign-off." />
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const proves =
          item.requirements.map((r) => r.label).join(" · ") ||
          item.workPackageTitle ||
          "Captured proof";
        const busy = busyId === item.reviewId;
        return (
          <Card key={item.reviewId} className="p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-card bg-brand-navy text-accent-yellow">
                <Camera aria-hidden="true" className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-display text-sm font-semibold text-text">{proves}</p>
                <p className="mt-0.5 font-mono text-[11px] text-text-muted">
                  {item.jobName} · {STAGE_LABEL[item.taskRef.stage] ?? item.taskRef.stage}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  {/* Prefer the captured-by display name from the evidence join;
                      submittedBy is a raw user id, so never render it as a name. */}
                  {item.photos.find((p) => p.capturedByName)?.capturedByName
                    ? `Captured by ${item.photos.find((p) => p.capturedByName)!.capturedByName}`
                    : "Captured on site"}
                  {item.submittedAt ? ` · ${relAge(item.submittedAt)}` : ""}
                </p>
              </div>
            </div>

            {/* Captured photos (real thumbnails; honest placeholder when a
                proof is met by an observation / no photo URL). */}
            {item.photos.length > 0 ? (
              <div className="mt-3 grid grid-cols-3 gap-2">
                {item.photos.map((p) =>
                  p.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- evidence blob URL
                    <img
                      key={p.evidenceId}
                      src={p.photoUrl}
                      alt="Captured proof"
                      className="aspect-square w-full rounded-card border border-border object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div
                      key={p.evidenceId}
                      className="flex aspect-square w-full items-center justify-center rounded-card border border-dashed border-border text-text-muted"
                    >
                      <Camera aria-hidden="true" className="h-5 w-5" />
                    </div>
                  ),
                )}
              </div>
            ) : null}

            <div className="mt-3 flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                className="min-h-[44px] flex-1"
                onClick={() => setSendBack(item)}
              >
                Send back…
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={busy}
                className="min-h-[44px] flex-1"
                onClick={() => void approve(item)}
              >
                {busy ? "Saving…" : (
                  <>
                    <Check aria-hidden="true" className="h-4 w-4" /> Approve proof
                  </>
                )}
              </Button>
            </div>
            {errors[item.reviewId] ? (
              <p className="mt-2 text-xs text-state-danger" role="alert">
                {errors[item.reviewId]}
              </p>
            ) : null}

            <p className="mt-2 font-mono text-[10px] tracking-wide text-text-muted">
              You&rsquo;re recorded as the approver — you can&rsquo;t sign off proof you captured.
            </p>
          </Card>
        );
      })}

      <SendBackModal
        item={sendBack}
        busy={sendBack ? busyId === sendBack.reviewId : false}
        onClose={() => setSendBack(null)}
        onSubmit={(reason) => sendBack && void reject(sendBack, reason)}
      />
    </div>
  );
}

function SendBackModal({
  item,
  busy,
  onClose,
  onSubmit,
}: {
  item: ProofQueueItem | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (item) {
      setReason("");
      const t = window.setTimeout(() => ref.current?.focus(), 50);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [item]);

  const trimmed = reason.trim();
  const canSubmit = !busy && trimmed.length > 0 && trimmed.length <= 500;

  return (
    <Modal open={item !== null} onClose={busy ? () => {} : onClose} title="Send proof back">
      <div className="space-y-4">
        <p className="text-sm text-text-muted">
          The reason is recorded and shown to the worker — they re-capture and re-submit.
        </p>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-text">Reason (required)</span>
          <textarea
            ref={ref}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            rows={4}
            maxLength={500}
            placeholder="e.g. Photo’s blurry — re-take with the board labels visible"
            className="block w-full rounded-card border border-border bg-surface px-3 py-2 text-sm focus:border-brand-navy focus:outline-none disabled:opacity-60"
          />
          <p className="mt-1 text-right text-xs text-text-muted">{trimmed.length} / 500</p>
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" disabled={!canSubmit} onClick={() => onSubmit(trimmed)}>
            {busy ? "Sending…" : "Send back with reason"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function relAge(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
  if (diff < HOUR) return `${Math.max(1, Math.floor(diff / MIN))}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  return `${Math.floor(diff / DAY)}d ago`;
}
