"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Image as ImageIcon } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pill } from "@/components/ui/Pill";
import {
  isActive,
  isDone,
  priorityLabel,
  priorityTone,
  statusLabel,
  statusTone,
  type SnagPriorityTone,
  type SnagStatusTone,
} from "@/domains/snags/format";
import { transitionSnag } from "@/domains/snags/client";
import {
  canRoleTransition,
  canTransition,
  compareForQueue,
} from "@/domains/snags/service";
import type { SnagItem, SnagStatus } from "@/domains/snags/types";
import type { Job } from "@/domains/jobs/types";
import { SnagDrawer } from "./SnagDrawer";
import { SnagRejectModal } from "./SnagRejectModal";
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

type FilterMode = "active" | "done" | "all";

interface Props {
  job: Job;
  initialSnags: ReadonlyArray<SnagItem>;
  fetchError: string | null;
  /** True for admin; false for leading hand (read-only). */
  isAdmin: boolean;
  /** Current viewer — used by canRoleTransition to gate field-role
   *  buttons. Admin always passes regardless of id. */
  viewer: { id: string; role: string };
}

type ActionState =
  | { kind: "idle" }
  | { kind: "in_flight"; snagId: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

/**
 * Phase D.5 admin snags / defects queue.
 *
 * Server component (page.tsx) fetches the initial list; this client
 * component owns filtering, drawer state, and the transition / reject
 * mutations. Mirrors the EvidenceQueue shape so the muscle memory
 * between the two admin queues is identical.
 *
 * Doc 27 §5.2 / §9.5 + doc 30 §6.1:
 *   - Status-first rows with status + priority pills, title excerpt,
 *     target (stage / area / task), created-by, created-at, primary
 *     action button.
 *   - Default filter hides 'verified' + 'closed' (the "done" pile)
 *     so the admin's eye lands on what still needs work.
 *   - Click row → drawer with description / history / link to
 *     evidence / action buttons.
 *   - Reject opens a small modal with required reason.
 *
 * RSC manifest rule (doc 24 D-26): this file lives in
 * src/components/admin/, NOT under src/app/v2/jobs/[jobId]/snags/.
 */
export function SnagsQueue({
  job,
  initialSnags,
  fetchError,
  isAdmin,
  viewer,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [items, setItems] = useState<ReadonlyArray<SnagItem>>(initialSnags);
  const [filter, setFilter] = useState<FilterMode>("active");
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });

  const visible = useMemo(() => {
    const filtered = items.filter((s) => {
      if (filter === "active") return isActive(s.status);
      if (filter === "done") return isDone(s.status) || s.status === "rejected";
      return true;
    });
    return filtered.slice().sort(compareForQueue);
  }, [items, filter]);

  const counts = useMemo(() => {
    let active = 0;
    let done = 0;
    for (const s of items) {
      if (isActive(s.status)) active += 1;
      else if (isDone(s.status) || s.status === "rejected") done += 1;
    }
    return { active, done, all: items.length };
  }, [items]);

  const drawerItem = useMemo(
    () => items.find((s) => s.id === drawerId) ?? null,
    [items, drawerId]
  );
  const rejectItem = useMemo(
    () => items.find((s) => s.id === rejectId) ?? null,
    [items, rejectId]
  );

  const applyServer = useCallback((next: SnagItem) => {
    setItems((prev) => prev.map((s) => (s.id === next.id ? next : s)));
  }, []);

  const runTransition = useCallback(
    async (snag: SnagItem, nextStatus: SnagStatus, reason?: string) => {
      setAction({ kind: "in_flight", snagId: snag.id });
      const r = await transitionSnag(job.id, {
        snagId: snag.id,
        nextStatus,
        reason: reason ? reason : null,
      });
      if (r.ok) {
        applyServer(r.data.snagItem);
        setAction({
          kind: "success",
          message: messageForTransition(snag.status, nextStatus),
        });
        startTransition(() => router.refresh());
        if (nextStatus === "rejected") setRejectId(null);
      } else {
        setAction({
          kind: "error",
          message:
            r.error.status === 403
              ? "You can't perform that action."
              : r.error.status === 400
                ? "Couldn't update — the snag may have changed since you loaded the page."
                : r.error.message || "Couldn't update snag. Try again.",
        });
      }
    },
    [job.id, applyServer, router]
  );

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <CardTitle>Snags · {job.name}</CardTitle>
            <CardDescription className="mt-1">
              Issues raised on this job. Verify or reject worker resolutions to
              close the loop.
            </CardDescription>
          </div>
          {!isAdmin ? (
            <Pill tone="neutral">Read-only — leading hand</Pill>
          ) : null}
        </div>
      </Card>

      {fetchError ? (
        <Card className="border-amber-200 bg-amber-50" role="alert">
          <CardTitle>Couldn&rsquo;t load the queue</CardTitle>
          <CardDescription className="text-amber-900">
            {fetchError}. Try refreshing in a moment.
          </CardDescription>
        </Card>
      ) : null}

      <ActionFeedback state={action} />

      <FilterBar
        value={filter}
        onChange={setFilter}
        counts={counts}
        visibleCount={visible.length}
      />

      {visible.length === 0 ? (
        <EmptyState
          title={
            items.length === 0
              ? "No snags raised on this job yet."
              : filter === "active"
                ? "No active snags. Nice."
                : "Nothing matches this filter."
          }
          description={
            items.length === 0
              ? "When a worker reports a snag from Phil, it lands here for you to action."
              : "Switch filters to see what's there."
          }
        />
      ) : (
        <div className="overflow-hidden rounded-card border border-border bg-surface-raised">
          <table className="min-w-full divide-y divide-border">
            <thead className="bg-surface-subtle text-left">
              <tr>
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  Status
                </th>
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  Snag
                </th>
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  Target
                </th>
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  Raised by
                </th>
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  When
                </th>
                {isAdmin ? (
                  <th className="px-3 py-2.5 text-right font-display text-xs uppercase tracking-wider text-text-muted">
                    Actions
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visible.map((s) => (
                <SnagRow
                  key={s.id}
                  snag={s}
                  isAdmin={isAdmin}
                  viewer={viewer}
                  busy={action.kind === "in_flight" && action.snagId === s.id}
                  onOpen={() => setDrawerId(s.id)}
                  onTransition={(to) => runTransition(s, to)}
                  onOpenReject={() => setRejectId(s.id)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SnagDrawer
        snag={drawerItem}
        open={drawerItem !== null}
        isAdmin={isAdmin}
        viewer={viewer}
        busy={
          drawerItem
            ? (action.kind === "in_flight" && action.snagId === drawerItem.id) ||
              rejectId === drawerItem.id
            : false
        }
        onClose={() => setDrawerId(null)}
        onTransition={(to) => {
          if (drawerItem) runTransition(drawerItem, to);
        }}
        onOpenReject={() => {
          if (drawerItem) setRejectId(drawerItem.id);
        }}
      />

      <SnagRejectModal
        open={rejectItem !== null}
        snag={rejectItem}
        busy={
          rejectItem
            ? action.kind === "in_flight" && action.snagId === rejectItem.id
            : false
        }
        onClose={() => setRejectId(null)}
        onSubmit={(reason) => {
          if (rejectItem) runTransition(rejectItem, "rejected", reason);
        }}
      />
    </div>
  );
}

function FilterBar({
  value,
  onChange,
  counts,
  visibleCount,
}: {
  value: FilterMode;
  onChange: (m: FilterMode) => void;
  counts: { active: number; done: number; all: number };
  visibleCount: number;
}) {
  const buttons: Array<{ key: FilterMode; label: string; count: number }> = [
    { key: "active", label: "Active", count: counts.active },
    { key: "done", label: "Done", count: counts.done },
    { key: "all", label: "All", count: counts.all },
  ];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div role="tablist" aria-label="Filter snags" className="flex gap-2">
        {buttons.map((b) => (
          <button
            key={b.key}
            type="button"
            role="tab"
            aria-selected={value === b.key}
            onClick={() => onChange(b.key)}
            className={cn(
              "rounded-pill border px-3 py-1.5 text-sm transition-colors",
              value === b.key
                ? "border-brand-navy bg-brand-navy text-text-inverse"
                : "border-border bg-surface text-text hover:bg-surface-subtle"
            )}
          >
            {b.label}
            <span
              className={cn(
                "ml-2 inline-flex h-5 min-w-[20px] items-center justify-center rounded-pill px-1.5 text-[11px]",
                value === b.key
                  ? "bg-accent-yellow text-brand-navy"
                  : "bg-surface-subtle text-text-muted"
              )}
            >
              {b.count}
            </span>
          </button>
        ))}
      </div>
      <p className="text-xs text-text-muted">Showing {visibleCount}</p>
    </div>
  );
}

interface RowProps {
  snag: SnagItem;
  isAdmin: boolean;
  viewer: { id: string; role: string };
  busy: boolean;
  onOpen: () => void;
  onTransition: (next: SnagStatus) => void;
  onOpenReject: () => void;
}

function SnagRow({
  snag,
  isAdmin,
  viewer,
  busy,
  onOpen,
  onTransition,
  onOpenReject,
}: RowProps) {
  const ctx = {
    userId: viewer.id,
    role: viewer.role,
    creatorId: snag.createdById ?? null,
    assignedToId: snag.assignedToId ?? null,
  };

  // Primary action surfaces just the most-relevant next step per status.
  // The drawer holds the rest of the lifecycle controls.
  const primaryAction = ((): { label: string; next: SnagStatus } | null => {
    if (!isAdmin) return null;
    if (snag.status === "open") return { label: "Mark in progress", next: "in_progress" };
    if (snag.status === "in_progress")
      return { label: "Mark resolved", next: "resolved" };
    if (snag.status === "resolved") return { label: "Verify", next: "verified" };
    if (snag.status === "verified") return { label: "Close", next: "closed" };
    return null;
  })();

  const canRejectHere =
    isAdmin &&
    (snag.status === "open" ||
      snag.status === "in_progress" ||
      snag.status === "resolved");

  // Final gate combines machine + role.
  const showPrimary =
    primaryAction != null &&
    canTransition(snag.status, primaryAction.next) &&
    canRoleTransition(snag.status, primaryAction.next, ctx);

  return (
    <tr className={cn("text-sm", busy ? "opacity-70" : "")}>
      <td className="px-3 py-3 align-top">
        <div className="flex flex-col items-start gap-1">
          <Pill tone={STATUS_TONE_MAP[statusTone(snag.status)]}>
            {statusLabel(snag.status)}
          </Pill>
          <Pill tone={PRIORITY_TONE_MAP[priorityTone(snag.priority)]}>
            {priorityLabel(snag.priority)}
          </Pill>
        </div>
      </td>
      <td className="px-3 py-3 align-top">
        <button
          type="button"
          onClick={onOpen}
          className="flex items-start gap-3 text-left hover:underline focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-surface-subtle text-text-muted">
            {snag.evidenceIds.length > 0 ? (
              <ImageIcon aria-hidden="true" className="h-5 w-5" />
            ) : (
              <AlertTriangle aria-hidden="true" className="h-5 w-5" />
            )}
          </span>
          <span className="min-w-0">
            <span className="block max-w-md truncate text-sm font-medium text-text">
              {snag.title}
            </span>
            {snag.description ? (
              <span className="block max-w-md truncate text-xs text-text-muted">
                {snag.description}
              </span>
            ) : null}
            {snag.status === "rejected" && snag.rejectionReason ? (
              <span className="mt-1 block max-w-md truncate text-xs text-rose-700">
                Rejected: {snag.rejectionReason}
              </span>
            ) : null}
          </span>
        </button>
      </td>
      <td className="px-3 py-3 align-top text-sm">
        {formatTarget(snag) === "" ? (
          <Pill tone="neutral">Whole job</Pill>
        ) : (
          <span className="text-text">{formatTarget(snag)}</span>
        )}
      </td>
      <td className="px-3 py-3 align-top text-sm text-text">
        {snag.createdByName}
        {snag.createdByRole ? (
          <span className="ml-1 text-xs text-text-muted">({snag.createdByRole})</span>
        ) : null}
      </td>
      <td className="px-3 py-3 align-top text-sm">
        <time
          dateTime={snag.createdAt}
          title={snag.createdAt}
          className="text-text-muted"
        >
          {formatWhen(snag.createdAt)}
        </time>
      </td>
      {isAdmin ? (
        <td className="px-3 py-3 align-top text-right">
          {showPrimary || canRejectHere ? (
            <div className="flex flex-col items-end gap-2 sm:flex-row sm:justify-end">
              {showPrimary ? (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => onTransition(primaryAction!.next)}
                  disabled={busy}
                  className="bg-brand-navy text-text-inverse hover:bg-accent-ink"
                >
                  {busy ? "…" : primaryAction!.label}
                </Button>
              ) : null}
              {canRejectHere ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={onOpenReject}
                  disabled={busy}
                >
                  Reject
                </Button>
              ) : null}
            </div>
          ) : (
            <span className="text-xs text-text-muted">No actions</span>
          )}
        </td>
      ) : null}
    </tr>
  );
}

function ActionFeedback({ state }: { state: ActionState }) {
  if (state.kind === "success") {
    return (
      <Card className="border-emerald-200 bg-emerald-50" role="status" aria-live="polite">
        <CardDescription className="text-emerald-900">{state.message}</CardDescription>
      </Card>
    );
  }
  if (state.kind === "error") {
    return (
      <Card className="border-rose-200 bg-rose-50" role="alert" aria-live="assertive">
        <CardDescription className="text-rose-900">{state.message}</CardDescription>
      </Card>
    );
  }
  return null;
}

function formatTarget(snag: SnagItem): string {
  const parts: string[] = [];
  if (snag.areaName) parts.push(snag.areaName);
  else if (snag.areaId) parts.push(`Area ${snag.areaId}`);
  if (snag.stage) parts.push(snag.stage === "roughIn" ? "Rough-in" : "Fit-off");
  if (snag.taskName) parts.push(snag.taskName);
  else if (snag.taskId) parts.push(`Task ${snag.taskId}`);
  return parts.join(" · ");
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

function messageForTransition(from: SnagStatus, to: SnagStatus): string {
  if (to === "in_progress" && from === "open") return "Snag picked up.";
  if (to === "resolved") return "Marked resolved. Ready for verification.";
  if (to === "verified") return "Verified — close it once you're satisfied.";
  if (to === "closed") return "Closed. The loop is done.";
  if (to === "rejected") return "Rejected. Worker will see the reason.";
  if (to === "open") return "Re-opened.";
  return "Updated.";
}
