"use client";

import { useEffect, useState } from "react";
import {
  CheckCircle2,
  FileText,
  Image as ImageIcon,
  Link2,
  Link2Off,
  Lock,
  PenSquare,
  Stamp,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import {
  kindLabel,
  statusLabel,
  statusTone,
  type EvidenceStatusTone,
} from "@/domains/evidence/format";
import type { EvidenceItem } from "@/domains/evidence/types";
import { resolvePair } from "@/domains/evidence/pairing";
import { resolveEvidenceTargetParts } from "@/domains/evidence/target-label";
import type { Job } from "@/domains/jobs/types";
import { EvidenceContextChips } from "./EvidenceContextChips";
import { listAuditForTarget } from "@/domains/audit-log/client";
import type {
  AuditAction,
  AuditLogEntry,
} from "@/domains/audit-log/types";
import { cn } from "@/lib/cn";

const PILL_TONE_MAP: Record<EvidenceStatusTone, "info" | "success" | "danger"> = {
  info: "info",
  success: "success",
  danger: "danger",
};

interface Props {
  item: EvidenceItem | null;
  /** The job the evidence belongs to — resolves area/task ids to names (#515). */
  job: Job;
  /** The full evidence array for the job (#263). Used to resolve the
   *  before/after partner for the side-by-side pair view. A dangling
   *  pairedWithId (partner missing here) renders single — never crashes. */
  allEvidence?: ReadonlyArray<EvidenceItem>;
  open: boolean;
  isAdmin: boolean;
  /** True while a review or reject mutation is in flight for this item. */
  busy: boolean;
  /** #233 — the viewer's user id, used to detect whether they captured
   *  THIS row. Threaded from the page session. Default-safe: absent =
   *  never treated as the capturer. */
  viewerId?: string;
  /** #233 — true when the viewer is an admin or a leading hand on this
   *  job (i.e. server-side `canManageJob` would pass). Gates the FLAG
   *  half of the as-built toggle for non-capturers. Default-safe: absent
   *  = false (no manager rights). */
  viewerCanManageJob?: boolean;
  onClose: () => void;
  onMarkReviewed: () => void;
  onOpenReject: () => void;
  /** Admin un-review action (D5). Optional — if omitted, the
   *  "Un-review" affordance doesn't render. Always hidden for LH
   *  regardless of value (the parent component is responsible for
   *  passing this only when isAdmin). */
  onOpenUnreview?: () => void;
  /** #263 — unlink the before/after pair. Optional; rendered in the
   *  footer only when the item resolves to a real pair AND a handler is
   *  passed (admin path). */
  onUnlink?: () => void;
  /** #233 — flag / unflag this capture as part of the as-built handover
   *  record. Optional; the toggle only renders for a PHOTO row AND when
   *  the viewer actually has permission for the relevant transition
   *  (mirrors the server's flag/unflag asymmetry), so it never 403s. */
  onToggleAsBuilt?: () => void;
}

type HistoryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; entries: AuditLogEntry[] }
  | { kind: "error"; message: string };

/**
 * Admin evidence detail drawer (doc 30 §6.2; D5 history + un-review).
 *
 * Slides in from the right with full-size photo, full note, target,
 * captured-by, status pill, history, and the primary actions footer.
 *
 *   - admin sees Mark reviewed (primary) + Reject (secondary)
 *   - reviewed items: admin sees Un-review (D5)
 *   - rejected items: immutable; workers re-capture instead
 *   - LH sees the same body but action buttons hidden
 *   - History section consumes /api/audit-log (D5)
 */
