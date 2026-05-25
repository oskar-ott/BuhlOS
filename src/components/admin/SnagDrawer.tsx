"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Image as ImageIcon,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Pill } from "@/components/ui/Pill";
import {
  priorityLabel,
  priorityTone,
  statusLabel,
  statusTone,
  type SnagPriorityTone,
  type SnagStatusTone,
} from "@/domains/snags/format";
import { canRoleTransition, canTransition } from "@/domains/snags/service";
import type { SnagItem, SnagStatus } from "@/domains/snags/types";
import { listAuditForTarget } from "@/domains/audit-log/client";
import type { AuditAction, AuditLogEntry } from "@/domains/audit-log/types";
import { cn } from "@/lib/cn";

const STATUS_TONE_MAP: Record<SnagStatusTone, "info" | "success" | "danger" | "warning" | "neutral"> = {
  info: "info",
  success: "success",
  danger: "danger",
  warning: "warning",
  neutral: "neutral",
};

const PRIORITY_TONE_MAP: Record<SnagPriorityTone, "neutral" | "warning" | "danger"> = {
  neutral: "neutral",
  warning: "warning",
  danger: "danger",
};

interface Props {
  snag: SnagItem | null;
  open: boolean;
  isAdmin: boolean;
  viewer: { id: string; role: string };
  busy: boolean;
  onClose: () => void;
  onTransition: (next: SnagStatus) => void;
  onOpenReject: () => void;
}

type HistoryState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; entries: AuditLogEntry[] }
  | { kind: "error"; message: string };

/**
 * Admin snag detail drawer (Phase D.5).
 *
 * Mirrors EvidenceDrawer's shape: right-slide panel with body + history
 * + admin actions footer.
 *
 *   - Body: title, full description, priority + status pills,
 *     target (area / stage / task), raised-by + raised-at, linked
 *     evidence IDs, current assignee.
 *   - History: cross-surface audit-log entries for this snag
 *     (snag.created + snag.transitioned verbs).
 *   - Actions footer (admin only): the next-step button per status
 *     + reject + re-open as applicable.
 *
 * LH sees the same body + history but the footer collapses to a
 * read-only label.
 */
