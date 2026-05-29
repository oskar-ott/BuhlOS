"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Inbox,
  MapPin,
  Paperclip,
  UserCheck,
} from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { StatusChip } from "@/components/ui/StatusChip";
import { Button } from "@/components/ui/Button";
import { Drawer } from "@/components/ui/Drawer";
import { EmptyState } from "@/components/ui/EmptyState";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { relativeWhen } from "@/domains/jobs/format";
import { observationsClient } from "@/domains/observations/client";
import {
  compareForInbox,
  isOpenObservation,
  summariseInbox,
} from "@/domains/observations/service";
import {
  convertTargetLabel,
  priorityLabel,
  priorityTone,
  sourceLabel,
  statusLabel,
  statusTone,
  typeLabel,
} from "@/domains/observations/format";
import {
  OBSERVATION_PRIORITIES,
  OBSERVATION_STATUSES,
  OBSERVATION_TYPES,
} from "@/domains/observations/schema";
import type {
  ObservationConvertTarget,
  ObservationItem,
  ObservationPriority,
  ObservationStatus,
  ObservationType,
  UpdateObservationPayload,
} from "@/domains/observations/types";

interface Props {
  initialObservations: ReadonlyArray<ObservationItem>;
  fetchError: string | null;
  viewer: { id: string; name: string; role: string };
  /** PR 8: when false, hide the triage/priority/resolve/convert sections — the
   *  viewer can SEE observations but not act on them (e.g. a leading hand on a
   *  job-scoped view; only admin-tier can mutate per the API gate). Default true
   *  for the cross-job /observations inbox which is admin-tier-gated at middleware. */
  actionsEnabled?: boolean;
  /** Show the "Job" filter dropdown. Off for the job-scoped view (only one job
   *  appears so the dropdown adds nothing). Default true. */
  showJobFilter?: boolean;
}

interface Filters {
  status: ObservationStatus | "";
  type: ObservationType | "";
  priority: ObservationPriority | "";
  jobId: string;
  source: string;
}

const EMPTY_FILTERS: Filters = { status: "", type: "", priority: "", jobId: "", source: "" };

/** Intent-only conversion targets — the downstream modules (RFI / Variation /
 *  Material Request) aren't built yet, so these buttons record the office
 *  decision and move the row to "Converted" with an honest "module coming"
 *  label. The Snag conversion is REAL (PR 6) and has its own button + handler.
 *  `defect` is intentionally not here — it overlaps with the real Snag target.
 */
const INTENT_CONVERT_OPTIONS: ReadonlyArray<ObservationConvertTarget> = [
  "rfi",
  "variation",
  "material_request",
];

/** Types that auto-promote to a Snag without a force flag (mirror of
 *  CONVERT_TO_SNAG_DEFAULT_TYPES in api/observations.js). */
const SNAG_ELIGIBLE_TYPES = new Set(["defect", "safety", "blocker"]);

/**
 * BuhlOS Observations Inbox — the office triage surface for field-to-office
 * site truth captured in Phil (and BuhlOS). Exception-first: needs-action and
 * high/urgent rows sit at the top so the owner clears the loudest items first,
 * not a raw table dump.
 *
 * Server fetches the cross-job list; this client owns filtering + the triage
 * mutations (status, priority, assign-to-me, resolution note, conversion
 * intent) via PATCH /api/observations.
 */
