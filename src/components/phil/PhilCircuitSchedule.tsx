"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Pencil, Plus, Zap } from "lucide-react";
import { cn } from "@/lib/cn";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import { PhilActionButton } from "./ui/PhilActionButton";
import { PhilNotice } from "./ui/PhilNotice";
import {
  CIRCUIT_INSTALL_STATES,
  DEVICES,
  POLES,
  MAIN_POLES,
  SUPPLY_TYPES,
  type Board,
  type Circuit,
  type InstallState,
} from "@/domains/circuit-schedule/schema";
import { INSTALL_LABELS, installState, boardProgressLine } from "@/domains/circuit-schedule/format";
import { setInstallField, saveBoardsField } from "./circuitScheduleClient";

type Banner = { tone: "danger" | "success"; message: string } | null;
type View = { kind: "list" } | { kind: "board"; id: string };
type Sheet =
  | { kind: "board"; mode: "add" | "edit"; board: Board }
  | { kind: "way"; mode: "add" | "edit"; boardId: string; circuit: Circuit }
  | null;

let _seq = 0;
const localId = (prefix: string) => `${prefix}_local_${(_seq += 1)}_${Math.floor(performance.now())}`;

function newBoard(): Board {
  return {
    id: localId("cb"),
    name: "New board", ref: "", location: "", suppliedFrom: "",
    supply: "1ph", voltage: 230, mainRating: 63, mainPoles: "2P",
    faultKA: 6, mainRcd: false, spd: false, ways: 12, status: "draft",
    updated: "", updatedBy: "", circuits: [],
  };
}

function nextWay(board: Board): number {
  const used = new Set(board.circuits.map((c) => c.way));
  let w = 1;
  while (used.has(w)) w += 1;
  return w;
}

function newWay(board: Board): Circuit {
  return {
    id: localId("cc"), way: nextWay(board), desc: "", type: "gpo",
    phase: "A", device: "MCB", rating: 20, poles: "1P", curve: "C", kA: 6,
    rcd: "none", rcdType: "", active: 2.5, neut: 2.5, cores: "TPS",
    length: 0, method: "", load: 0, loadUnit: "A", notes: "", install: "todo",
  };
}

/**
 * Phil field circuit schedule — the on-site electrician's view of the same
 * boards the office builds. Two levels: boards list → one board's ways. The
 * common action is one tap (advance a way's install state, P6); add / edit /
 * delete boards + ways are discoverable buttons (P12). Every write is honest
 * (P7): non-optimistic install (the segment only moves once the server
 * confirms) and a visible banner on any failure (P9). Site language throughout
 * (P11).
 */
