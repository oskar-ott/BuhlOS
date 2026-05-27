"use client";

import { useEffect, useState } from "react";
import {
  Archive,
  CheckCircle2,
  ClipboardCheck,
  PenSquare,
  RotateCcw,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import {
  formatProgress,
  pointTypeLabel,
  scopeContextLine,
  statusLabel,
  statusTone,
  valuePassFailLabel,
  type ITPStatusTone,
} from "@/domains/itp/format";
import {
  canSignOff,
  canTransition,
  pointsRecordedByUserRatio,
} from "@/domains/itp/service";
import type {
  ITPInstance,
  ITPInstanceResult,
  ITPTemplatePoint,
} from "@/domains/itp/types";
import { listAuditForTarget } from "@/domains/audit-log/client";
import type { AuditAction, AuditLogEntry } from "@/domains/audit-log/types";
import { resolveScopeName } from "@/components/phil/itp-scope";
import type { Job } from "@/domains/jobs/types";
import { cn } from "@/lib/cn";

const STATUS_TONE_MAP: Record<
  ITPStatusTone,
  "info" | "success" | "warning" | "neutral"
> = {
  info: "info",
  success: "success",
  warning: "warning",
  neutral: "neutral",
};

interface Props {
  job: Job;
  instance: ITPInstance | null;
  open: boolean;
  /** True for admin tier; false for LH (read-only — no Sign off / Reopen
   *  / Archive footer). */
  isAdmin: boolean;
  viewer: { id: string; role: string };
  busy: boolean;
  onClose: () => void;
  onSignOff: () => void;
  onReopen: () => void;
  onArchive: () => void;
}

type HistoryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; entries: AuditLogEntry[] }
  | { kind: "error"; message: string };

/**
 * Phase E1c — admin ITP detail drawer.
 *
 * Right-slide panel with body + history + admin actions footer. Mirrors
 * SnagDrawer.tsx layout so admin muscle memory is identical between the
 * two surfaces.
 *
 * Body:
 *   - Header: template name, scope context, status pill, progress badge.
 *   - Point grid: one row per template point with type-specific result
 *     rendering (photo thumbnail, value + pass/fail pill, signoff
 *     check, note excerpt), recorded-by + at.
 *   - History panel: cross-surface audit-log entries for this
 *     itp_instance, with the same 2.5s retry the SnagDrawer uses to
 *     catch the just-written audit row past the Vercel Blob 5s cache.
 *
 * Footer (admin only):
 *   - "Sign off" — opens the sign-off modal (with independence rule).
 *     Shown only when canTransition(status, 'signed-off') passes.
 *   - "Reopen" — direct POST. Shown only on signed-off rows.
 *   - "Archive" — direct POST with an inline confirm. Always available
 *     to admins on non-archived rows (the API also gates).
 *
 * LH viewers see the same body + history but the footer renders a
 * read-only label — same pattern as SnagDrawer.
 *
 * RSC manifest rule (doc 24 D-26): this file lives under
 * src/components/admin/, NOT under src/app/v2/jobs/[jobId]/itps/.
 */