export function ObservationsInbox({
  initialObservations,
  fetchError,
  viewer,
  actionsEnabled = true,
  showJobFilter = true,
}: Props) {
  const [observations, setObservations] = useState<ReadonlyArray<ObservationItem>>(
    initialObservations
  );
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<{ tone: "success" | "danger"; message: string } | null>(
    null
  );
  const [resolutionNote, setResolutionNote] = useState("");

  const summary = useMemo(() => summariseInbox(observations), [observations]);

  const jobOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of observations) {
      if (!map.has(o.jobId)) map.set(o.jobId, o.jobName || o.jobId);
    }
    return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
  }, [observations]);

  const visible = useMemo(() => {
    const matched = observations.filter((o) => {
      if (filters.status && o.status !== filters.status) return false;
      if (filters.type && o.type !== filters.type) return false;
      if (filters.priority && o.priority !== filters.priority) return false;
      if (filters.jobId && o.jobId !== filters.jobId) return false;
      if (filters.source && o.source !== filters.source) return false;
      return true;
    });
    return matched.slice().sort(compareForInbox);
  }, [observations, filters]);

  const selected = useMemo(
    () => observations.find((o) => o.id === selectedId) ?? null,
    [observations, selectedId]
  );

  const filtersActive = Object.values(filters).some((v) => v !== "");

  async function apply(id: string, patch: Omit<UpdateObservationPayload, "id">) {
    setBusy(true);
    setBanner(null);
    const r = await observationsClient.updateObservation({ id, ...patch });
    setBusy(false);
    if (!r.ok) {
      setBanner({
        tone: "danger",
        message:
          r.error.status === 0
            ? "Couldn't reach the server. Check your connection and try again."
            : `Update failed (${r.error.status}).`,
      });
      return;
    }
    const updated = r.data.observation;
    setObservations((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
    setBanner({ tone: "success", message: "Updated." });
  }

  /** PR 6: real Snag conversion. Calls POST /api/observations?action=convert-to-snag
   *  which creates a Snag on the job and links it back; the response is the
   *  updated observation (with linkedSnagId + status='converted') + the snag. */
  async function convertToSnag(id: string, force = false) {
    setBusy(true);
    setBanner(null);
    const r = await observationsClient.convertObservationToSnag({ id, force });
    setBusy(false);
    if (!r.ok) {
      const conflictAlready = r.error.status === 409;
      setBanner({
        tone: "danger",
        message: conflictAlready
          ? "Already converted to a snag."
          : r.error.status === 0
            ? "Couldn't reach the server. Check your connection and try again."
            : `Convert to Snag failed (${r.error.status}).`,
      });
      return;
    }
    const updated = r.data.observation;
    setObservations((prev) => prev.map((o) => (o.id === updated.id ? updated : o)));
    setBanner({
      tone: "success",
      message: `Converted — snag created on ${updated.jobName || updated.jobId}.`,
    });
  }

  return (
    <div className="space-y-5">
      {fetchError ? (
        <Card className="border-amber-200 bg-amber-50" role="alert">
          <CardTitle>Couldn&rsquo;t load observations</CardTitle>
          <CardDescription className="text-amber-900">
            {fetchError}. The list may be incomplete.
          </CardDescription>
          <div className="mt-3">
            <RefreshButton />
          </div>
        </Card>
      ) : null}

      {banner ? (
        <div
          role="status"
          className={
            banner.tone === "success"
              ? "rounded-card border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
              : "rounded-card border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900"
          }
        >
          {banner.message}
        </div>
      ) : null}

      {/* Summary cards — exception-first vitals. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label="New / needs action" value={summary.newOrNeedsAction} icon={Inbox} tone="warning" />
        <SummaryCard label="High / urgent" value={summary.highUrgent} icon={AlertTriangle} tone="danger" />
        <SummaryCard label="Blockers" value={summary.blockers} icon={AlertTriangle} tone="danger" />
        <SummaryCard label="Resolved / record only" value={summary.resolvedOrRecord} icon={CheckCircle2} tone="success" />
      </div>

      {/* Filters. */}
      <div className="flex flex-wrap items-end gap-2 rounded-card border border-border bg-surface p-3">
        <FilterSelect
          label="Status"
          value={filters.status}
          onChange={(v) => setFilters((f) => ({ ...f, status: v as ObservationStatus | "" }))}
          options={OBSERVATION_STATUSES.map((s) => ({ value: s, label: statusLabel(s) }))}
        />
        <FilterSelect
          label="Type"
          value={filters.type}
          onChange={(v) => setFilters((f) => ({ ...f, type: v as ObservationType | "" }))}
          options={OBSERVATION_TYPES.map((t) => ({ value: t, label: typeLabel(t) }))}
        />
        <FilterSelect
          label="Priority"
          value={filters.priority}
          onChange={(v) => setFilters((f) => ({ ...f, priority: v as ObservationPriority | "" }))}
          options={OBSERVATION_PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))}
        />
        {showJobFilter ? (
          <FilterSelect
            label="Job"
            value={filters.jobId}
            onChange={(v) => setFilters((f) => ({ ...f, jobId: v }))}
            options={jobOptions.map((j) => ({ value: j.id, label: j.name }))}
          />
        ) : null}
        <FilterSelect
          label="Source"
          value={filters.source}
          onChange={(v) => setFilters((f) => ({ ...f, source: v }))}
          options={[
            { value: "phil", label: "Phil (field)" },
            { value: "buhlos", label: "BuhlOS (office)" },
            { value: "system", label: "System" },
          ]}
        />
        {filtersActive ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
            Clear
          </Button>
        ) : null}
        <span className="ml-auto self-center text-xs text-text-muted">
          {visible.length} of {observations.length}
        </span>
      </div>

      {/* List. */}
      {observations.length === 0 && !fetchError ? (
        <EmptyState
          title="No observations yet"
          description="Field observations from Phil land here — blockers, plan mismatches, material needs, questions, variations, defects and site instructions. Workers capture them from the Capture button; you triage, assign and resolve them here."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title="Nothing matches these filters"
          description="Try clearing a filter to see more."
          action={
            <Button type="button" variant="secondary" size="sm" onClick={() => setFilters(EMPTY_FILTERS)}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <ul className="space-y-2">
          {visible.map((o) => (
            <li key={o.id}>
              <ObservationRow observation={o} onOpen={() => setSelectedId(o.id)} />
            </li>
          ))}
        </ul>
      )}

      <ObservationDrawer
        observation={selected}
        viewer={viewer}
        busy={busy}
        actionsEnabled={actionsEnabled}
        resolutionNote={resolutionNote}
        onResolutionNoteChange={setResolutionNote}
        onClose={() => {
          setSelectedId(null);
          setResolutionNote("");
        }}
        onApply={apply}
        onConvertToSnag={convertToSnag}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string;
  value: number;
  icon: typeof Inbox;
  tone: "warning" | "danger" | "success";
}) {
  const toneClass =
    value === 0
      ? "text-text-muted"
      : tone === "danger"
        ? "text-rose-700"
        : tone === "warning"
          ? "text-amber-700"
          : "text-emerald-700";
  return (
    <Card className="flex items-center justify-between gap-2">
      <div>
        <p className="text-xs uppercase tracking-wider text-text-muted">{label}</p>
        <p className={`mt-1 font-display text-2xl ${toneClass}`}>{value}</p>
      </div>
      <Icon aria-hidden="true" className={`h-5 w-5 shrink-0 ${toneClass}`} />
    </Card>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-text-muted">
      <span className="uppercase tracking-wider">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-[8rem] rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ObservationRow({
  observation: o,
  onOpen,
}: {
  observation: ObservationItem;
  onOpen: () => void;
}) {
  const open = isOpenObservation(o.status);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1.5 rounded-card border border-border bg-surface p-3 text-left transition-colors hover:bg-surface-subtle"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone="navy" dot={false}>
          {typeLabel(o.type)}
        </StatusChip>
        <StatusChip tone={statusTone(o.status)}>{statusLabel(o.status)}</StatusChip>
        {o.priority !== "normal" && o.priority !== "low" ? (
          <StatusChip tone={priorityTone(o.priority)}>{priorityLabel(o.priority)}</StatusChip>
        ) : null}
        {open && o.requiresAction ? (
          <StatusChip tone="warning" dot={false}>
            Action
          </StatusChip>
        ) : null}
        {o.linkedEvidenceId || o.photoUrls.length > 0 ? (
          <Paperclip aria-hidden="true" className="h-3.5 w-3.5 text-text-muted" />
        ) : null}
      </div>
      <p className="font-display text-sm font-semibold text-text">{o.title}</p>
      {o.description ? (
        <p className="line-clamp-1 text-sm text-text-muted">{o.description}</p>
      ) : null}
      <p className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
        <span className="font-medium text-text">{o.jobName || o.jobId}</span>
        {o.areaName ? (
          <span className="inline-flex items-center gap-0.5">
            <MapPin aria-hidden="true" className="h-3 w-3" />
            {o.areaName}
          </span>
        ) : null}
        <span aria-hidden="true">·</span>
        <span>{o.createdByName}</span>
        <span aria-hidden="true">·</span>
        <span>{relativeWhen(o.createdAt)}</span>
        <span aria-hidden="true">·</span>
        <span>{sourceLabel(o.source)}</span>
      </p>
    </button>
  );
}

function ObservationDrawer({
  observation: o,
  viewer,
  busy,
  resolutionNote,
  onResolutionNoteChange,
  onClose,
  onApply,
  onConvertToSnag,
  actionsEnabled,
}: {
  observation: ObservationItem | null;
  viewer: { id: string; name: string; role: string };
  busy: boolean;
  resolutionNote: string;
  onResolutionNoteChange: (v: string) => void;
  onClose: () => void;
  onApply: (id: string, patch: Omit<UpdateObservationPayload, "id">) => void;
  onConvertToSnag: (id: string, force?: boolean) => void;
  /** PR 8: when false, render only the read-only details (no triage / priority /
   *  resolve / convert sections). */
  actionsEnabled: boolean;
}) {
  if (!o) return null;
  const assignedToMe = o.assignedToId === viewer.id;
  const STATUS_ACTIONS: ReadonlyArray<{ status: ObservationStatus; label: string }> = [
    { status: "needs_action", label: "Needs action" },
    { status: "in_review", label: "In review" },
    { status: "record_only", label: "Record only" },
  ];

  return (
    <Drawer
      open={!!o}
      onClose={onClose}
      title={o.title}
      subtitle={`${typeLabel(o.type)} · ${o.jobName || o.jobId}`}
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-text-muted">
            {busy ? "Saving…" : `Created ${relativeWhen(o.createdAt)}`}
          </span>
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip tone={statusTone(o.status)}>{statusLabel(o.status)}</StatusChip>
          <StatusChip tone={priorityTone(o.priority)}>{priorityLabel(o.priority)}</StatusChip>
          {o.requiresAction ? (
            <StatusChip tone="warning" dot={false}>
              Needs action
            </StatusChip>
          ) : null}
        </div>

        {o.description ? (
          <p className="whitespace-pre-wrap text-sm text-text">{o.description}</p>
        ) : (
          <p className="text-sm italic text-text-muted">No description.</p>
        )}

        <dl className="space-y-1.5 text-sm">
          <DetailRow label="Job" value={o.jobName || o.jobId} />
          {o.areaName ? <DetailRow label="Area" value={o.areaName} /> : null}
          {o.stage ? <DetailRow label="Stage" value={o.stage === "roughIn" ? "Rough-in" : "Fit-off"} /> : null}
          {o.taskName ? <DetailRow label="Task" value={o.taskName} /> : null}
          <DetailRow label="Raised by" value={`${o.createdByName}${o.createdByRole ? ` (${o.createdByRole})` : ""}`} />
          <DetailRow label="Source" value={sourceLabel(o.source)} />
          {o.assignedToName ? <DetailRow label="Assigned" value={o.assignedToName} /> : null}
          {o.linkedEvidenceId ? <DetailRow label="Linked evidence" value={o.linkedEvidenceId} /> : null}
          {o.linkedSnagId ? (
            <div className="flex gap-2">
              <dt className="w-28 shrink-0 text-text-muted">Linked snag</dt>
              <dd className="min-w-0 flex-1 text-text">
                <Link
                  href={`/v2/jobs/${o.jobId}/snags` as Route}
                  className="underline decoration-accent-yellow decoration-2 underline-offset-2"
                >
                  {o.linkedSnagId} →
                </Link>
              </dd>
            </div>
          ) : null}
          {o.photoUrls.length > 0 ? <DetailRow label="Photos" value={`${o.photoUrls.length} attached`} /> : null}
          {o.resolutionNote ? <DetailRow label="Resolution" value={o.resolutionNote} /> : null}
          {o.convertedTo ? (
            <DetailRow label="Converted to" value={`${convertTargetLabel(o.convertedTo)} — module coming`} />
          ) : null}
        </dl>

        {!actionsEnabled ? (
          <p className="rounded-card border border-dashed border-border bg-surface-subtle px-3 py-2 text-xs text-text-muted">
            Read-only view. Triage and conversion live on the
            <Link
              href={"/observations" as Route}
              className="ml-1 underline decoration-accent-yellow decoration-2 underline-offset-2"
            >
              Observations inbox
            </Link>
            {" "}(admin-only).
          </p>
        ) : null}

        {actionsEnabled ? (
        <>
        {/* Triage actions */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">Triage</h3>
          <div className="flex flex-wrap gap-2">
            {STATUS_ACTIONS.map((a) => (
              <Button
                key={a.status}
                type="button"
                size="sm"
                variant={o.status === a.status ? "primary" : "secondary"}
                disabled={busy || o.status === a.status}
                onClick={() => onApply(o.id, { status: a.status })}
              >
                {a.label}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant={assignedToMe ? "primary" : "secondary"}
              disabled={busy}
              onClick={() =>
                onApply(o.id, { assignedToId: assignedToMe ? null : viewer.id })
              }
            >
              <UserCheck aria-hidden="true" className="h-4 w-4" />
              {assignedToMe ? "Unassign me" : "Assign to me"}
            </Button>
          </div>
        </section>

        {/* Priority */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">Priority</h3>
          <div className="flex flex-wrap gap-2">
            {OBSERVATION_PRIORITIES.map((p) => (
              <Button
                key={p}
                type="button"
                size="sm"
                variant={o.priority === p ? "primary" : "secondary"}
                disabled={busy || o.priority === p}
                onClick={() => onApply(o.id, { priority: p })}
              >
                {priorityLabel(p)}
              </Button>
            ))}
          </div>
        </section>

        {/* Resolve */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">Resolve</h3>
          <textarea
            value={resolutionNote}
            onChange={(e) => onResolutionNoteChange(e.target.value)}
            placeholder="Optional resolution note (what was done / decided)…"
            rows={2}
            className="w-full rounded-card border border-border bg-surface px-2 py-1.5 text-sm text-text"
          />
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={busy || o.status === "resolved"}
            onClick={() =>
              onApply(o.id, {
                status: "resolved",
                ...(resolutionNote.trim() ? { resolutionNote: resolutionNote.trim() } : {}),
              })
            }
          >
            <CheckCircle2 aria-hidden="true" className="h-4 w-4" />
            Mark resolved
          </Button>
        </section>

        {/* Convert to Snag — REAL (PR 6) */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Convert to Snag
          </h3>
          {o.linkedSnagId ? (
            <p className="text-xs text-text-muted">
              Already linked to a snag — see the Linked snag row above.
            </p>
          ) : SNAG_ELIGIBLE_TYPES.has(o.type) ? (
            <>
              <p className="text-xs text-text-muted">
                Creates a real Snag on this job (status <em>open</em>), links it back to this
                observation, and moves it to <em>Converted</em>. The snag follows the normal
                open → in_progress → resolved → verified → closed workflow.
              </p>
              <Button
                type="button"
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => onConvertToSnag(o.id, false)}
              >
                <ArrowRightLeft aria-hidden="true" className="h-4 w-4" />
                Create snag from this observation
              </Button>
            </>
          ) : (
            <>
              <p className="text-xs text-text-muted">
                This is a <em>{typeLabel(o.type).toLowerCase()}</em> — not a default Snag target
                (the Snag workflow fits <em>defect / safety / blocker</em>). Force-convert anyway
                if you've decided to track it as a Snag.
              </p>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => onConvertToSnag(o.id, true)}
              >
                <ArrowRightLeft aria-hidden="true" className="h-4 w-4" />
                Force-convert to Snag
              </Button>
            </>
          )}
        </section>

        {/* Record other conversion intent — RFI / Variation / Material Request modules are
            still UC. These buttons record the office decision honestly. */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-text-muted">
            Record other intent
          </h3>
          <p className="text-xs text-text-muted">
            Moves this to <em>Converted</em> with an intent tag. The RFI / Variation / Material
            Request modules are coming next — no downstream record is created yet.
          </p>
          <div className="flex flex-wrap gap-2">
            {INTENT_CONVERT_OPTIONS.map((t) => (
              <Button
                key={t}
                type="button"
                size="sm"
                variant={o.convertedTo === t ? "primary" : "ghost"}
                disabled={busy || o.convertedTo === t || !!o.linkedSnagId}
                onClick={() => onApply(o.id, { convertedTo: t })}
              >
                <ArrowRightLeft aria-hidden="true" className="h-4 w-4" />
                {convertTargetLabel(t)}
              </Button>
            ))}
          </div>
        </section>
        </>
        ) : null}
      </div>
    </Drawer>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-28 shrink-0 text-text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-text">{value}</dd>
    </div>
  );
}
