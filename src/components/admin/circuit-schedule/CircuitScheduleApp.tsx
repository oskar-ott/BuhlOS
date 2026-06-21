"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { type Board } from "@/domains/circuit-schedule/schema";
import { saveCircuitBoards } from "@/domains/circuit-schedule/client";
import { BoardOverview } from "./BoardOverview";
import { ScheduleBuilder } from "./ScheduleBuilder";
import { SchedulePreview } from "./SchedulePreview";

export interface CircuitJob { id: string; name: string; client: string; drawing: string; }
type View = { name: "overview" } | { name: "builder"; id: string } | { name: "preview"; id: string };
type SaveState = "idle" | "saving" | "saved" | "error";

const clone = (b: Board): Board => ({ ...b, circuits: b.circuits.map((c) => ({ ...c })) });

let _boardSeq = 0;
function newBoard(): Board {
  _boardSeq += 1;
  return {
    id: `cb_local_${_boardSeq}_${Math.floor(performance.now())}`,
    name: "New board",
    ref: "",
    location: "",
    suppliedFrom: "",
    supply: "1ph",
    voltage: 230,
    mainRating: 63,
    mainPoles: "2P",
    faultKA: 6,
    mainRcd: false,
    spd: false,
    ways: 12,
    status: "draft",
    updated: "",
    updatedBy: "",
    circuits: [],
  };
}

/**
 * Client root for the Circuit Schedule Builder — ported from the design's
 * cs-app, now wired to the shared store (PUT /api/job-circuits `boards`).
 *
 * Boards load server-side and live in memory here; every edit debounce-saves
 * the whole set back (the endpoint replaces wholesale, the same contract the
 * switchboards/circuits register uses). A 403 on save flips the surface to
 * read-only rather than spinning. The office chrome is the real AdminShell;
 * the design's CSS is scoped under `.cs-scope`.
 */
