"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, Plus, Printer, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Pill";
import { cn } from "@/lib/cn";
import { saveCircuitSchedule } from "@/domains/circuit-schedule/client";
import {
  CIRCUIT_DEVICES,
  CIRCUIT_STATUSES,
  CIRCUIT_TYPES,
} from "@/domains/circuit-schedule/schema";
import {
  circuitTypeLabel,
  deviceLabel,
  sortByOrder,
  statusLabel,
} from "@/domains/circuit-schedule/format";
import type { Circuit, Switchboard } from "@/domains/circuit-schedule/types";

/**
 * Circuit schedule builder — the editable, mobile-first schedule for a job's
 * distribution boards. Mounted on BOTH surfaces (Phil field + BuhlOS office)
 * so the schedule is filled where the work is and finished where it's issued.
 *
 * Why a card-per-circuit layout rather than a wide table: a real DB schedule
 * is a dense grid, and a grid on an iPhone is a pinch-zoom nightmare. Each
 * circuit is its own block with labelled fields — one-thumb editable, legible
 * at arm's length — and the printable view (CircuitSchedulePrintable) renders
 * the proper tabular schedule for the compliance pack.
 *
 * Writes go through PUT /api/job-circuits (whole-array replace). The endpoint
 * gates the write to canManageJob, so a worker without manage rights gets a
 * read-only view here and the page never offers them a save that 403s.
 *
 * Cross-ref:
 *   src/components/admin/ScopeOfWorkSection.tsx — the add/edit/move list precedent
 *   src/components/circuit-schedule/CircuitSchedulePrintable.tsx — the print view
 *   api/job-circuits.js — GET / PUT handlers + server validation
 */

interface BoardDraft {
  id: string;
  code: string;
  name: string;
  location: string;
}

interface CircuitDraft {
  id: string;
  switchboardId: string;
  number: string;
  description: string;
  type: string;
  device: string;
  rating: string;
  cableSize: string;
  status: string;
  areaId: string;
}

interface Props {
  jobId: string;
  canManage: boolean;
  initialSwitchboards: ReadonlyArray<Switchboard>;
  initialCircuits: ReadonlyArray<Circuit>;
  /** Non-blocking load failure — shown as a banner, edit still works empty. */
  loadError?: string | null;
  /** Where the printable schedule lives (office-issued artefact). */
  printHref: string;
  surface: "phil" | "admin";
}

const inputClass =
  "h-11 w-full rounded-card border border-border bg-surface px-2.5 text-sm text-text placeholder:text-text-muted focus:border-border-strong focus:outline-none focus:ring-2 focus:ring-brand-navy/30";
const selectClass = cn(inputClass, "appearance-none pr-7");
const labelClass =
  "mb-1 block font-display text-[11px] uppercase tracking-wider text-text-muted";

function genId(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 10);
}

function toBoardDrafts(switchboards: ReadonlyArray<Switchboard>): BoardDraft[] {
  return sortByOrder(switchboards.filter((b) => !b.archived)).map((b) => ({
    id: b.id,
    code: b.code ?? "",
    name: b.name ?? "",
    location: b.location ?? "",
  }));
}

function toCircuitDrafts(circuits: ReadonlyArray<Circuit>): CircuitDraft[] {
  return sortByOrder(circuits.filter((c) => !c.archived)).map((c) => ({
    id: c.id,
    switchboardId: c.switchboardId,
    number: c.number ?? "",
    description: c.description ?? "",
    type: c.type || "power",
    device: c.device ?? "",
    rating: c.rating ?? "",
    cableSize: c.cableSize ?? "",
    status: c.status || "planned",
    areaId: c.areaId ?? "",
  }));
}