export function ITPDrawer({
  job,
  instance,
  open,
  isAdmin,
  viewer,
  busy,
  onClose,
  onSignOff,
  onReopen,
  onArchive,
}: Props) {
  const [history, setHistory] = useState<HistoryState>({ kind: "idle" });
  const [archiveConfirming, setArchiveConfirming] = useState(false);

  // Esc closes.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  // Reset confirm when the drawer closes or switches instances.
  useEffect(() => {
    setArchiveConfirming(false);
  }, [instance?.id, open]);

  // Audit-log fetch with the 2.5s retry pattern (BLOB_TTL_MS dance).
  const instanceId = instance?.id ?? null;
  const jobId = job.id;
  const status = instance?.status ?? null;
  const updatedAt = instance?.updatedAt ?? null;
  useEffect(() => {
    if (!open || !instanceId) {
      setHistory({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setHistory({ kind: "loading" });

    const fetchHistory = () =>
      listAuditForTarget({
        jobId,
        targetType: "itp_instance",
        targetId: instanceId,
      }).then((r) => {
        if (cancelled) return;
        if (r.ok) {
          setHistory((prev) => {
            const prevCount = prev.kind === "ready" ? prev.entries.length : 0;
            if (r.data.entries.length < prevCount) return prev;
            return { kind: "ready", entries: r.data.entries };
          });
        } else {
          setHistory((prev) => {
            if (prev.kind === "ready") return prev;
            return {
              kind: "error",
              message:
                r.error.status === 403
                  ? "You don't have permission to read the history."
                  : r.error.message || "Couldn't load history",
            };
          });
        }
      });

    fetchHistory();
    const retryHandle = window.setTimeout(() => {
      if (!cancelled) fetchHistory();
    }, 2500);

    return () => {
      cancelled = true;
      window.clearTimeout(retryHandle);
    };
  }, [open, jobId, instanceId, status, updatedAt]);

  if (!open || !instance) return null;

  const progress = formatProgress(instance);
  const scopeName = resolveScopeName(job, instance);
  const scopeLine = scopeContextLine(instance.scope, scopeName);
  const templateName =
    instance.templateSnapshot?.name?.trim() || "Untitled ITP";

  const points = (instance.templateSnapshot?.points ?? [])
    .filter((p) => !p.archived)
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const signOffDecision = canSignOff(instance, {
    userId: viewer.id,
    role: viewer.role,
  });
  const canSignOffHere =
    isAdmin && canTransition(instance.status, "signed-off");
  const canReopenHere =
    isAdmin && canTransition(instance.status, "witnessed") &&
    instance.status === "signed-off";
  const canArchiveHere = isAdmin && !instance.archived;

  const ratio = pointsRecordedByUserRatio(instance, viewer.id);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="ITP details"
      className="fixed inset-0 z-40 flex justify-end bg-accent-ink/40"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col bg-surface shadow-raised sm:rounded-l-card"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-display text-xs uppercase tracking-wider text-text-muted">
              ITP
            </p>
            <h2 className="mt-0.5 break-words font-display text-lg text-text">
              {templateName}
            </h2>
            <p className="mt-0.5 text-xs text-text-muted">{scopeLine}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Pill tone={STATUS_TONE_MAP[statusTone(instance.status)]}>
                {statusLabel(instance.status)}
              </Pill>
              <span className="text-xs text-text-muted">
                {progress.done} / {progress.total}
                {progress.total > 0 ? " points" : null}
              </span>
              {instance.archived ? (
                <Pill tone="neutral">Archived</Pill>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-card p-1 text-text-muted hover:bg-surface-subtle disabled:opacity-50"
            aria-label="Close"
          >
            <X aria-hidden="true" className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
          <section>
            <h3 className="font-display text-xs uppercase tracking-wider text-text-muted">
              Attached
            </h3>
            <dl className="mt-1 grid gap-1 text-sm">
              <Field label="By">{instance.createdBy || "—"}</Field>
              <Field label="At">
                <time dateTime={instance.createdAt} title={instance.createdAt}>
                  {formatWhen(instance.createdAt)}
                </time>
              </Field>
              {instance.signedOffBy ? (
                <Field label="Signed off">
                  {instance.signedOffBy}
                  {instance.signedOffAt ? (
                    <span className="ml-1 text-xs text-text-muted">
                      ({formatWhen(instance.signedOffAt)})
                    </span>
                  ) : null}
                </Field>
              ) : null}
            </dl>
          </section>

          <section>
            <h3 className="font-display text-xs uppercase tracking-wider text-text-muted">
              Points
            </h3>
            {points.length === 0 ? (
              <p className="mt-1 rounded-card border border-dashed border-border bg-surface-subtle p-3 text-xs text-text-muted">
                No points on this template.
              </p>
            ) : (
              <ol className="mt-1 space-y-2">
                {points.map((point) => (
                  <li key={point.id}>
                    <PointRow
                      point={point}
                      result={instance.results?.[point.id]}
                    />
                  </li>
                ))}
              </ol>
            )}
          </section>

          {signOffDecision.ok === false &&
          signOffDecision.reason === "needs-justification" ? (
            <p
              role="status"
              className="rounded-card border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
            >
              You recorded {Math.round(ratio * 100)}% of the points on this
              ITP — signing off will require an override justification.
            </p>
          ) : null}

          <section>
            <h3 className="font-display text-xs uppercase tracking-wider text-text-muted">
              History
            </h3>
            <HistoryList state={history} />
          </section>
        </div>

        {isAdmin ? (
          <footer className="border-t border-border px-4 py-3 space-y-2">
            {!canSignOffHere && !canReopenHere && !canArchiveHere ? (
              <p className="text-xs text-text-muted">
                No actions available from {statusLabel(instance.status)}.
              </p>
            ) : null}
            {canSignOffHere ? (
              <Button
                type="button"
                variant="primary"
                onClick={onSignOff}
                disabled={busy}
                className="w-full bg-brand-navy text-text-inverse hover:bg-accent-ink"
              >
                <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
                Sign off
              </Button>
            ) : null}
            {canReopenHere ? (
              <Button
                type="button"
                variant="secondary"
                onClick={onReopen}
                disabled={busy}
                className="w-full"
              >
                <RotateCcw aria-hidden="true" className="h-4 w-4" />
                Reopen
              </Button>
            ) : null}
            {canArchiveHere ? (
              archiveConfirming ? (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setArchiveConfirming(false)}
                    disabled={busy}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={onArchive}
                    disabled={busy}
                    className="flex-1"
                  >
                    {busy ? "Archiving…" : "Confirm archive"}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setArchiveConfirming(true)}
                  disabled={busy}
                  className="w-full text-text-muted"
                >
                  <Archive aria-hidden="true" className="h-4 w-4" />
                  Archive
                </Button>
              )
            ) : null}
          </footer>
        ) : (
          <footer className="border-t border-border px-4 py-3">
            <p className="text-xs text-text-muted">
              Read-only — leading hand. Ask an admin to sign off.
            </p>
          </footer>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2">
      <dt className="w-24 shrink-0 text-xs font-medium text-text-muted">
        {label}
      </dt>
      <dd className="min-w-0 flex-1 break-words text-text">{children}</dd>
    </div>
  );
}

function PointRow({
  point,
  result,
}: {
  point: ITPTemplatePoint;
  result: ITPInstanceResult | undefined;
}) {
  const required = point.required !== false;
  const recorded = result?.at != null;
  const label = point.label || pointTypeLabel(point.type);
  const passFail = point.type === "value" ? valuePassFailLabel(point, result) : null;

  return (
    <div
      className={cn(
        "rounded-card border bg-surface p-3 text-sm",
        recorded ? "border-border" : "border-dashed border-border bg-surface-subtle",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium text-text">
            {label}
            {required ? (
              <span className="ml-1 text-state-danger" aria-label="required">
                *
              </span>
            ) : null}
          </p>
          <p className="text-xs text-text-muted">
            {pointTypeLabel(point.type)}
            {point.unit ? ` · ${point.unit}` : null}
          </p>
        </div>
        {passFail ? (
          <Pill tone={passFail === "Pass" ? "success" : "danger"}>{passFail}</Pill>
        ) : recorded ? (
          <Pill tone="success">Recorded</Pill>
        ) : (
          <Pill tone="neutral">Pending</Pill>
        )}
      </div>

      {recorded && result ? (
        <div className="mt-2 space-y-2">
          {renderResultValue(point, result)}
          {result.note ? (
            <p className="break-words text-xs text-text-muted">
              <span className="font-medium text-text">Note:</span> {result.note}
            </p>
          ) : null}
          {result.photoUrl ? (
            <a
              href={result.photoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block overflow-hidden rounded-card border border-border bg-surface-subtle"
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- public Blob URL preview */}
              <img
                src={result.photoUrl}
                alt={`Photo recorded for ${label}`}
                className="block max-h-48 w-full object-contain"
              />
            </a>
          ) : null}
          <p className="text-[11px] text-text-muted">
            By {result.byUsername} ·{" "}
            <time dateTime={result.at} title={result.at}>
              {formatWhen(result.at)}
            </time>
          </p>
        </div>
      ) : null}
    </div>
  );
}

function renderResultValue(
  point: ITPTemplatePoint,
  result: ITPInstanceResult,
): React.ReactNode {
  if (point.type === "value") {
    const v = result.value;
    if (v == null || v === "") return null;
    return (
      <p className="text-sm text-text">
        Value: <span className="font-medium">{String(v)}</span>
        {point.unit ? ` ${point.unit}` : null}
      </p>
    );
  }
  if (point.type === "signoff") {
    const checked = result.value === true;
    return (
      <p className="text-sm text-text">
        {checked ? "✓ Marked complete" : "Not marked complete"}
      </p>
    );
  }
  return null;
}

function HistoryList({ state }: { state: HistoryState }) {
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <p className="mt-1 rounded-card border border-dashed border-border bg-surface-subtle p-3 text-xs text-text-muted">
        {state.kind === "loading" ? "Loading…" : ""}
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="mt-1 rounded-card border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
        {state.message}
      </p>
    );
  }
  if (state.entries.length === 0) {
    return (
      <p className="mt-1 rounded-card border border-dashed border-border bg-surface-subtle p-3 text-xs text-text-muted">
        No history yet.
      </p>
    );
  }
  return (
    <ol className="mt-1 space-y-2 text-sm">
      {state.entries.map((e) => (
        <li
          key={e.id}
          className="flex items-start gap-2 rounded-card border border-border bg-surface p-2.5"
        >
          {iconForAction(e.action)}
          <div className="min-w-0 flex-1">
            <p className="break-words text-text">{e.summary}</p>
            <p className="mt-0.5 text-xs text-text-muted">
              <span>{e.actorName}</span>
              {e.actorRole ? (
                <span className="ml-1">({e.actorRole})</span>
              ) : null}
              <span className="mx-1">·</span>
              <time dateTime={e.ts} title={e.ts}>
                {formatWhen(e.ts)}
              </time>
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function iconForAction(action: AuditAction) {
  if (action === "itp.attached") {
    return (
      <ClipboardCheck
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-sky-600"
      />
    );
  }
  if (action === "itp.point.recorded") {
    return (
      <PenSquare
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
      />
    );
  }
  if (action === "itp.signed_off") {
    return (
      <CheckCircle2
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
      />
    );
  }
  if (action === "itp.reopened") {
    return (
      <RotateCcw
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
      />
    );
  }
  if (action === "itp.archived") {
    return (
      <Archive
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
      />
    );
  }
  // Fallback for unknown actions.
  return (
    <CheckCircle2
      aria-hidden="true"
      className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
    />
  );
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000) return "just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
    return d.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      timeZone: "Australia/Sydney",
    });
  } catch {
    return "";
  }
}