export function SnagDrawer({
  snag,
  open,
  isAdmin,
  viewer,
  busy,
  onClose,
  onTransition,
  onOpenReject,
}: Props) {
  const [history, setHistory] = useState<HistoryState>({ kind: "idle" });

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !busy) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  // Fetch the audit history whenever the drawer opens on a new snag
  // OR when the snag status changes (a fresh write should refresh the
  // panel). Mirrors EvidenceDrawer's pattern.
  const snagId = snag?.id ?? null;
  const snagStatus = snag?.status ?? null;
  const snagJobId = snag?.jobId ?? null;
  useEffect(() => {
    if (!open || !snagId || !snagJobId) {
      setHistory({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setHistory({ kind: "loading" });
    listAuditForTarget({
      jobId: snagJobId,
      targetType: "snag",
      targetId: snagId,
    }).then((r) => {
      if (cancelled) return;
      if (r.ok) setHistory({ kind: "ready", entries: r.data.entries });
      else setHistory({ kind: "error", message: r.error.message || "Couldn't load history" });
    });
    return () => {
      cancelled = true;
    };
  }, [open, snagId, snagStatus, snagJobId]);

  if (!open || !snag) return null;

  const ctx = {
    userId: viewer.id,
    role: viewer.role,
    creatorId: snag.createdById ?? null,
    assignedToId: snag.assignedToId ?? null,
  };

  // Calculate every transition the viewer can perform from the current
  // status. The drawer lists them all (queue row only shows the primary
  // next-step) so the admin can re-open a closed snag, etc.
  const NEXTS: SnagStatus[] = [
    "in_progress",
    "resolved",
    "verified",
    "closed",
    "open",
  ];
  const availableTransitions = NEXTS.filter(
    (to) =>
      to !== snag.status &&
      canTransition(snag.status, to) &&
      canRoleTransition(snag.status, to, ctx)
  );
  const canReject =
    isAdmin &&
    canTransition(snag.status, "rejected") &&
    canRoleTransition(snag.status, "rejected", ctx);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Snag details"
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
              Snag
            </p>
            <h2 className="mt-0.5 break-words font-display text-lg text-text">
              {snag.title}
            </h2>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Pill tone={STATUS_TONE_MAP[statusTone(snag.status)]}>
                {statusLabel(snag.status)}
              </Pill>
              <Pill tone={PRIORITY_TONE_MAP[priorityTone(snag.priority)]}>
                {priorityLabel(snag.priority)}
              </Pill>
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
          {snag.description ? (
            <section>
              <h3 className="font-display text-xs uppercase tracking-wider text-text-muted">
                Details
              </h3>
              <p className="mt-1 whitespace-pre-line break-words text-sm text-text">
                {snag.description}
              </p>
            </section>
          ) : null}

          <section>
            <h3 className="font-display text-xs uppercase tracking-wider text-text-muted">
              Target
            </h3>
            <dl className="mt-1 grid gap-1 text-sm">
              <Field label="Area">
                {snag.areaName ?? (snag.areaId ? `Area ${snag.areaId}` : "—")}
              </Field>
              <Field label="Stage">
                {snag.stage
                  ? snag.stage === "roughIn"
                    ? "Rough-in"
                    : "Fit-off"
                  : "—"}
              </Field>
              <Field label="Task">
                {snag.taskName ?? (snag.taskId ? `Task ${snag.taskId}` : "—")}
              </Field>
            </dl>
          </section>

          <section>
            <h3 className="font-display text-xs uppercase tracking-wider text-text-muted">
              Raised
            </h3>
            <dl className="mt-1 grid gap-1 text-sm">
              <Field label="By">
                {snag.createdByName}
                {snag.createdByRole ? (
                  <span className="ml-1 text-xs text-text-muted">
                    ({snag.createdByRole})
                  </span>
                ) : null}
              </Field>
              <Field label="At">
                <time dateTime={snag.createdAt} title={snag.createdAt}>
                  {formatWhen(snag.createdAt)}
                </time>
              </Field>
              {snag.assignedToName ? (
                <Field label="Assignee">{snag.assignedToName}</Field>
              ) : null}
            </dl>
          </section>

          {snag.evidenceIds.length > 0 ? (
            <section>
              <h3 className="font-display text-xs uppercase tracking-wider text-text-muted">
                Linked evidence
              </h3>
              <ul className="mt-1 grid gap-1 text-sm">
                {snag.evidenceIds.map((id) => (
                  <li key={id} className="flex items-center gap-2 text-text">
                    <ImageIcon
                      aria-hidden="true"
                      className="h-4 w-4 text-text-muted"
                    />
                    <code className="text-xs">{id}</code>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {snag.status === "rejected" && snag.rejectionReason ? (
            <section
              role="alert"
              className="rounded-card border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"
            >
              <p className="font-display text-xs uppercase tracking-wider text-rose-700">
                Rejected
              </p>
              <p className="mt-1 whitespace-pre-line break-words">
                {snag.rejectionReason}
              </p>
            </section>
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
            {availableTransitions.length === 0 && !canReject ? (
              <p className="text-xs text-text-muted">
                No actions available from {statusLabel(snag.status)}.
              </p>
            ) : null}
            {availableTransitions.map((to) => (
              <Button
                key={to}
                type="button"
                variant={primaryActionVariant(to)}
                onClick={() => onTransition(to)}
                disabled={busy}
                className={cn("w-full", primaryActionClass(to))}
              >
                {iconForTransition(to)}
                {labelForTransition(to)}
              </Button>
            ))}
            {canReject ? (
              <Button
                type="button"
                variant="danger"
                onClick={onOpenReject}
                disabled={busy}
                className="w-full"
              >
                <XCircle aria-hidden="true" className="h-4 w-4" />
                Reject snag
              </Button>
            ) : null}
          </footer>
        ) : (
          <footer className="border-t border-border px-4 py-3">
            <p className="text-xs text-text-muted">
              Read-only — leading hand. Ask an admin to change status.
            </p>
          </footer>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-xs font-medium text-text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-text">{children}</dd>
    </div>
  );
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
  if (action === "snag.created") {
    return (
      <AlertTriangle
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-600"
      />
    );
  }
  if (action === "snag.transitioned") {
    return (
      <RotateCcw
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-sky-600"
      />
    );
  }
  // Evidence actions can also surface in this list if the snag links
  // evidence (future); render a neutral icon.
  return (
    <CheckCircle2
      aria-hidden="true"
      className="mt-0.5 h-4 w-4 shrink-0 text-text-muted"
    />
  );
}

function iconForTransition(to: SnagStatus) {
  if (to === "verified" || to === "closed") {
    return (
      <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
    );
  }
  if (to === "open") {
    return <RotateCcw aria-hidden="true" className="h-4 w-4" />;
  }
  return null;
}

function labelForTransition(to: SnagStatus): string {
  switch (to) {
    case "open":
      return "Re-open";
    case "in_progress":
      return "Mark in progress";
    case "resolved":
      return "Mark resolved";
    case "verified":
      return "Verify";
    case "closed":
      return "Close";
    case "rejected":
      return "Reject";
  }
}

function primaryActionVariant(to: SnagStatus): "primary" | "secondary" {
  if (to === "verified" || to === "closed") return "primary";
  return "secondary";
}

function primaryActionClass(to: SnagStatus): string {
  if (to === "verified" || to === "closed")
    return "bg-brand-navy text-text-inverse hover:bg-accent-ink";
  return "";
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
