"use client";

import { useMemo, useState } from "react";
import { Check, Eye, EyeOff, Pencil, X } from "lucide-react";
import { CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import {
  SCHEDULE_COLUMN_LABELS,
  SCHEDULE_KIND_LABELS,
  type ScheduleRow,
  type ScheduleTable,
} from "@/domains/ai-drawings/schema";
import { reviewScheduleRow } from "@/domains/ai-drawings/client";
import { cropRegionFromPng, padRegion } from "@/domains/ai-drawings/crop";

/**
 * Epic 5 (#202/#207) — schedule verification: extracted rows side-by-side
 * with the source image region.
 *
 * Every cell renders the AI's verbatim read with its confidence; corrections
 * win and are marked; null cells show "—" (flagged, never invented). The
 * accuracy line counts corrected cells openly — errors are measured, not
 * hidden (issue AC). Row review: accept / edit / reject; a re-extraction
 * supersedes the whole table (rows have no stable cross-run identity), so
 * the card states when a table has reviewed rows.
 */

const LOW_CONFIDENCE = 0.7;

interface SourcePlanLookup {
  pngUrlFor: (planId: string, pageIndex: number) => string | null;
  labelFor: (planId: string) => string;
}

export function ScheduleTablesCard({
  jobId,
  tables,
  rows,
  columns,
  lookup,
  onRow,
}: {
  jobId: string;
  tables: ScheduleTable[];
  rows: ScheduleRow[];
  columns: Record<string, string[]>;
  lookup: SourcePlanLookup;
  onRow: (row: ScheduleRow) => void;
}) {
  const rowsByTable = useMemo(() => {
    const m = new Map<string, ScheduleRow[]>();
    for (const r of rows) {
      const list = m.get(r.tableId) ?? [];
      list.push(r);
      m.set(r.tableId, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.rowIndex - b.rowIndex);
    return m;
  }, [rows]);

  // #207: multi-page board schedules stitch AT READ TIME — same-board tables
  // render adjacently, each annotated "part i of n". Honest about the seams:
  // each part keeps its own source page and row strips.
  const orderedTables = useMemo(() => {
    const boardCounts = new Map<string, number>();
    for (const t of tables) {
      if (t.tableKind === "switchboard" && t.boardIdentifier) {
        const k = t.boardIdentifier.toLowerCase();
        boardCounts.set(k, (boardCounts.get(k) ?? 0) + 1);
      }
    }
    const sorted = [...tables].sort((a, b) => {
      if (a.tableKind !== b.tableKind) return a.tableKind.localeCompare(b.tableKind);
      const ab = (a.boardIdentifier ?? "").toLowerCase();
      const bb = (b.boardIdentifier ?? "").toLowerCase();
      if (ab !== bb) return ab.localeCompare(bb);
      if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
      return a.createdAt.localeCompare(b.createdAt);
    });
    const seen = new Map<string, number>();
    return sorted.map((t) => {
      if (t.tableKind === "switchboard" && t.boardIdentifier) {
        const k = t.boardIdentifier.toLowerCase();
        const total = boardCounts.get(k) ?? 1;
        if (total > 1) {
          const part = (seen.get(k) ?? 0) + 1;
          seen.set(k, part);
          return { table: t, partNote: `part ${part} of ${total}` };
        }
      }
      return { table: t, partNote: null };
    });
  }, [tables]);

  return (
    <section
      aria-label="Extracted schedules"
      className="rounded-card border border-border bg-surface"
      data-testid="schedule-tables"
    >
      <div className="border-b border-border px-4 py-3">
        <CardTitle>Extracted schedules</CardTitle>
        <CardDescription className="mt-1">
          Schedule tables read off the drawings — verify each row against the
          source strip, fix cells, accept or reject. Corrections win; every
          fix is counted, not hidden.
        </CardDescription>
      </div>
      <div className="divide-y divide-border">
        {orderedTables.map(({ table: t, partNote }) => (
          <ScheduleTableSection
            key={t.id}
            jobId={jobId}
            table={t}
            partNote={partNote}
            rows={rowsByTable.get(t.id) ?? []}
            canonicalColumns={columns[t.tableKind] ?? []}
            lookup={lookup}
            onRow={onRow}
          />
        ))}
      </div>
    </section>
  );
}

// Column order: canonical columns that actually appear, then extras in
// first-seen order (unmapped raw headers keep their own key).
function columnOrder(rows: ScheduleRow[], canonical: string[]): string[] {
  const present = new Set<string>();
  for (const r of rows) {
    for (const key of Object.keys(r.effective)) present.add(key);
  }
  const ordered = canonical.filter((c) => present.has(c));
  for (const key of present) if (!ordered.includes(key)) ordered.push(key);
  return ordered;
}

function ScheduleTableSection({
  jobId,
  table,
  partNote,
  rows,
  canonicalColumns,
  lookup,
  onRow,
}: {
  jobId: string;
  table: ScheduleTable;
  partNote: string | null;
  rows: ScheduleRow[];
  canonicalColumns: string[];
  lookup: SourcePlanLookup;
  onRow: (row: ScheduleRow) => void;
}) {
  const cols = useMemo(() => columnOrder(rows, canonicalColumns), [rows, canonicalColumns]);
  const pngUrl = lookup.pngUrlFor(table.planId, table.pageIndex);
  const stats = useMemo(() => {
    let reviewed = 0;
    let correctedCells = 0;
    let totalCells = 0;
    for (const r of rows) {
      if (r.status !== "suggested") reviewed += 1;
      totalCells += Object.keys(r.cells).length;
      correctedCells += r.humanCells ? Object.keys(r.humanCells).length : 0;
    }
    return { reviewed, correctedCells, totalCells };
  }, [rows]);

  return (
    <div className="px-4 py-3" data-testid="schedule-table">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-sm font-semibold text-text">
          {SCHEDULE_KIND_LABELS[table.tableKind]}
          {table.boardIdentifier ? ` · ${table.boardIdentifier}` : ""}
          {partNote ? (
            <span className="ml-1.5 text-xs font-normal text-text-muted">({partNote})</span>
          ) : null}
        </span>
        <span className="text-xs text-text-muted">
          {lookup.labelFor(table.planId)} · p{table.pageIndex + 1}
        </span>
        <Pill tone={stats.reviewed === rows.length && rows.length > 0 ? "success" : "neutral"}>
          {stats.reviewed}/{rows.length} rows reviewed
        </Pill>
        <span className="text-xs text-text-muted" data-testid="schedule-accuracy">
          {stats.correctedCells} of {stats.totalCells} cells corrected
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-text-muted">
          The run found this table but no readable rows.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-wider text-text-muted">
                <th className="py-1.5 pr-2 font-medium">#</th>
                {cols.map((c) => (
                  <th key={c} className="py-1.5 pr-3 font-medium">
                    {SCHEDULE_COLUMN_LABELS[c] ?? c}
                  </th>
                ))}
                <th className="py-1.5 pr-2 font-medium">Status</th>
                <th className="py-1.5 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <ScheduleRowView
                  key={r.id}
                  jobId={jobId}
                  row={r}
                  cols={cols}
                  pngUrl={pngUrl}
                  onRow={onRow}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const MAX_SOURCE_STRIP_CHARS = 2_000_000; // display-only data URL

function ScheduleRowView({
  jobId,
  row,
  cols,
  pngUrl,
  onRow,
}: {
  jobId: string;
  row: ScheduleRow;
  cols: string[];
  pngUrl: string | null;
  onRow: (row: ScheduleRow) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // null = hidden; "loading" while cropping; "failed" when the canvas is
  // CORS-tainted (fall back to the page link); else the crop data URL.
  const [source, setSource] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toggleSource = async () => {
    if (source !== null) {
      setSource(null);
      return;
    }
    if (!pngUrl || !row.rowRegion) return;
    setSource("loading");
    const dataUrl = await cropRegionFromPng(
      pngUrl,
      padRegion(row.rowRegion, 0.15),
      MAX_SOURCE_STRIP_CHARS,
      16,
    );
    setSource(dataUrl ?? "failed");
  };

  const act = async (
    status: "accepted" | "edited" | "rejected",
    cells?: Record<string, string | null>,
  ) => {
    setBusy(true);
    setError("");
    try {
      const out = await reviewScheduleRow(jobId, row.id, status, cells ? { cells } : {});
      onRow(out.row);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "review failed");
    } finally {
      setBusy(false);
    }
  };

  const beginEdit = () => {
    const next: Record<string, string> = {};
    for (const c of cols) next[c] = row.effective[c]?.value ?? "";
    setDrafts(next);
    setError("");
    setEditing(true);
  };

  const saveEdit = () => {
    // only send the cells that actually changed from the effective view
    const changed: Record<string, string | null> = {};
    for (const c of cols) {
      const current = row.effective[c]?.value ?? null;
      const draft = drafts[c]?.trim() === "" ? null : (drafts[c]?.trim() ?? null);
      if (draft !== current) changed[c] = draft;
    }
    if (Object.keys(changed).length === 0) {
      setEditing(false);
      return;
    }
    void act("edited", changed);
  };

  const canShowSource = Boolean(pngUrl && row.rowRegion);

  return (
    <>
      <tr
        className={cn(
          "border-b border-border align-top",
          row.status === "rejected" ? "opacity-50" : "",
        )}
        data-testid="schedule-row"
      >
        <td className="py-1.5 pr-2 text-xs text-text-muted">{row.rowIndex + 1}</td>
        {cols.map((c) => {
          const cell = row.effective[c];
          const lowConfidence =
            cell &&
            !cell.corrected &&
            (cell.confidence === null || cell.confidence < LOW_CONFIDENCE);
          return (
            <td key={c} className="py-1.5 pr-3">
              {!editing ? (
                <span
                  className={cn(
                    "break-words",
                    cell?.value === null || cell?.value === undefined
                      ? "text-text-muted"
                      : "text-text",
                    lowConfidence ? "rounded bg-amber-50 px-1 text-amber-900" : "",
                    cell?.corrected ? "underline decoration-sky-400 decoration-2 underline-offset-2" : "",
                  )}
                  title={
                    cell?.corrected
                      ? `corrected — AI read: ${row.cells[c]?.value ?? "—"}`
                      : cell?.confidence !== null && cell?.confidence !== undefined
                        ? `confidence ${Math.round((cell.confidence ?? 0) * 100)}%`
                        : undefined
                  }
                >
                  {cell?.value ?? "—"}
                </span>
              ) : (
                <input
                  value={drafts[c] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [c]: e.target.value }))}
                  aria-label={`${SCHEDULE_COLUMN_LABELS[c] ?? c}, row ${row.rowIndex + 1}`}
                  placeholder="—"
                  maxLength={300}
                  className="h-7 w-full min-w-16 rounded-card border border-border bg-surface px-1.5 text-sm"
                />
              )}
            </td>
          );
        })}
        <td className="py-1.5 pr-2">
          {row.status === "suggested" ? <Pill tone="warning">review</Pill> : null}
          {row.status === "accepted" ? <Pill tone="success">ok</Pill> : null}
          {row.status === "edited" ? <Pill tone="info">fixed</Pill> : null}
          {row.status === "rejected" ? <Pill tone="neutral">rejected</Pill> : null}
        </td>
        <td className="py-1.5">
          <span className="flex items-center gap-1">
            {!editing ? (
              <>
                {row.status !== "rejected" ? (
                  <>
                    {row.status === "suggested" ? (
                      <button
                        type="button"
                        onClick={() => void act("accepted")}
                        disabled={busy}
                        aria-label={`Accept row ${row.rowIndex + 1}`}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-border text-text hover:bg-surface-subtle"
                      >
                        <Check aria-hidden="true" className="h-3.5 w-3.5" />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={beginEdit}
                      disabled={busy}
                      aria-label={`Fix cells in row ${row.rowIndex + 1}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-border text-text hover:bg-surface-subtle"
                    >
                      <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void act("rejected")}
                      disabled={busy}
                      aria-label={`Reject row ${row.rowIndex + 1}`}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-border text-text-muted hover:bg-surface-subtle hover:text-text"
                    >
                      <X aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  </>
                ) : null}
                {canShowSource ? (
                  <button
                    type="button"
                    onClick={() => void toggleSource()}
                    aria-label={`${source !== null ? "Hide" : "Show"} source strip for row ${row.rowIndex + 1}`}
                    aria-expanded={source !== null}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-border text-text-muted hover:bg-surface-subtle hover:text-text"
                  >
                    {source !== null ? (
                      <EyeOff aria-hidden="true" className="h-3.5 w-3.5" />
                    ) : (
                      <Eye aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={busy}
                  aria-label={`Save corrections to row ${row.rowIndex + 1}`}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-brand-navy bg-brand-navy text-text-inverse"
                >
                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  disabled={busy}
                  aria-label={`Cancel corrections to row ${row.rowIndex + 1}`}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-card border border-border bg-surface text-text"
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </>
            )}
          </span>
        </td>
      </tr>
      {source !== null ? (
        <tr className="border-b border-border">
          <td colSpan={cols.length + 3} className="py-1.5">
            {source === "loading" ? (
              <p className="text-xs text-text-muted" role="status">
                Cropping the source strip…
              </p>
            ) : source === "failed" ? (
              <p className="text-xs text-text-muted">
                Couldn&rsquo;t crop the source image in this browser —{" "}
                <a
                  href={pngUrl ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline decoration-dotted underline-offset-2"
                >
                  open the full page instead
                </a>
                .
              </p>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- transient canvas-cropped data URL; next/image adds nothing here
              <img
                src={source}
                alt={`Source image strip for row ${row.rowIndex + 1}`}
                className="max-h-24 w-auto max-w-full rounded-card border border-border"
              />
            )}
          </td>
        </tr>
      ) : null}
      {error ? (
        <tr>
          <td colSpan={cols.length + 3} className="py-1 text-xs text-red-700">
            {error}
          </td>
        </tr>
      ) : null}
    </>
  );
}