export function CircuitScheduleApp({
  job,
  jobId,
  initialBoards,
  canManage,
  loadError,
  storageKey,
}: {
  job: CircuitJob;
  jobId: string;
  initialBoards: Board[];
  canManage: boolean;
  loadError: string | null;
  storageKey: string;
}) {
  const [boards, setBoards] = useState<Board[]>(() => initialBoards.map(clone));
  const [view, setView] = useState<View>({ name: "overview" });
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [forcedReadOnly, setForcedReadOnly] = useState(false);
  const writable = canManage && !forcedReadOnly;

  // Latest boards for the async saver; `rev` is bumped only by user edits, so
  // adopting server-stamped boards never re-triggers a save.
  const boardsRef = useRef(boards);
  boardsRef.current = boards;
  const [rev, setRev] = useState(0);
  const bump = () => setRev((r) => r + 1);

  const savingRef = useRef(false);
  const rerunRef = useRef(false);

  // Restore / persist the current view (client-only; avoids SSR hydration mismatch).
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const v = JSON.parse(raw) as View;
        if (v && v.name) setView(v);
      }
    } catch {
      /* ignore */
    }
  }, [storageKey]);
  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(view)); } catch { /* ignore */ }
  }, [view, storageKey]);

  const doSave = useCallback(async () => {
    if (!canManage || forcedReadOnly) return;
    if (savingRef.current) { rerunRef.current = true; return; }
    savingRef.current = true;
    setSaveState("saving");
    const snapshot = boardsRef.current;
    const res = await saveCircuitBoards(jobId, snapshot);
    savingRef.current = false;
    if (res.ok) {
      setSaveState("saved");
      // Adopt the server's normalised stamps (updated / updatedBy) WITHOUT
      // bumping rev — but only if no edit landed mid-save, else we'd clobber.
      if (!rerunRef.current) {
        const byId = new Map(res.data.boards.map((b) => [b.id, b]));
        setBoards((prev) =>
          prev.map((b) => {
            const srv = byId.get(b.id);
            return srv ? { ...b, updated: srv.updated, updatedBy: srv.updatedBy } : b;
          }),
        );
      }
    } else if (res.error.status === 403) {
      setForcedReadOnly(true);
      setSaveState("error");
    } else {
      setSaveState("error");
    }
    if (rerunRef.current) { rerunRef.current = false; void doSave(); }
  }, [canManage, forcedReadOnly, jobId]);

  // Debounced autosave on every user edit.
  useEffect(() => {
    if (rev === 0 || !writable) return;
    const t = setTimeout(() => { void doSave(); }, 900);
    return () => clearTimeout(t);
  }, [rev, writable, doSave]);

  // Light retry on a transient save error (a later edit would also re-save).
  useEffect(() => {
    if (saveState !== "error" || forcedReadOnly || !writable) return;
    const t = setTimeout(() => { void doSave(); }, 5000);
    return () => clearTimeout(t);
  }, [saveState, forcedReadOnly, writable, doSave]);

  const update = (boardId: string, mutator: (b: Board) => void) => {
    setBoards((prev) => prev.map((b) => {
      if (b.id !== boardId) return b;
      const draft = clone(b);
      mutator(draft);
      return draft;
    }));
    bump();
  };

  const addBoard = () => {
    if (!writable) return;
    const nb = newBoard();
    setBoards((prev) => [...prev, nb]);
    bump();
    setView({ name: "builder", id: nb.id });
  };

  const deleteBoard = (boardId: string) => {
    if (!writable) return;
    setBoards((prev) => prev.filter((b) => b.id !== boardId));
    bump();
    setView({ name: "overview" });
  };

  const boardById = (id: string) => boards.find((b) => b.id === id);
  const openBoard = (id: string) => setView({ name: "builder", id });
  const openPreview = (id?: string) => setView({ name: "preview", id: id || boards[0]?.id || "" });

  let body: ReactNode;
  const activeBuilder = view.name === "builder" ? boardById(view.id) : undefined;
  const activePreview = view.name === "preview" ? boardById(view.id) : undefined;

  if (activeBuilder) {
    body = (
      <ScheduleBuilder
        board={activeBuilder}
        job={job}
        canManage={writable}
        update={update}
        onDelete={deleteBoard}
        onBack={() => setView({ name: "overview" })}
        onPrint={openPreview}
      />
    );
  } else if (activePreview) {
    body = <SchedulePreview board={activePreview} job={job} onBack={() => setView({ name: "builder", id: activePreview.id })} />;
  } else {
    body = <BoardOverview boards={boards} job={job} canManage={writable} onOpen={openBoard} onAddBoard={addBoard} onPrint={() => openPreview()} />;
  }

  return (
    <div className="cs-scope" data-theme="light" data-density="regular">
      <CsStatusBar canManage={canManage} forcedReadOnly={forcedReadOnly} saveState={saveState} loadError={loadError} />
      <div key={view.name + ("id" in view ? view.id : "")} className="cs-view">
        {body}
      </div>
    </div>
  );
}

function CsStatusBar({
  canManage, forcedReadOnly, saveState, loadError,
}: {
  canManage: boolean; forcedReadOnly: boolean; saveState: SaveState; loadError: string | null;
}) {
  if (loadError) {
    return <div className="cs-statusbar err"><span className="cs-dot err" />{loadError}</div>;
  }
  if (!canManage || forcedReadOnly) {
    return (
      <div className="cs-statusbar ro">
        <span className="cs-dot" />
        {forcedReadOnly ? "Read-only — you don’t have permission to edit this schedule." : "Read-only view."}
      </div>
    );
  }
  const label =
    saveState === "saving" ? "Saving…"
    : saveState === "error" ? "Couldn’t save — retrying…"
    : saveState === "saved" ? "All changes saved"
    : "Changes save automatically";
  return (
    <div className={"cs-statusbar " + (saveState === "error" ? "err" : "ok")}>
      <span className={"cs-dot " + (saveState === "saving" ? "busy" : saveState === "error" ? "err" : "ok")} />
      {label}
    </div>
  );
}
