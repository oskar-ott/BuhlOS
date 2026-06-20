"use client";

import { type Board } from "@/domains/circuit-schedule/schema";
import { totals, balance } from "@/domains/circuit-schedule/compute";
import { Ic } from "./icons";
import { Pill } from "./shared";

const BOARD_STATUS: Record<string, [string, string]> = {
  active: ["green", "Active"],
  issued: ["navy", "Issued"],
  draft: ["grey", "Draft"],
};

interface Job {
  id: string;
  name: string;
  drawing: string;
}

function WaysBar({ used, total }: { used: number; total: number }) {
  const cap = Math.min(total, 24);
  const usedCap = Math.round((used / total) * cap);
  return (
    <div className="cs-ways">
      <div className="cs-ways-track">
        {Array.from({ length: cap }).map((_, i) => (
          <i key={i} className={i < usedCap ? "" : "spare"} />
        ))}
      </div>
      <span className="cs-ways-tx">
        {used}/{total} ways
      </span>
    </div>
  );
}

function PhaseMini({ board }: { board: Board }) {
  const b = balance(board);
  if (!b) return <span className="cs-ways-tx upper1">1-phase</span>;
  const max = Math.max(b.A, b.B, b.C, 1);
  return (
    <div className="cs-phasemini" title={`A ${b.A.toFixed(0)} · B ${b.B.toFixed(0)} · C ${b.C.toFixed(0)} A`}>
      {(["A", "B", "C"] as const).map((p) => (
        <div key={p} className={"pm-bar" + (b.status === "bad" ? " over" : "")}>
          <i ref={(el) => { if (el) el.style.height = Math.round((b[p] / max) * 100) + "%"; }} />
        </div>
      ))}
    </div>
  );
}

function BoardCard({ board, onOpen }: { board: Board; onOpen: (id: string) => void }) {
  const t = totals(board);
  const st = BOARD_STATUS[board.status] ?? ["grey", board.status];
  const issues = t.errCount + t.warnCount;
  const empty = board.circuits.length === 0;
  return (
    <div className={"cs-bcard " + board.status} role="button" tabIndex={0} onClick={() => onOpen(board.id)}
      onKeyDown={(e) => { if (e.key === "Enter") onOpen(board.id); }}>
      <div className="bc-top">
        <div className="bc-id">
          <div className="bc-ico"><Ic.board /></div>
          <div className="bc-name">{board.name}<small>{board.ref} · {board.location}</small></div>
        </div>
        <Pill tone={st[0]} dotted>{st[1]}</Pill>
      </div>

      <dl className="bc-meta">
        <div><dt>Supply</dt><dd>{board.supply === "3ph" ? "3-phase" : "1-phase"}<small> {board.voltage} V</small></dd></div>
        <div><dt>Main</dt><dd>{board.mainRating}<small> A {board.mainPoles}</small></dd></div>
        <div><dt>Fault</dt><dd>{board.faultKA}<small> kA</small></dd></div>
        <div><dt>Circuits</dt><dd>{empty ? "—" : board.circuits.length}</dd></div>
      </dl>

      <div className="bc-foot">
        <div className="bc-health">
          {empty ? (
            <span className="cs-ways-tx upper1 ink4">Not started</span>
          ) : issues > 0 ? (
            <Pill tone={t.errCount ? "red" : "amber"}>
              {t.errCount ? `${t.errCount} error${t.errCount > 1 ? "s" : ""}` : `${t.warnCount} to check`}
            </Pill>
          ) : (
            <Pill tone="green" dotted>Compliant</Pill>
          )}
          {!empty && <WaysBar used={t.used} total={board.ways} />}
        </div>
        {!empty && <PhaseMini board={board} />}
      </div>

      <div className="bc-foot t2">
        <span className="bc-edit">{board.updated}{board.updatedBy && board.updatedBy !== "—" ? " · " + board.updatedBy : ""}</span>
      </div>
    </div>
  );
}

export function BoardOverview({ boards, job, onOpen, onPrint }: { boards: Board[]; job: Job; onOpen: (id: string) => void; onPrint: () => void }) {
  const totalWays = boards.reduce((s, b) => s + b.ways, 0);
  const usedWays = boards.reduce((s, b) => s + b.circuits.length, 0);
  const errs = boards.reduce((s, b) => s + totals(b).errCount, 0);
  return (
    <>
      <div className="bos-pagehdr">
        <div>
          <h1>Circuit schedules</h1>
          <div className="sub">{job.name} · {job.id} · {job.drawing}</div>
        </div>
        <div className="bos-pagehdr-actions">
          <button className="btn ghost" onClick={onPrint}><Ic.printer /> Print all</button>
          <button className="btn primary" title="Adding boards isn't wired yet (sample data)"><Ic.plus /> Add board</button>
        </div>
      </div>

      <div className="kpi-row">
        <div className="kpi"><div className="lbl">Boards</div><div className="num">{boards.length}</div><div className="delta">on this job</div></div>
        <div className="kpi"><div className="lbl">Ways used</div><div className="num">{usedWays}<span className="frac"> / {totalWays}</span></div><div className="delta">{totalWays - usedWays} spare across boards</div></div>
        <div className="kpi"><div className="lbl">Open errors</div><div className={"num " + (errs ? "warn" : "ok")}>{errs}</div><div className="delta">block export until cleared</div></div>
        <div className="kpi"><div className="lbl">Standard</div><div className="num std">AS/NZS 3000</div><div className="delta">wiring rules</div></div>
      </div>

      <div className="cs-board-grid">
        {boards.map((b) => <BoardCard key={b.id} board={b} onOpen={onOpen} />)}
        <button className="cs-add-board" title="Adding boards isn't wired yet (sample data)">
          <span className="ab-plus">+</span>
          <b>Add a board</b>
          <small>or start from a preset</small>
        </button>
      </div>
    </>
  );
}