export function CircuitScheduleBuilder({
  jobId,
  canManage,
  initialSwitchboards,
  initialCircuits,
  loadError,
  printHref,
  surface,
}: Props) {
  const [boards, setBoards] = useState<BoardDraft[]>(() => toBoardDrafts(initialSwitchboards));
  const [circuits, setCircuits] = useState<CircuitDraft[]>(() => toCircuitDrafts(initialCircuits));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const touched = () => {
    setDirty(true);
    setSavedAt(null);
    setError(null);
  };

  // ── Board ops ──────────────────────────────────────────────────────────
  const addBoard = () => {
    setBoards((prev) => [...prev, { id: genId("sb_"), code: "", name: "", location: "" }]);
    touched();
  };
  const patchBoard = (id: string, p: Partial<BoardDraft>) => {
    setBoards((prev) => prev.map((b) => (b.id === id ? { ...b, ...p } : b)));
    touched();
  };
  const removeBoard = (id: string) => {
    setBoards((prev) => prev.filter((b) => b.id !== id));
    setCircuits((prev) => prev.filter((c) => c.switchboardId !== id));
    touched();
  };

  // ── Circuit ops ────────────────────────────────────────────────────────
  const addCircuit = (boardId: string) => {
    setCircuits((prev) => [
      ...prev,
      {
        id: genId("ci_"),
        switchboardId: boardId,
        number: "",
        description: "",
        type: "power",
        device: "",
        rating: "",
        cableSize: "",
        status: "planned",
        areaId: "",
      },
    ]);
    touched();
  };
  const patchCircuit = (id: string, p: Partial<CircuitDraft>) => {
    setCircuits((prev) => prev.map((c) => (c.id === id ? { ...c, ...p } : c)));
    touched();
  };
  const removeCircuit = (id: string) => {
    setCircuits((prev) => prev.filter((c) => c.id !== id));
    touched();
  };
  /** Move a circuit up/down within its own board. */
  const moveCircuit = (boardId: string, id: string, dir: -1 | 1) => {
    setCircuits((prev) => {
      const inBoard = prev.filter((c) => c.switchboardId === boardId);
      const others = prev.filter((c) => c.switchboardId !== boardId);
      const idx = inBoard.findIndex((c) => c.id === id);
      const j = idx + dir;
      if (idx < 0 || j < 0 || j >= inBoard.length) return prev;
      [inBoard[idx], inBoard[j]] = [inBoard[j]!, inBoard[idx]!];
      // Re-stitch: keep the relative order of `others` by re-deriving from the
      // original array isn't necessary — board groups render independently, so
      // a simple concat preserves correctness (sort on save normalises order).
      return [...others, ...inBoard];
    });
    touched();
  };

  const boardCircuits = useMemo(() => {
    const map = new Map<string, CircuitDraft[]>();
    for (const b of boards) map.set(b.id, []);
    for (const c of circuits) {
      const list = map.get(c.switchboardId);
      if (list) list.push(c);
    }
    return map;
  }, [boards, circuits]);

  const boardsValid = boards.every((b) => b.code.trim() !== "");
  const circuitsValid = circuits.every((c) => c.number.trim() !== "");
  const valid = boardsValid && circuitsValid;
  const hasContent = boards.length > 0;

  async function save() {
    setBusy(true);
    setError(null);

    // Assign order: boards in display order; circuits sequentially across the
    // board-ordered flatten so the schedule prints in a stable, sensible order.
    const boardPayload: Switchboard[] = boards.map((b, i) => ({
      id: b.id,
      code: b.code.trim(),
      name: b.name.trim(),
      location: b.location.trim(),
      order: i,
    }));
    let order = 0;
    const circuitPayload: Circuit[] = [];
    for (const b of boards) {
      for (const c of boardCircuits.get(b.id) ?? []) {
        circuitPayload.push({
          id: c.id,
          number: c.number.trim(),
          switchboardId: c.switchboardId,
          type: c.type,
          status: c.status,
          description: c.description.trim(),
          areaId: c.areaId,
          device: c.device,
          rating: c.rating.trim(),
          cableSize: c.cableSize.trim(),
          order: order++,
        });
      }
    }

    const res = await saveCircuitSchedule(jobId, {
      switchboards: boardPayload,
      circuits: circuitPayload,
    });
    setBusy(false);
    if (!res.ok) {
      setError(
        res.error.status === 403
          ? "You don't have edit access to this job's schedule. Ask the office or the leading hand."
          : res.error.message
      );
      return;
    }
    setBoards(toBoardDrafts(res.data.switchboards));
    setCircuits(toCircuitDrafts(res.data.circuits));
    setDirty(false);
    setSavedAt(new Date().toISOString());
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Circuit schedule</CardTitle>
            <CardDescription className="mt-1">
              Build the schedule for each distribution board you&rsquo;ve changed —
              circuit by circuit. Edit on the phone in front of the board; print a
              clean copy for the handover pack.
            </CardDescription>
          </div>
          {hasContent && canManage ? (
            <Link
              href={printHref}
              className="inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-card border border-border bg-surface px-3 text-sm font-medium text-text transition-colors hover:border-border-strong hover:bg-surface-subtle"
              target={surface === "admin" ? undefined : "_blank"}
            >
              <Printer aria-hidden="true" className="h-4 w-4" />
              Print / PDF
            </Link>
          ) : null}
        </div>

        {loadError ? (
          <p
            role="alert"
            className="mt-3 rounded-card border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            Couldn&rsquo;t load the saved schedule ({loadError}). You can still add
            boards below; your save will overwrite once the connection is back.
          </p>
        ) : null}

        {!canManage ? (
          <p className="mt-3 rounded-card border border-border bg-surface-subtle px-3 py-2 text-sm text-text-muted">
            View only — the office or leading hand edits the schedule.
          </p>
        ) : null}
      </Card>

      {boards.length === 0 ? (
        <Card>
          <p className="text-sm text-text-muted">
            No boards on the schedule yet.{" "}
            {canManage
              ? "Add the first distribution board you worked on."
              : "Nothing has been added for this job."}
          </p>
          {canManage ? (
            <div className="mt-3">
              <Button onClick={addBoard} data-testid="circuit-add-board">
                <Plus aria-hidden="true" className="h-4 w-4" />
                Add board
              </Button>
            </div>
          ) : null}
        </Card>
      ) : (
        boards.map((b) => (
          <BoardCard
            key={b.id}
            board={b}
            circuits={boardCircuits.get(b.id) ?? []}
            canManage={canManage}
            onPatchBoard={patchBoard}
            onRemoveBoard={removeBoard}
            onAddCircuit={addCircuit}
            onPatchCircuit={patchCircuit}
            onRemoveCircuit={removeCircuit}
            onMoveCircuit={moveCircuit}
          />
        ))
      )}

      {canManage && boards.length > 0 ? (
        <Button variant="secondary" onClick={addBoard} data-testid="circuit-add-board">
          <Plus aria-hidden="true" className="h-4 w-4" />
          Add another board
        </Button>
      ) : null}

      {canManage ? (
        <div className="sticky bottom-2 z-10">
          <Card className="flex flex-wrap items-center gap-3 border-border-strong shadow-card">
            <Button
              size="lg"
              onClick={save}
              disabled={busy || !dirty || !valid}
              data-testid="circuit-save"
            >
              {busy ? "Saving…" : "Save schedule"}
            </Button>
            {savedAt ? <span className="text-sm text-state-success">Saved.</span> : null}
            {dirty && !savedAt ? (
              <span className="text-sm text-text-muted">Unsaved changes</span>
            ) : null}
            {!valid ? (
              <span className="text-sm text-text-muted">
                {!boardsValid
                  ? "Every board needs a code."
                  : "Every circuit needs a number."}
              </span>
            ) : null}
            {error ? (
              <span role="alert" className="text-sm text-state-danger">
                {error}
              </span>
            ) : null}
          </Card>
        </div>
      ) : null}
    </div>
  );
}