export function PhilCircuitSchedule({
  jobId,
  jobName,
  initialBoards,
  loadError,
}: {
  jobId: string;
  jobName: string;
  initialBoards: Board[];
  loadError: string | null;
}) {
  const [boards, setBoards] = useState<Board[]>(initialBoards);
  const [view, setView] = useState<View>({ kind: "list" });
  const [sheet, setSheet] = useState<Sheet>(null);
  const [banner, setBanner] = useState<Banner>(loadError ? { tone: "danger", message: loadError } : null);
  const [savingInstall, setSavingInstall] = useState<string | null>(null);
  const [savingStructure, setSavingStructure] = useState(false);

  const flash = useCallback((next: Banner) => {
    setBanner(next);
    if (next?.tone === "success") {
      window.setTimeout(() => setBanner((b) => (b === next ? null : b)), 1800);
    }
  }, []);

  const activeBoard = view.kind === "board" ? boards.find((b) => b.id === view.id) ?? null : null;

  // One-tap install — non-optimistic. The segment only moves after the server
  // confirms; a failure shows the banner and the way stays where it was (P7).
  const setInstall = useCallback(
    async (boardId: string, circuit: Circuit, next: InstallState) => {
      setSavingInstall(circuit.id);
      setBanner(null);
      const res = await setInstallField(jobId, boardId, circuit.id, next);
      setSavingInstall(null);
      if (res.ok) {
        setBoards((prev) =>
          prev.map((b) =>
            b.id !== boardId
              ? b
              : { ...b, circuits: b.circuits.map((c) => (c.id === circuit.id ? { ...c, install: next } : c)) },
          ),
        );
      } else if (res.error.kind !== "cancelled") {
        flash({ tone: "danger", message: res.error.message || "Couldn’t save that. Try again." });
      }
    },
    [jobId, flash],
  );

  // Structural edits (add / edit / delete board or way) → PUT the whole schedule.
  // Applied only after the server confirms; the sheet stays open on failure so
  // nothing the worker typed is lost.
  const saveStructure = useCallback(
    async (nextBoards: Board[], opts: { successMessage: string; closeSheet?: boolean }) => {
      setSavingStructure(true);
      setBanner(null);
      const res = await saveBoardsField(jobId, nextBoards);
      setSavingStructure(false);
      if (res.ok) {
        setBoards(res.data);
        if (opts.closeSheet) setSheet(null);
        flash({ tone: "success", message: opts.successMessage });
        return true;
      }
      if (res.error.kind !== "cancelled") {
        flash({ tone: "danger", message: res.error.message || "Couldn’t save. Try again." });
      }
      return false;
    },
    [jobId, flash],
  );

  const addBoard = () => {
    const b = newBoard();
    setSheet({ kind: "board", mode: "add", board: b });
  };
  const addWay = (board: Board) => {
    setSheet({ kind: "way", mode: "add", boardId: board.id, circuit: newWay(board) });
  };

  const commitBoard = async (draft: Board, mode: "add" | "edit") => {
    const next =
      mode === "add"
        ? [...boards, draft]
        : boards.map((b) => (b.id === draft.id ? { ...draft, circuits: b.circuits } : b));
    const ok = await saveStructure(next, { successMessage: mode === "add" ? "Board added." : "Board saved.", closeSheet: true });
    if (ok && mode === "add") setView({ kind: "board", id: draft.id });
  };

  const commitWay = async (boardId: string, draft: Circuit, mode: "add" | "edit") => {
    const next = boards.map((b) => {
      if (b.id !== boardId) return b;
      const circuits = mode === "add" ? [...b.circuits, draft] : b.circuits.map((c) => (c.id === draft.id ? draft : c));
      return { ...b, circuits };
    });
    await saveStructure(next, { successMessage: mode === "add" ? "Way added." : "Way saved.", closeSheet: true });
  };

  const deleteWay = async (boardId: string, circuit: Circuit) => {
    const next = boards.map((b) =>
      b.id !== boardId ? b : { ...b, circuits: b.circuits.filter((c) => c.id !== circuit.id) },
    );
    await saveStructure(next, { successMessage: "Way deleted.", closeSheet: true });
  };

  const deleteBoard = async (board: Board) => {
    const next = boards.filter((b) => b.id !== board.id);
    const ok = await saveStructure(next, { successMessage: "Board deleted.", closeSheet: true });
    if (ok) setView({ kind: "list" });
  };

  return (
    <div className="space-y-4">
      {banner ? (
        <PhilNotice tone={banner.tone === "danger" ? "danger" : "success"} role={banner.tone === "danger" ? "alert" : "status"}>
          {banner.message}
        </PhilNotice>
      ) : null}

      {savingStructure ? (
        <p className="text-xs text-text-muted" role="status">Saving…</p>
      ) : null}

      {view.kind === "list" || !activeBoard ? (
        <BoardsList
          jobName={jobName}
          boards={boards}
          onOpen={(id) => setView({ kind: "board", id })}
          onAddBoard={addBoard}
        />
      ) : (
        <BoardView
          board={activeBoard}
          onBack={() => setView({ kind: "list" })}
          onAddWay={() => addWay(activeBoard)}
          onEditBoard={() => setSheet({ kind: "board", mode: "edit", board: activeBoard })}
          onEditWay={(c) => setSheet({ kind: "way", mode: "edit", boardId: activeBoard.id, circuit: c })}
          onSetInstall={(c, next) => setInstall(activeBoard.id, c, next)}
          savingInstall={savingInstall}
        />
      )}

      {sheet?.kind === "board" ? (
        <BoardSheet
          mode={sheet.mode}
          board={sheet.board}
          saving={savingStructure}
          onClose={() => setSheet(null)}
          onSave={(draft) => commitBoard(draft, sheet.mode)}
          onDelete={sheet.mode === "edit" ? () => deleteBoard(sheet.board) : undefined}
        />
      ) : null}

      {sheet?.kind === "way" ? (
        <WaySheet
          mode={sheet.mode}
          circuit={sheet.circuit}
          saving={savingStructure}
          onClose={() => setSheet(null)}
          onSave={(draft) => commitWay(sheet.boardId, draft, sheet.mode)}
          onDelete={sheet.mode === "edit" ? () => deleteWay(sheet.boardId, sheet.circuit) : undefined}
        />
      ) : null}
    </div>
  );
}

