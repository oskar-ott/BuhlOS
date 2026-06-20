"use client";

import { useEffect, useState, type ReactNode } from "react";
import { type Board } from "@/domains/circuit-schedule/schema";
import { BoardOverview } from "./BoardOverview";
import { ScheduleBuilder } from "./ScheduleBuilder";
import { SchedulePreview } from "./SchedulePreview";

export interface CircuitJob { id: string; name: string; client: string; drawing: string; }
type View = { name: "overview" } | { name: "builder"; id: string } | { name: "preview"; id: string };

const clone = (b: Board): Board => ({ ...b, circuits: b.circuits.map((c) => ({ ...c })) });

/**
 * Client root for the Circuit Schedule Builder — ported from the design's cs-app.
 * Holds the boards in memory (SAMPLE DATA; persistence is a follow-up slice),
 * routes between overview / builder / preview, and scopes the design's CSS under
 * `.cs-scope`. The office chrome (sidebar/topbar/breadcrumb) is the real AdminShell.
 */
export function CircuitScheduleApp({ job, initialBoards, storageKey }: { job: CircuitJob; initialBoards: Board[]; storageKey: string }) {
  const [boards, setBoards] = useState<Board[]>(() => initialBoards.map(clone));
  const [view, setView] = useState<View>({ name: "overview" });

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

  const update = (boardId: string, mutator: (b: Board) => void) =>
    setBoards((prev) => prev.map((b) => {
      if (b.id !== boardId) return b;
      const draft = clone(b);
      mutator(draft);
      return draft;
    }));

  const boardById = (id: string) => boards.find((b) => b.id === id);
  const openBoard = (id: string) => setView({ name: "builder", id });
  const openPreview = (id?: string) => setView({ name: "preview", id: id || boards[0]?.id || "" });

  let body: ReactNode;
  const activeBuilder = view.name === "builder" ? boardById(view.id) : undefined;
  const activePreview = view.name === "preview" ? boardById(view.id) : undefined;

  if (activeBuilder) {
    body = <ScheduleBuilder board={activeBuilder} job={job} update={update} onBack={() => setView({ name: "overview" })} onPrint={openPreview} />;
  } else if (activePreview) {
    body = <SchedulePreview board={activePreview} job={job} onBack={() => setView({ name: "builder", id: activePreview.id })} />;
  } else {
    body = <BoardOverview boards={boards} job={job} onOpen={openBoard} onPrint={() => openPreview()} />;
  }

  return (
    <div className="cs-scope" data-theme="light" data-density="regular">
      <div key={view.name + ("id" in view ? view.id : "")} className="cs-view">
        {body}
      </div>
    </div>
  );
}