export function EvidenceDrawer({
  item,
  job,
  allEvidence,
  open,
  isAdmin,
  busy,
  viewerId,
  viewerCanManageJob,
  onClose,
  onMarkReviewed,
  onOpenReject,
  onOpenUnreview,
  onUnlink,
  onToggleAsBuilt,
}: Props) {
  const [history, setHistory] = useState<HistoryState>({ kind: "idle" });

  // Esc closes the drawer (matches the Phase B reject modal behaviour).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, busy]);

  // Fetch audit history when the drawer opens for a fresh item.
  // Re-fetches on item.status change so a just-reviewed item shows the
  // new audit row without needing a drawer close.
  //
  // D5-FIX-1: Vercel Blob has a ~5s in-memory read cache per function
  // instance (see api/_lib/blob.js BLOB_TTL_MS). After a review action
  // resolves on instance A, the audit-log GET may land on instance B
  // and miss the just-written row. We schedule a second fetch ~2.5s
  // later for status-change re-runs so the History panel catches up
  // without forcing the admin to close+reopen the drawer.
  useEffect(() => {
    if (!open || !item) {
      setHistory({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setHistory({ kind: "loading" });

    const fetchHistory = () =>
      listAuditForTarget({
        jobId: item.jobId,
        targetType: "evidence",
        targetId: item.id,
      }).then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setHistory((prev) => {
            // Only overwrite if the new fetch returned at least as
            // many entries as the previous ready state — never drop
            // entries the prior fetch had already shown.
            const prevCount = prev.kind === "ready" ? prev.entries.length : 0;
            if (r.data.entries.length < prevCount) return prev;
            return { kind: "ready", entries: r.data.entries };
          });
        } else {
          // Don't overwrite a ready state with an error from the retry;
          // the first fetch's data is good enough to display.
          setHistory((prev) => {
            if (prev.kind === "ready") return prev;
            return {
              kind: "error",
              message:
                r.error.status === 403
                  ? "You don't have permission to read the history."
                  : "Couldn't load the history. Retry?",
            };
          });
        }
      });

    fetchHistory();
    // Retry once after the Vercel Blob cache propagation window so the
    // newly-written audit row shows up. Cheap (one GET) and bounded.
    const retryHandle = window.setTimeout(() => {
      if (!cancelled) fetchHistory();
    }, 2500);

    return () => {
      cancelled = true;
      window.clearTimeout(retryHandle);
    };
    // We intentionally depend on item's identity fields rather than the
    // whole item — re-fetching every time a parent passes a new object
    // ref (e.g. on local optimistic state update) would churn the
    // network. The id/jobId/status/updatedAt tuple covers every case
    // where a re-fetch is genuinely needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id, item?.jobId, item?.status, item?.updatedAt]);

  if (!open || !item) return null;

  const tone = PILL_TONE_MAP[statusTone(item.status)];
  const isReviewed = item.status === "reviewed";
  const isRejected = item.status === "rejected";
  const isImmutable = isReviewed || isRejected;

  // #263 — resolve the before/after partner from the full job evidence.
  // A dangling pairedWithId (partner missing) resolves to paired:false, so
  // the single-photo path renders and the unlink affordance hides.
  const pair = resolvePair(allEvidence ?? [], item);
  const showPair = pair.paired && !!pair.before && !!pair.after;

  // #233 — as-built flag control. Photo-only (the server rejects notes),
  // and permission-aware so we never render a button that would 403.
  // Server asymmetry (api/evidence.js):
  //   FLAG   (asBuilt=true):  the capturer of THIS row, OR an admin / LH
  //                           on the job (canManageJob).
  //   UNFLAG (asBuilt=false): the capturer of THIS row, OR an admin.
  // We mirror it exactly: which side of the toggle is live depends on the
  // current flag state, so the control only shows when the action it would
  // perform is actually permitted.
  const isPhoto = item.kind === "photo";
  const isAsBuilt = item.asBuilt === true;
  const isCapturer = !!viewerId && item.capturedById === viewerId;
  const canFlag = isCapturer || !!viewerCanManageJob;
  const canUnflag = isCapturer || isAdmin;
  const canToggleAsBuilt =
    !!onToggleAsBuilt && isPhoto && (isAsBuilt ? canUnflag : canFlag);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Evidence detail"
      className="fixed inset-0 z-40 flex"
      onClick={busy ? undefined : onClose}
    >
      {/* Backdrop */}
      <div className="flex-1 bg-accent-ink/40" />
      {/* Panel — right-aligned on desktop, full-width on mobile */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "flex h-full w-full max-w-xl flex-col bg-surface-raised shadow-raised",
          "pb-[env(safe-area-inset-bottom)]"
        )}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate font-display text-lg font-semibold text-text">
              {kindLabel(item.kind)} · {formatCapturedAt(item.capturedAt)}
            </h2>
            <p className="truncate text-xs text-text-muted">
              by {item.capturedByName}
              {item.capturedByRole ? ` · ${item.capturedByRole}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className={cn(
              "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-card",
              "text-text-muted hover:bg-surface-subtle disabled:opacity-60"
            )}
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={tone}>{statusLabel(item.status)}</Pill>
              {/* #233 — as-built designation, shown to every viewer whenever
                  it's set (mirrors the gallery's as-built chip). */}
              {isAsBuilt ? (
                <Pill tone="warning" data-testid="evidence-asbuilt-pill">
                  As-built
                </Pill>
              ) : null}
              {isReviewed ? (
                <Lock aria-label="Locked" className="h-4 w-4 text-text-muted" />
              ) : null}
              <span className="inline-flex items-center gap-1 text-xs text-text-muted">
                {item.kind === "photo" ? (
                  <ImageIcon aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <FileText aria-hidden="true" className="h-3.5 w-3.5" />
                )}{" "}
                {kindLabel(item.kind)}
              </span>
            </div>

            {isReviewed && item.reviewedByName ? (
              <p className="text-xs text-text-muted">
                Reviewed by{" "}
                <span className="font-medium text-text">{item.reviewedByName}</span>{" "}
                {item.reviewedAt ? `on ${formatCapturedAt(item.reviewedAt)}` : ""}
              </p>
            ) : null}

            {showPair && pair.before && pair.after ? (
              <PairView before={pair.before} after={pair.after} />
            ) : item.kind === "photo" && item.photoUrl ? (
              <div className="overflow-hidden rounded-card border border-border bg-surface-subtle">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={item.photoUrl}
                  alt={item.note ?? "Captured photo"}
                  className="block max-h-[60vh] w-full object-contain"
                />
              </div>
            ) : null}

            {item.note ? (
              <div>
                <p className="font-display text-xs uppercase tracking-wider text-text-muted">
                  Note
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-text">
                  {item.note}
                </p>
              </div>
            ) : null}

            <TargetSection item={item} job={job} />

            {isRejected && item.rejectionReason ? (
              <div className="rounded-card border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                <p className="font-display text-xs uppercase tracking-wider">
                  Rejection reason
                </p>
                <p className="mt-1 whitespace-pre-wrap">{item.rejectionReason}</p>
              </div>
            ) : null}

            <HistorySection state={history} />
          </div>
        </div>

        {canToggleAsBuilt ? (
          <div className="flex items-center justify-between gap-3 border-t border-border bg-surface-subtle px-4 py-2.5">
            <p className="flex items-center gap-1.5 text-xs text-text-muted">
              <Stamp aria-hidden="true" className="h-3.5 w-3.5" />
              {isAsBuilt
                ? "Marked as part of the as-built record."
                : "Mark this photo as part of the as-built record."}
            </p>
            <Button
              variant={isAsBuilt ? "primary" : "secondary"}
              size="sm"
              onClick={onToggleAsBuilt}
              disabled={busy}
              aria-pressed={isAsBuilt}
              data-testid="evidence-asbuilt-toggle"
            >
              <Stamp aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              {isAsBuilt ? "As-built ✓" : "Mark as-built"}
            </Button>
          </div>
        ) : null}

        {showPair && onUnlink ? (
          <div className="flex items-center justify-between gap-3 border-t border-border bg-surface-subtle px-4 py-2.5">
            <p className="flex items-center gap-1.5 text-xs text-text-muted">
              <Link2 aria-hidden="true" className="h-3.5 w-3.5" />
              Paired before/after.
            </p>
            <Button
              variant="ghost"
              size="sm"
              onClick={onUnlink}
              disabled={busy}
            >
              <Link2Off aria-hidden="true" className="mr-1 h-3.5 w-3.5" />
              Unlink
            </Button>
          </div>
        ) : null}

        {isAdmin && !isImmutable ? (
          <footer className="flex flex-col-reverse gap-2 border-t border-border bg-surface-raised px-4 py-3 sm:flex-row sm:justify-end">
            <Button
              variant="ghost"
              size="lg"
              onClick={onOpenReject}
              disabled={busy}
            >
              Reject
            </Button>
            <Button
              variant="primary"
              size="lg"
              onClick={onMarkReviewed}
              disabled={busy}
              className="bg-brand-navy text-text-inverse hover:bg-accent-ink"
            >
              {busy ? "Saving…" : "Mark reviewed"}
            </Button>
          </footer>
        ) : isAdmin && isReviewed && onOpenUnreview ? (
          <footer className="flex flex-col-reverse gap-2 border-t border-border bg-surface-raised px-4 py-3 sm:flex-row sm:items-center sm:justify-end">
            <p className="flex-1 self-center text-xs text-text-muted">
              Already reviewed. Un-review to send it back to the submitted
              queue if the decision was wrong.
            </p>
            <Button
              variant="ghost"
              size="lg"
              onClick={onOpenUnreview}
              disabled={busy}
            >
              {busy ? "Saving…" : "Un-review"}
            </Button>
          </footer>
        ) : (
          <footer className="border-t border-border bg-surface-raised px-4 py-3">
            <p className="text-xs text-text-muted">
              {!isAdmin
                ? "Read-only access — leading hand."
                : isReviewed
                  ? "This evidence has been reviewed."
                  : "This evidence has been rejected."}
            </p>
          </footer>
        )}
      </div>
    </div>
  );
}

/**
 * #263 — side-by-side before/after pair. Renders BOTH photos with BOTH
 * timestamps and BOTH status pills. Mixed-status honesty: a rejected
 * before next to a reviewed after shows both — the rejected half is never
 * hidden. The link is stored on the after; the before half is read-only.
 */
function PairView({
  before,
  after,
}: {
  before: EvidenceItem;
  after: EvidenceItem;
}) {
  return (
    <div>
      <p className="font-display text-xs uppercase tracking-wider text-text-muted">
        Before / after
      </p>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <PairHalf label="Before" item={before} />
        <PairHalf label="After" item={after} />
      </div>
    </div>
  );
}

function PairHalf({ label, item }: { label: string; item: EvidenceItem }) {
  const tone = PILL_TONE_MAP[statusTone(item.status)];
  return (
    <figure className="min-w-0 space-y-1.5">
      <figcaption className="flex items-center justify-between gap-1">
        <span className="font-display text-[11px] font-semibold uppercase tracking-wider text-text-muted">
          {label}
        </span>
        <Pill tone={tone}>{statusLabel(item.status)}</Pill>
      </figcaption>
      {item.kind === "photo" && item.photoUrl ? (
        <div className="overflow-hidden rounded-card border border-border bg-surface-subtle">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.photoUrl}
            alt={item.note ?? `${label} photo`}
            className="block max-h-[40vh] w-full object-contain"
          />
        </div>
      ) : (
        <div className="flex aspect-square items-center justify-center rounded-card border border-border bg-surface-subtle text-text-muted">
          <ImageIcon aria-hidden="true" className="h-6 w-6" />
        </div>
      )}
      <time
        dateTime={item.capturedAt}
        title={item.capturedAt}
        className="block text-[11px] text-text-muted"
      >
        {formatCapturedAt(item.capturedAt)}
      </time>
    </figure>
  );
}

function TargetSection({ item, job }: { item: EvidenceItem; job: Job }) {
  // #515 + #260: stage / area / task as compact chips (room + task NAMES, not
  // raw ids), falling back to the raw id with an honest "(unknown)" hint.
  const parts = resolveEvidenceTargetParts(job, item);
  const hasContext = Boolean(parts.stage || parts.area || parts.task);
  return (
    <div>
      <p className="font-display text-xs uppercase tracking-wider text-text-muted">
        Target
      </p>
      {hasContext ? (
        <div className="mt-1">
          <EvidenceContextChips parts={parts} />
        </div>
      ) : (
        <div className="mt-1 inline-flex flex-col gap-1">
          <Pill tone="neutral">Unattached</Pill>
          <span className="text-xs text-text-muted">
            Worker captured without picking an area, stage or task.
          </span>
        </div>
      )}
    </div>
  );
}

function HistorySection({ state }: { state: HistoryState }) {
  return (
    <div>
      <p className="font-display text-xs uppercase tracking-wider text-text-muted">
        History
      </p>
      {state.kind === "loading" ? (
        <p className="mt-2 rounded-card border border-dashed border-border bg-surface-subtle p-3 text-xs text-text-muted">
          Loading…
        </p>
      ) : state.kind === "error" ? (
        <p
          role="alert"
          className="mt-2 rounded-card border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800"
        >
          {state.message}
        </p>
      ) : state.kind === "ready" && state.entries.length === 0 ? (
        <p className="mt-2 rounded-card border border-dashed border-border bg-surface-subtle p-3 text-xs text-text-muted">
          No audit entries yet.
        </p>
      ) : state.kind === "ready" ? (
        <ul className="mt-2 space-y-2">
          {state.entries.map((e) => (
            <li
              key={e.id}
              className="flex items-start gap-3 rounded-card border border-border bg-surface px-3 py-2 text-sm"
            >
              <ActionIcon action={e.action} />
              <div className="min-w-0 flex-1">
                <p className="text-text">{e.summary}</p>
                <p className="mt-0.5 text-xs text-text-muted">
                  {e.actorName}
                  {e.actorRole ? ` (${e.actorRole})` : ""} ·{" "}
                  <time dateTime={e.ts} title={e.ts}>
                    {formatCapturedAt(e.ts)}
                  </time>
                </p>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ActionIcon({ action }: { action: AuditAction }) {
  switch (action) {
    case "evidence.captured":
      return (
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill bg-sky-100 text-sky-700"
        >
          <PenSquare className="h-3.5 w-3.5" />
        </span>
      );
    case "evidence.reviewed":
      return (
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill bg-emerald-100 text-emerald-700"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
        </span>
      );
    case "evidence.rejected":
      return (
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill bg-rose-100 text-rose-700"
        >
          <XCircle className="h-3.5 w-3.5" />
        </span>
      );
    case "evidence.linked":
      return (
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill bg-indigo-100 text-indigo-700"
        >
          <Link2 className="h-3.5 w-3.5" />
        </span>
      );
    case "evidence.unlinked":
      return (
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill bg-slate-100 text-slate-700"
        >
          <Link2Off className="h-3.5 w-3.5" />
        </span>
      );
  }
}

function formatCapturedAt(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("en-AU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Australia/Sydney",
    });
  } catch {
    return "";
  }
}