// ── Board card ─────────────────────────────────────────────────────────────
function BoardCard({
  board,
  circuits,
  canManage,
  onPatchBoard,
  onRemoveBoard,
  onAddCircuit,
  onPatchCircuit,
  onRemoveCircuit,
  onMoveCircuit,
}: {
  board: BoardDraft;
  circuits: CircuitDraft[];
  canManage: boolean;
  onPatchBoard: (id: string, p: Partial<BoardDraft>) => void;
  onRemoveBoard: (id: string) => void;
  onAddCircuit: (boardId: string) => void;
  onPatchCircuit: (id: string, p: Partial<CircuitDraft>) => void;
  onRemoveCircuit: (id: string) => void;
  onMoveCircuit: (boardId: string, id: string, dir: -1 | 1) => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  return (
    <Card>
      {canManage ? (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className={labelClass}>Board code *</span>
              <input
                value={board.code}
                onChange={(e) => onPatchBoard(board.id, { code: e.target.value })}
                placeholder="DB1"
                className={inputClass}
                data-testid="board-code"
              />
            </label>
            <label className="block">
              <span className={labelClass}>Name</span>
              <input
                value={board.name}
                onChange={(e) => onPatchBoard(board.id, { name: e.target.value })}
                placeholder="Kitchen board"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Location</span>
              <input
                value={board.location}
                onChange={(e) => onPatchBoard(board.id, { location: e.target.value })}
                placeholder="Plant room, L1"
                className={inputClass}
              />
            </label>
          </div>
        </div>
      ) : (
        <div>
          <CardTitle>{board.code.trim() || "Board"}</CardTitle>
          {(board.name.trim() || board.location.trim()) && (
            <CardDescription className="mt-1">
              {[board.name.trim(), board.location.trim()].filter(Boolean).join(" · ")}
            </CardDescription>
          )}
        </div>
      )}

      <ul className="mt-4 space-y-3">
        {circuits.length === 0 ? (
          <li className="text-sm text-text-muted">No circuits on this board yet.</li>
        ) : (
          circuits.map((c, idx) => (
            <li key={c.id}>
              <CircuitRow
                circuit={c}
                index={idx}
                count={circuits.length}
                canManage={canManage}
                onPatch={onPatchCircuit}
                onRemove={onRemoveCircuit}
                onMove={(dir) => onMoveCircuit(board.id, c.id, dir)}
              />
            </li>
          ))
        )}
      </ul>

      {canManage ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <Button size="sm" variant="secondary" onClick={() => onAddCircuit(board.id)} data-testid="add-circuit">
            <Plus aria-hidden="true" className="h-4 w-4" />
            Add circuit
          </Button>
          {confirmRemove ? (
            <span className="flex items-center gap-2 text-sm">
              <span className="text-text-muted">Remove this board and its circuits?</span>
              <Button size="sm" variant="danger" onClick={() => onRemoveBoard(board.id)}>
                Remove
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmRemove(true)}
              aria-label={`Remove board ${board.code || ""}`}
            >
              <Trash2 aria-hidden="true" className="h-4 w-4" />
              Remove board
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  );
}

// ── Circuit row ────────────────────────────────────────────────────────────
function CircuitRow({
  circuit: c,
  index,
  count,
  canManage,
  onPatch,
  onRemove,
  onMove,
}: {
  circuit: CircuitDraft;
  index: number;
  count: number;
  canManage: boolean;
  onPatch: (id: string, p: Partial<CircuitDraft>) => void;
  onRemove: (id: string) => void;
  onMove: (dir: -1 | 1) => void;
}) {
  if (!canManage) {
    return (
      <div className="rounded-card border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="font-display text-base font-semibold text-text">
            {c.number.trim() || "—"}
          </span>
          <Pill tone="neutral">{statusLabel(c.status)}</Pill>
        </div>
        {c.description.trim() ? (
          <p className="mt-1 text-sm text-text">{c.description.trim()}</p>
        ) : null}
        <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-muted">
          {circuitTypeLabel(c.type) ? <span>{circuitTypeLabel(c.type)}</span> : null}
          {deviceLabel(c.device) ? <span>{deviceLabel(c.device)}</span> : null}
          {c.rating.trim() ? <span>{c.rating.trim()}</span> : null}
          {c.cableSize.trim() ? <span>{c.cableSize.trim()} cable</span> : null}
        </dl>
      </div>
    );
  }

  return (
    <div className="rounded-card border border-border p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="grid gap-3 sm:grid-cols-[7rem_1fr]">
            <label className="block">
              <span className={labelClass}>Circuit no. *</span>
              <input
                value={c.number}
                onChange={(e) => onPatch(c.id, { number: e.target.value })}
                placeholder="C1"
                className={inputClass}
                data-testid="circuit-number"
              />
            </label>
            <label className="block">
              <span className={labelClass}>Description</span>
              <input
                value={c.description}
                onChange={(e) => onPatch(c.id, { description: e.target.value })}
                placeholder="Kitchen GPOs"
                className={inputClass}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <label className="block">
              <span className={labelClass}>Type</span>
              <select
                value={c.type}
                onChange={(e) => onPatch(c.id, { type: e.target.value })}
                className={selectClass}
              >
                {CIRCUIT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {circuitTypeLabel(t)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>Device</span>
              <select
                value={c.device}
                onChange={(e) => onPatch(c.id, { device: e.target.value })}
                className={selectClass}
              >
                <option value="">—</option>
                {CIRCUIT_DEVICES.map((d) => (
                  <option key={d} value={d}>
                    {deviceLabel(d)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>Rating</span>
              <input
                value={c.rating}
                onChange={(e) => onPatch(c.id, { rating: e.target.value })}
                placeholder="20A"
                className={inputClass}
                inputMode="text"
              />
            </label>
            <label className="block">
              <span className={labelClass}>Cable</span>
              <input
                value={c.cableSize}
                onChange={(e) => onPatch(c.id, { cableSize: e.target.value })}
                placeholder="2.5mm²"
                className={inputClass}
                inputMode="text"
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:max-w-xs">
            <label className="block">
              <span className={labelClass}>Status</span>
              <select
                value={c.status}
                onChange={(e) => onPatch(c.id, { status: e.target.value })}
                className={selectClass}
                data-testid="circuit-status"
              >
                {CIRCUIT_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        <div className="flex shrink-0 flex-col gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onMove(-1)}
            disabled={index === 0}
            aria-label="Move circuit up"
          >
            <ChevronUp aria-hidden="true" className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onMove(1)}
            disabled={index === count - 1}
            aria-label="Move circuit down"
          >
            <ChevronDown aria-hidden="true" className="h-4 w-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRemove(c.id)}
            aria-label={`Remove circuit ${c.number || ""}`}
          >
            <Trash2 aria-hidden="true" className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
