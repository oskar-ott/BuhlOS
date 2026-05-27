"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Pill } from "@/components/ui/Pill";
import {
  formatProgress,
  isActive,
  isDone,
  scopeContextLine,
  statusLabel,
  statusTone,
  type ITPStatusTone,
} from "@/domains/itp/format";
import {
  archiveItp,
  reopenItp,
  signOffItp,
} from "@/domains/itp/client";
import { compareForQueue } from "@/domains/itp/service";
import type { ITPInstance } from "@/domains/itp/types";
import type { Job } from "@/domains/jobs/types";
import { resolveScopeName } from "@/components/phil/itp-scope";
import { ITPDrawer } from "./ITPDrawer";
import { ITPSignOffModal } from "./ITPSignOffModal";
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

type FilterMode = "active" | "done" | "all";

interface Props {
  job: Job;
  initialItps: ReadonlyArray<ITPInstance>;
  fetchError: string | null;
  /** True for admin tier; false for LH (read-only — no Sign off / Reopen
   *  / Archive footer or row actions). */
  isAdmin: boolean;
  /** Current viewer — used by canSignOff() to switch the modal between
   *  the simple-confirm and override-justification branches. */
  viewer: { id: string; role: string };
}

type ActionState =
  | { kind: "idle" }
  | { kind: "in_flight"; instanceId: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

/**
 * Phase E1c — admin ITP queue.
 *
 * Server component (page.tsx) does the initial fetch; this client
 * component owns filtering, drawer state, sign-off / reopen / archive
 * mutations. Mirrors SnagsQueue shape so admin muscle memory is identical
 * across the two surfaces (header → filter tabs → table → drawer/modal).
 *
 * Row primary actions per status:
 *   pending     → "No actions"  (worker still recording)
 *   in-progress → "No actions"
 *   witnessed   → "Sign off"    (opens ITPSignOffModal)
 *   signed-off  → "Reopen"      (direct POST)
 *
 * Archive lives in the drawer footer (inline confirm) — same pattern
 * as snag re-open via drawer-only.
 *
 * RSC manifest rule (doc 24 D-26): this file lives in
 * src/components/admin/, NOT under src/app/v2/jobs/[jobId]/itps/.
 *
 * Cross-ref:
 *   src/components/admin/SnagsQueue.tsx — pattern precedent
 *   src/domains/itp/client.ts — signOffItp / reopenItp / archiveItp
 *   docs/rebuild-audit/32-phase-e-plan.md §7
 *   docs/rebuild-audit/33-phase-e-build-prompts.md §E1c
 */
export function ITPsQueue({
  job,
  initialItps,
  fetchError,
  isAdmin,
  viewer,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  const [items, setItems] = useState<ReadonlyArray<ITPInstance>>(initialItps);
  const [filter, setFilter] = useState<FilterMode>("active");
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [signOffId, setSignOffId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });

  // Default filter hides archived globally — the "all" filter brings
  // them back so admins can audit historical archives.
  const visible = useMemo(() => {
    const filtered = items.filter((i) => {
      if (filter === "active") return !i.archived && isActive(i.status);
      if (filter === "done") return !i.archived && isDone(i.status);
      return true;
    });
    return filtered.slice().sort(compareForQueue);
  }, [items, filter]);

  const counts = useMemo(() => {
    let active = 0;
    let done = 0;
    for (const i of items) {
      if (i.archived) continue;
      if (isActive(i.status)) active += 1;
      else if (isDone(i.status)) done += 1;
    }
    return { active, done, all: items.length };
  }, [items]);

  const drawerItem = useMemo(
    () => items.find((i) => i.id === drawerId) ?? null,
    [items, drawerId],
  );
  const signOffItem = useMemo(
    () => items.find((i) => i.id === signOffId) ?? null,
    [items, signOffId],
  );

  const applyServer = useCallback((next: ITPInstance) => {
    setItems((prev) => prev.map((i) => (i.id === next.id ? next : i)));
  }, []);

  const removeFromList = useCallback((id: string) => {
    // Archive returns { ok: true } not { instance }, so we apply the
    // archived flag locally to keep the UI consistent with the server.
    setItems((prev) =>
      prev.map((i) =>
        i.id === id ? { ...i, archived: true, updatedAt: new Date().toISOString() } : i,
      ),
    );
  }, []);

  const surfaceError = useCallback((status: number, fallback: string) => {
    setAction({
      kind: "error",
      message:
        status === 403
          ? "You can't perform that action on this ITP."
          : status === 409
            ? "Couldn't update — the ITP may have changed since you loaded the page."
            : status === 400
              ? fallback || "Invalid request."
              : fallback || "Couldn't update the ITP. Try again.",
    });
  }, []);

  const runSignOff = useCallback(
    async (instance: ITPInstance, overrideJustification: string | null) => {
      setAction({ kind: "in_flight", instanceId: instance.id });
      const r = await signOffItp(job.id, {
        instanceId: instance.id,
        ...(overrideJustification
          ? { overrideJustification }
          : {}),
      });
      if (r.ok) {
        applyServer(r.data.instance);
        setAction({ kind: "success", message: "Signed off." });
        setSignOffId(null);
        startTransition(() => router.refresh());
      } else {
        surfaceError(r.error.status, r.error.message);
      }
    },
    [job.id, applyServer, router, surfaceError],
  );

  const runReopen = useCallback(
    async (instance: ITPInstance) => {
      setAction({ kind: "in_flight", instanceId: instance.id });
      const r = await reopenItp(job.id, { instanceId: instance.id });
      if (r.ok) {
        applyServer(r.data.instance);
        setAction({ kind: "success", message: "Reopened." });
        startTransition(() => router.refresh());
      } else {
        surfaceError(r.error.status, r.error.message);
      }
    },
    [job.id, applyServer, router, surfaceError],
  );

  const runArchive = useCallback(
    async (instance: ITPInstance) => {
      setAction({ kind: "in_flight", instanceId: instance.id });
      const r = await archiveItp(job.id, { instanceId: instance.id });
      if (r.ok) {
        removeFromList(instance.id);
        setAction({ kind: "success", message: "Archived." });
        setDrawerId(null);
        startTransition(() => router.refresh());
      } else {
        surfaceError(r.error.status, r.error.message);
      }
    },
    [job.id, removeFromList, router, surfaceError],
  );

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <CardTitle>ITPs · {job.name}</CardTitle>
            <CardDescription className="mt-1">
              Inspection &amp; test plans on this job. Sign off witnessed
              instances or reopen ones that need rework.
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
              ? "No ITPs attached to this job yet."
              : filter === "active"
                ? "No active ITPs. Either everything's signed off or nothing's been attached."
                : "Nothing matches this filter."
          }
          description={
            items.length === 0
              ? "Attach an ITP template from the legacy /admin/itp page to get started."
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
                  ITP
                </th>
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  Scope
                </th>
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  Progress
                </th>
                <th className="px-3 py-2.5 font-display text-xs uppercase tracking-wider text-text-muted">
                  Attached by
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
              {visible.map((i) => (
                <ITPRow
                  key={i.id}
                  job={job}
                  instance={i}
                  isAdmin={isAdmin}
                  busy={
                    action.kind === "in_flight" && action.instanceId === i.id
                  }
                  onOpen={() => setDrawerId(i.id)}
                  onSignOff={() => setSignOffId(i.id)}
                  onReopen={() => runReopen(i)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ITPDrawer
        job={job}
        instance={drawerItem}
        open={drawerItem !== null}
        isAdmin={isAdmin}
        viewer={viewer}
        busy={
          drawerItem
            ? (action.kind === "in_flight" &&
                action.instanceId === drawerItem.id) ||
              signOffId === drawerItem.id
            : false
        }
        onClose={() => setDrawerId(null)}
        onSignOff={() => {
          if (drawerItem) setSignOffId(drawerItem.id);
        }}
        onReopen={() => {
          if (drawerItem) runReopen(drawerItem);
        }}
        onArchive={() => {
          if (drawerItem) runArchive(drawerItem);
        }}
      />

      <ITPSignOffModal
        open={signOffItem !== null}
        instance={signOffItem}
        viewer={viewer}
        busy={
          signOffItem
            ? action.kind === "in_flight" &&
              action.instanceId === signOffItem.id
            : false
        }
        onClose={() => setSignOffId(null)}
        onSubmit={(justification) => {
          if (signOffItem) runSignOff(signOffItem, justification);
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
    { key: "done", label: "Signed off", count: counts.done },
    { key: "all", label: "All", count: counts.all },
  ];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div role="tablist" aria-label="Filter ITPs" className="flex gap-2">
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
                : "border-border bg-surface text-text hover:bg-surface-subtle",
            )}
          >
            {b.label}
            <span
              className={cn(
                "ml-2 inline-flex h-5 min-w-[20px] items-center justify-center rounded-pill px-1.5 text-[11px]",
                value === b.key
                  ? "bg-accent-yellow text-brand-navy"
                  : "bg-surface-subtle text-text-muted",
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
  job: Job;
  instance: ITPInstance;
  isAdmin: boolean;
  busy: boolean;
  onOpen: () => void;
  onSignOff: () => void;
  onReopen: () => void;
}

function ITPRow({
  job,
  instance,
  isAdmin,
  busy,
  onOpen,
  onSignOff,
  onReopen,
}: RowProps) {
  const progress = formatProgress(instance);
  const scopeName = resolveScopeName(job, instance);
  const scopeLine = scopeContextLine(instance.scope, scopeName);
  const templateName =
    instance.templateSnapshot?.name?.trim() || "Untitled ITP";

  // Primary admin action surfaces the most-relevant next step per status.
  // Pending + in-progress have no admin action — the worker is still
  // recording. Witnessed is the canonical sign-off cue. Signed-off
  // exposes Reopen.
  const adminPrimary = ((): { label: string; onClick: () => void } | null => {
    if (!isAdmin || instance.archived) return null;
    if (instance.status === "witnessed") {
      return { label: "Sign off", onClick: onSignOff };
    }
    if (instance.status === "signed-off") {
      return { label: "Reopen", onClick: onReopen };
    }
    return null;
  })();

  return (
    <tr className={cn("text-sm", busy ? "opacity-70" : "")}>
      <td className="px-3 py-3 align-top">
        <Pill tone={STATUS_TONE_MAP[statusTone(instance.status)]}>
          {statusLabel(instance.status)}
        </Pill>
        {instance.archived ? (
          <span className="mt-1 block">
            <Pill tone="neutral">Archived</Pill>
          </span>
        ) : null}
      </td>
      <td className="px-3 py-3 align-top">
        <button
          type="button"
          onClick={onOpen}
          className="flex items-start gap-3 text-left hover:underline focus:outline-none focus:ring-2 focus:ring-brand-navy"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-surface-subtle text-text-muted">
            <ClipboardCheck aria-hidden="true" className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="block max-w-md truncate text-sm font-medium text-text">
              {templateName}
            </span>
            {instance.templateSnapshot?.category ? (
              <span className="block max-w-md truncate text-xs text-text-muted">
                {instance.templateSnapshot.category}
              </span>
            ) : null}
          </span>
        </button>
      </td>
      <td className="px-3 py-3 align-top text-sm text-text">{scopeLine}</td>
      <td className="px-3 py-3 align-top text-sm text-text-muted">
        {progress.done} / {progress.total}
      </td>
      <td className="px-3 py-3 align-top text-sm text-text">
        {instance.createdBy || "—"}
      </td>
      <td className="px-3 py-3 align-top text-sm">
        <time
          dateTime={instance.updatedAt}
          title={instance.updatedAt}
          className="text-text-muted"
        >
          {formatWhen(instance.updatedAt)}
        </time>
      </td>
      {isAdmin ? (
        <td className="px-3 py-3 align-top text-right">
          {adminPrimary ? (
            <Button
              size="sm"
              variant="primary"
              onClick={adminPrimary.onClick}
              disabled={busy}
              className="bg-brand-navy text-text-inverse hover:bg-accent-ink"
            >
              {busy ? "…" : adminPrimary.label}
            </Button>
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
      <Card
        className="border-emerald-200 bg-emerald-50"
        role="status"
        aria-live="polite"
      >
        <CardDescription className="text-emerald-900">
          {state.message}
        </CardDescription>
      </Card>
    );
  }
  if (state.kind === "error") {
    return (
      <Card
        className="border-rose-200 bg-rose-50"
        role="alert"
        aria-live="assertive"
      >
        <CardDescription className="text-rose-900">
          {state.message}
        </CardDescription>
      </Card>
    );
  }
  return null;
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