/* ── boards list ────────────────────────────────────────────────────────── */

function BoardsList({
  jobName, boards, onOpen, onAddBoard,
}: {
  jobName: string; boards: Board[]; onOpen: (id: string) => void; onAddBoard: () => void;
}) {
  return (
    <div className="space-y-3">
      {boards.length === 0 ? (
        <Card>
          <CardTitle>No boards yet</CardTitle>
          <CardDescription className="mt-2">
            There&rsquo;s no circuit schedule on {jobName} yet. Add the first board to start one.
          </CardDescription>
        </Card>
      ) : (
        <ul className="space-y-2" aria-label="Boards">
          {boards.map((b) => (
            <li key={b.id}>
              <button
                type="button"
                onClick={() => onOpen(b.id)}
                className="flex w-full min-h-[64px] items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-surface-subtle"
              >
                <Zap aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block font-display font-semibold text-text">
                    {b.name}
                    {b.ref ? <span className="ml-2 font-mono text-xs text-text-muted">{b.ref}</span> : null}
                  </span>
                  <span className="block text-xs text-text-muted">
                    {b.location ? `${b.location} · ` : ""}{boardProgressLine(b)}
                  </span>
                </span>
                <ChevronRight aria-hidden="true" className="h-5 w-5 shrink-0 text-text-muted/60" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <PhilActionButton onClick={onAddBoard}>
        <Plus aria-hidden="true" className="h-5 w-5" />
        Add board
      </PhilActionButton>
    </div>
  );
}

/* ── one board's ways ───────────────────────────────────────────────────── */

function BoardView({
  board, onBack, onAddWay, onEditBoard, onEditWay, onSetInstall, savingInstall,
}: {
  board: Board;
  onBack: () => void;
  onAddWay: () => void;
  onEditBoard: () => void;
  onEditWay: (c: Circuit) => void;
  onSetInstall: (c: Circuit, next: InstallState) => void;
  savingInstall: string | null;
}) {
  const ways = board.circuits.slice().sort((a, b) => a.way - b.way);
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onBack}
        className="inline-flex min-h-[44px] items-center gap-1 text-sm text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2"
      >
        ← All boards
      </button>

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>{board.name}</CardTitle>
            <CardDescription className="mt-1">
              {[board.ref, board.location, board.supply === "3ph" ? "3-phase" : "Single-phase", `${board.mainRating} A main`]
                .filter(Boolean)
                .join(" · ")}
            </CardDescription>
            <p className="mt-1 text-xs text-text-muted">{boardProgressLine(board)}</p>
          </div>
          <button
            type="button"
            onClick={onEditBoard}
            className="inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-card border border-border bg-surface px-3 text-sm font-medium text-text hover:bg-surface-subtle"
          >
            <Pencil aria-hidden="true" className="h-4 w-4" />
            Edit
          </button>
        </div>
      </Card>

      {ways.length === 0 ? (
        <Card>
          <CardDescription>No ways on this board yet. Add the first one below.</CardDescription>
        </Card>
      ) : (
        <ul className="space-y-2" aria-label={`Ways on ${board.name}`}>
          {ways.map((c) => (
            <WayRow
              key={c.id}
              circuit={c}
              saving={savingInstall === c.id}
              onEdit={() => onEditWay(c)}
              onSet={(next) => onSetInstall(c, next)}
            />
          ))}
        </ul>
      )}

      <PhilActionButton onClick={onAddWay}>
        <Plus aria-hidden="true" className="h-5 w-5" />
        Add way
      </PhilActionButton>
    </div>
  );
}

function WayRow({
  circuit, saving, onEdit, onSet,
}: {
  circuit: Circuit; saving: boolean; onEdit: () => void; onSet: (next: InstallState) => void;
}) {
  const current = installState(circuit.install);
  return (
    <li className="rounded-card border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xs text-text-muted">Way {circuit.way}</span>
            <span className="truncate font-medium text-text">{circuit.desc || "Untitled circuit"}</span>
          </div>
          <div className="mt-0.5 text-xs text-text-muted">
            {[circuit.device, `${circuit.rating} A`, `${circuit.active} mm²`, circuit.length ? `${circuit.length} m` : null]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        <button
          type="button"
          onClick={onEdit}
          aria-label={`Edit way ${circuit.way}`}
          className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-card border border-border bg-surface text-text-muted hover:bg-surface-subtle"
        >
          <Pencil aria-hidden="true" className="h-4 w-4" />
        </button>
      </div>
      <div className="mt-2">
        <InstallControl value={current} saving={saving} onSet={onSet} />
      </div>
    </li>
  );
}

function InstallControl({
  value, saving, onSet,
}: {
  value: InstallState; saving: boolean; onSet: (next: InstallState) => void;
}) {
  return (
    <div role="group" aria-label="Install state" className="grid grid-cols-3 gap-1">
      {CIRCUIT_INSTALL_STATES.map((s) => {
        const active = value === s;
        return (
          <button
            key={s}
            type="button"
            aria-pressed={active}
            disabled={saving}
            onClick={() => { if (!active) onSet(s); }}
            className={cn(
              "min-h-[44px] rounded-card border px-2 text-sm font-medium transition-colors",
              active
                ? "border-brand-navy bg-brand-navy text-text-inverse"
                : "border-border bg-surface text-text hover:bg-surface-subtle",
              saving && "opacity-60",
            )}
          >
            {INSTALL_LABELS[s]}
          </button>
        );
      })}
    </div>
  );
}

/* ── edit sheets ────────────────────────────────────────────────────────── */

function Sheet({
  title, saving, onClose, children, footer,
}: {
  title: string; saving: boolean; onClose: () => void; children: React.ReactNode; footer: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !saving) onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, saving]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40" onClick={() => { if (!saving) onClose(); }} />
      <div className="relative z-10 max-h-[88vh] w-full overflow-y-auto rounded-t-card bg-surface p-4 shadow-lg sm:max-w-md sm:rounded-card">
        <h2 className="font-display text-lg font-semibold text-text">{title}</h2>
        <div className="mt-3 space-y-3">{children}</div>
        <div className="mt-4 flex gap-2">{footer}</div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs font-medium uppercase tracking-wide text-text-muted">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}

const inputCls =
  "block w-full min-h-[44px] rounded-card border border-border bg-surface px-3 text-base text-text focus:border-brand-navy focus:outline-none";

function WaySheet({
  mode, circuit, saving, onClose, onSave, onDelete,
}: {
  mode: "add" | "edit";
  circuit: Circuit;
  saving: boolean;
  onClose: () => void;
  onSave: (draft: Circuit) => void;
  onDelete?: () => void;
}) {
  const [d, setD] = useState<Circuit>(circuit);
  const [armDelete, setArmDelete] = useState(false);
  const num = (v: string) => (v === "" ? 0 : Number(v));
  return (
    <Sheet
      title={mode === "add" ? "Add way" : `Way ${circuit.way}`}
      saving={saving}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving} className="min-h-[44px] flex-1 rounded-card border border-border bg-surface px-3 font-medium text-text disabled:opacity-60">
            Cancel
          </button>
          <PhilActionButton fullWidth={false} className="flex-1" disabled={saving} onClick={() => onSave({ ...d, rating: Number(d.rating), active: Number(d.active), length: Number(d.length) })}>
            {saving ? "Saving…" : "Save"}
          </PhilActionButton>
        </>
      }
    >
      <Field label="Description">
        <input className={inputCls} value={d.desc} onChange={(e) => setD({ ...d, desc: e.target.value })} placeholder="e.g. GPOs — kitchen" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Device">
          <select className={inputCls} value={d.device} onChange={(e) => setD({ ...d, device: e.target.value })}>
            {DEVICES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
        <Field label="Rating (A)">
          <input className={inputCls} inputMode="numeric" value={String(d.rating)} onChange={(e) => setD({ ...d, rating: num(e.target.value) })} />
        </Field>
        <Field label="Poles">
          <select className={inputCls} value={d.poles} onChange={(e) => setD({ ...d, poles: e.target.value })}>
            {POLES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
        <Field label="Cable (mm²)">
          <input className={inputCls} inputMode="decimal" value={String(d.active)} onChange={(e) => setD({ ...d, active: num(e.target.value) })} />
        </Field>
        <Field label="Length (m)">
          <input className={inputCls} inputMode="numeric" value={String(d.length)} onChange={(e) => setD({ ...d, length: num(e.target.value) })} />
        </Field>
      </div>
      <Field label="Notes">
        <input className={inputCls} value={d.notes ?? ""} onChange={(e) => setD({ ...d, notes: e.target.value })} placeholder="optional" />
      </Field>
      {onDelete ? (
        <button
          type="button"
          disabled={saving}
          onClick={() => { if (armDelete) onDelete(); else setArmDelete(true); }}
          className={cn(
            "min-h-[44px] w-full rounded-card border px-3 font-medium",
            armDelete ? "border-status-danger bg-status-danger text-text-inverse" : "border-border bg-surface text-status-danger",
          )}
        >
          {armDelete ? "Tap again to delete this way" : "Delete way"}
        </button>
      ) : null}
    </Sheet>
  );
}

function BoardSheet({
  mode, board, saving, onClose, onSave, onDelete,
}: {
  mode: "add" | "edit";
  board: Board;
  saving: boolean;
  onClose: () => void;
  onSave: (draft: Board) => void;
  onDelete?: () => void;
}) {
  const [d, setD] = useState<Board>(board);
  const [armDelete, setArmDelete] = useState(false);
  const num = (v: string) => (v === "" ? 0 : Number(v));
  return (
    <Sheet
      title={mode === "add" ? "Add board" : "Edit board"}
      saving={saving}
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={saving} className="min-h-[44px] flex-1 rounded-card border border-border bg-surface px-3 font-medium text-text disabled:opacity-60">
            Cancel
          </button>
          <PhilActionButton fullWidth={false} className="flex-1" disabled={saving || !d.name.trim()} onClick={() => onSave({ ...d, voltage: Number(d.voltage), mainRating: Number(d.mainRating), ways: Number(d.ways) })}>
            {saving ? "Saving…" : "Save"}
          </PhilActionButton>
        </>
      }
    >
      <Field label="Board name">
        <input className={inputCls} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Level 2 board" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Ref">
          <input className={inputCls} value={d.ref} onChange={(e) => setD({ ...d, ref: e.target.value })} placeholder="DB-L2" />
        </Field>
        <Field label="Ways">
          <input className={inputCls} inputMode="numeric" value={String(d.ways)} onChange={(e) => setD({ ...d, ways: num(e.target.value) })} />
        </Field>
      </div>
      <Field label="Location">
        <input className={inputCls} value={d.location} onChange={(e) => setD({ ...d, location: e.target.value })} placeholder="e.g. L2 electrical cupboard" />
      </Field>
      <Field label="Fed from">
        <input className={inputCls} value={d.suppliedFrom} onChange={(e) => setD({ ...d, suppliedFrom: e.target.value })} placeholder="e.g. MSB way 4" />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Supply">
          <select className={inputCls} value={d.supply} onChange={(e) => setD({ ...d, supply: e.target.value as Board["supply"], voltage: e.target.value === "3ph" ? 415 : 230 })}>
            {SUPPLY_TYPES.map((x) => <option key={x} value={x}>{x === "3ph" ? "3-phase" : "Single-phase"}</option>)}
          </select>
        </Field>
        <Field label="Voltage (V)">
          <input className={inputCls} inputMode="numeric" value={String(d.voltage)} onChange={(e) => setD({ ...d, voltage: num(e.target.value) })} />
        </Field>
        <Field label="Main switch (A)">
          <input className={inputCls} inputMode="numeric" value={String(d.mainRating)} onChange={(e) => setD({ ...d, mainRating: num(e.target.value) })} />
        </Field>
        <Field label="Poles">
          <select className={inputCls} value={d.mainPoles} onChange={(e) => setD({ ...d, mainPoles: e.target.value })}>
            {MAIN_POLES.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </Field>
      </div>
      {onDelete ? (
        <button
          type="button"
          disabled={saving}
          onClick={() => { if (armDelete) onDelete(); else setArmDelete(true); }}
          className={cn(
            "min-h-[44px] w-full rounded-card border px-3 font-medium",
            armDelete ? "border-status-danger bg-status-danger text-text-inverse" : "border-border bg-surface text-status-danger",
          )}
        >
          {armDelete ? `Tap again to delete ${board.name} and its ${board.circuits.length} way${board.circuits.length === 1 ? "" : "s"}` : "Delete board"}
        </button>
      ) : null}
    </Sheet>
  );
}
