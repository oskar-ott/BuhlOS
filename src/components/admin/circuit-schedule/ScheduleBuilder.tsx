"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { type Board, type Circuit, DEVICES, POLES, CURVES, CORES, RCD_OPTIONS, PRESETS, VD_LIMIT } from "@/domains/circuit-schedule/schema";
import { rowVd, rowWarnings, rcdRequired, hasRcd, totals, balance, fromPreset, newCircuitId, rowCurrent, autoBalance } from "@/domains/circuit-schedule/compute";
import { Ic } from "./icons";
import { Pill, EditCell, SelectCell } from "./shared";

interface Job { name: string; drawing: string; }
type Patch = Record<string, string | number>;
type Mutator = (b: Board) => void;
type Update = (boardId: string, mutator: Mutator) => void;

const POLE_W: Record<string, number> = { "1P": 1, "2P": 2, "3P": 3 };

// reorder b.circuits (visual/way order) and re-number ways by pole width
function moveCircuit(b: Board, fromId: string, toId: string, pos: "before" | "after") {
  const arr = b.circuits.slice().sort((a, c) => a.way - c.way);
  const fi = arr.findIndex((x) => x.id === fromId);
  if (fi < 0) return;
  const [moved] = arr.splice(fi, 1);
  if (!moved) return;
  let ti = arr.findIndex((x) => x.id === toId);
  if (ti < 0) ti = arr.length;
  else if (pos === "after") ti += 1;
  arr.splice(ti, 0, moved);
  let w = 1;
  arr.forEach((x) => { x.way = w; w += POLE_W[x.poles] || 1; });
  b.circuits = arr;
}

function PhaseBadge({ phase, onCycle, locked }: { phase: string; onCycle: () => void; locked: boolean }) {
  return (
    <button className={"c-phase " + phase} onClick={locked ? undefined : onCycle} disabled={locked} title={locked ? "" : "Click to cycle phase"}>
      {phase}
    </button>
  );
}

interface DragState { id: string; overId: string; pos: "before" | "after"; }
interface DragHandlers {
  start: (id: string) => void;
  over: (e: DragEvent, id: string) => void;
  drop: (e: DragEvent) => void;
  end: () => void;
}

function CircuitRow({ c, board, locked, sel, onSel, onEdit, onDup, onDel, dragOver, dragging, dragHandlers }: {
  c: Circuit; board: Board; locked: boolean; sel: string | null;
  onSel: (id: string) => void; onEdit: (id: string, patch: Patch) => void;
  onDup: (id: string) => void; onDel: (id: string) => void;
  dragOver: "before" | "after" | null; dragging: boolean; dragHandlers: DragHandlers;
}) {
  const [armed, setArmed] = useState(false);
  const vd = rowVd(c);
  const warns = rowWarnings(c);
  const worst = warns.some((w) => w.sev === "red") ? "err" : warns.length ? "warn" : "";
  const rcdMiss = rcdRequired(c) && !hasRcd(c);
  const vdCls = vd > VD_LIMIT ? "red" : vd > VD_LIMIT - 0.8 ? "amber" : "ok";
  const is3 = board.supply === "3ph";
  const cls = [worst ? worst + "-row" : "", sel === c.id ? "sel" : "", dragging ? "dragging" : "", dragOver ? "drop-" + dragOver : ""].filter(Boolean).join(" ");
  return (
    <tr
      className={cls}
      onClick={() => onSel(c.id)}
      draggable={armed}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; dragHandlers.start(c.id); }}
      onDragOver={(e) => dragHandlers.over(e, c.id)}
      onDrop={(e) => dragHandlers.drop(e)}
      onDragEnd={() => { setArmed(false); dragHandlers.end(); }}
    >
      <td className="c-grip-cell">
        {!locked && (
          <span className="c-grip" title="Drag to reorder ways"
            onMouseDown={() => setArmed(true)} onMouseUp={() => setArmed(false)} onClick={(e) => e.stopPropagation()}>
            <Ic.grip />
          </span>
        )}
      </td>
      <td className="c-way">{c.way}</td>
      <td className="c-desc">
        <EditCell value={c.desc} className="dtxt" onCommit={(v) => onEdit(c.id, { desc: v })} />
        {c.notes ? <div className="cs-mono c-note">{c.notes}</div> : null}
      </td>
      {is3 && (
        <td className="td-ph">
          {c.poles === "3P" ? <span className="c-tag">3Ø</span> : <PhaseBadge phase={c.phase || "A"} locked={locked} onCycle={() => onEdit(c.id, { phase: c.phase === "A" ? "B" : c.phase === "B" ? "C" : "A" })} />}
        </td>
      )}
      <td>{locked ? <span className="c-tag">{c.device}</span> : <SelectCell value={c.device} options={DEVICES} title="Protective device" onCommit={(v) => onEdit(c.id, { device: v })} />}</td>
      <td className="num"><EditCell value={c.rating} numeric onCommit={(v) => onEdit(c.id, { rating: v })} /><span className="u">A</span></td>
      <td className="tac">{locked ? <span className="cs-mono">{c.poles}</span> : <SelectCell value={c.poles} options={POLES} title="Poles" onCommit={(v) => onEdit(c.id, { poles: v })} />}</td>
      <td className="tac">{locked ? <span className="cs-mono">{c.curve}</span> : <SelectCell value={c.curve} options={CURVES} title="Trip curve" onCommit={(v) => onEdit(c.id, { curve: v })} />}</td>
      <td className="num">{locked ? c.kA : <EditCell value={c.kA} numeric onCommit={(v) => onEdit(c.id, { kA: v })} />}</td>
      <td className="cs-mono rcd-cell">
        {locked ? (
          hasRcd(c) ? <>{c.rcd}{c.rcdType ? " " + c.rcdType : ""}</> : <span className={rcdMiss ? "c-rcd-miss" : ""}>{rcdMiss ? "req!" : "—"}</span>
        ) : (
          <>
            <SelectCell value={c.rcd} options={RCD_OPTIONS} title="RCD protection" onCommit={(v) => onEdit(c.id, { rcd: v })} />
            {c.rcd !== "none" && c.rcdType ? " " + c.rcdType : ""}
            {rcdMiss ? <span className="c-rcd-miss"> req!</span> : null}
          </>
        )}
      </td>
      <td className="c-cable">
        {locked ? <>{c.active}/{c.neut}</> : <><EditCell value={c.active} numeric onCommit={(v) => onEdit(c.id, { active: v })} />/<EditCell value={c.neut} numeric onCommit={(v) => onEdit(c.id, { neut: v })} /></>}
        <span className="u"> mm²</span>
      </td>
      <td className="tac">{locked ? <span className="cs-mono fs10">{c.cores}</span> : <SelectCell value={c.cores} options={CORES} title="Cable type" onCommit={(v) => onEdit(c.id, { cores: v })} />}</td>
      <td className="num"><EditCell value={c.length} numeric onCommit={(v) => onEdit(c.id, { length: v })} /><span className="u">m</span></td>
      <td className="cs-mono method-cell">{locked ? c.method : <EditCell value={c.method} onCommit={(v) => onEdit(c.id, { method: v })} />}</td>
      <td className="num">{rowCurrent(c).toFixed(0)}<span className="u">A</span></td>
      <td className="num"><span className={"c-vd " + vdCls}>{vd.toFixed(1)}%</span></td>
      <td className="c-actions">
        {!locked && (
          <span className="c-actbtns">
            <button className="c-actbtn" title="Duplicate circuit" onClick={(e) => { e.stopPropagation(); onDup(c.id); }}><Ic.copy /></button>
            <button className="c-actbtn del" title="Remove circuit" onClick={(e) => { e.stopPropagation(); onDel(c.id); }}><Ic.trash /></button>
          </span>
        )}
      </td>
    </tr>
  );
}

function BalanceMeter({ board }: { board: Board }) {
  const b = balance(board);
  if (!b) return null;
  const max = Math.max(b.A, b.B, b.C, 1);
  const tone = b.status === "ok" ? "green" : b.status === "caution" ? "amber" : "red";
  return (
    <div className="cs-balance">
      <h4>Phase balance <span className="bs"><Pill tone={tone}>{b.status === "ok" ? "Balanced" : b.status === "caution" ? "Watch" : "Imbalanced"}</Pill></span></h4>
      <div className="cs-bars">
        {(["A", "B", "C"] as const).map((p) => {
          const hi = b[p] === b.max && b.imb > 12;
          return (
            <div key={p} className={"cs-bcol" + (hi ? " hi" : "")}>
              <span className="bv">{b[p].toFixed(0)}<small>A</small></span>
              <div className="bbar" ref={(el) => { if (el) el.style.height = Math.max(3, Math.round((b[p] / max) * 64)) + "px"; }} />
              <span className="bl">L{p === "A" ? 1 : p === "B" ? 2 : 3}</span>
            </div>
          );
        })}
      </div>
      <div className="cs-bal-foot"><span>Imbalance</span><span className={"imb " + tone}>{b.imb.toFixed(0)}%</span></div>
    </div>
  );
}

interface RailWarning { sev: string; code: string; cid: string | null; way: number | string; msg: string; }

function ValidationRail({ board, warnings, onJump }: { board: Board; warnings: RailWarning[]; onJump: (cid: string | null) => void }) {
  return (
    <div className="cs-rail">
      <div className="cs-rail-hd">
        <h3>Validation</h3>
        <span className={"rc " + (warnings.length ? "has" : "clean")}>{warnings.length || "clean"}</span>
      </div>
      <BalanceMeter board={board} />
      <div className="cs-rail-list">
        {warnings.length === 0 ? (
          <div className="cs-rail-clean">
            <div className="ok-ic"><Ic.check /></div>
            <b>No issues</b>
            <p>Every circuit passes voltage-drop, RCD and cable-capacity checks.</p>
          </div>
        ) : warnings.map((w, i) => (
          <div className="cs-warn" key={i} onClick={() => onJump(w.cid)}>
            <span className={"w-dot " + w.sev} />
            <div className="w-body">
              <div className="w-top"><span className="w-way">{w.way === "Main" ? "Board" : "Way " + w.way}</span><span className="w-code">{w.code}</span></div>
              <div className="w-msg">{w.msg}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ScheduleBuilder({ board, job, canManage, update, onDelete, onBack, onPrint }: { board: Board; job: Job; canManage: boolean; update: Update; onDelete: (id: string) => void; onBack: () => void; onPrint: (id: string) => void }) {
  const [open, setOpen] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const setDragBoth = (v: DragState | null | ((d: DragState | null) => DragState | null)) => {
    dragRef.current = typeof v === "function" ? v(dragRef.current) : v;
    setDrag(dragRef.current);
  };
  const issued = board.status === "issued";
  const locked = !canManage || issued;
  const t = totals(board);
  const bal = balance(board);
  const is3 = board.supply === "3ph";

  const warnings: RailWarning[] = [];
  if (t.overloaded) warnings.push({ sev: t.loadPct > 1.1 ? "red" : "amber", code: "Load", cid: null, way: "Main", msg: `Connected load ${t.connected.toFixed(0)} A${is3 ? " (worst phase)" : ""} exceeds ${board.mainRating} A main switch — apply diversity or upsize` });
  board.circuits.forEach((c) => rowWarnings(c).forEach((w) => warnings.push({ ...w, cid: c.id, way: c.way })));
  warnings.sort((a, b) => (a.sev === b.sev ? 0 : a.sev === "red" ? -1 : 1));

  const edit = (cid: string, patch: Patch) => update(board.id, (b) => { const c = b.circuits.find((x) => x.id === cid); if (c) Object.assign(c, patch); });
  const editBoard = (patch: Partial<Board>) => update(board.id, (b) => Object.assign(b, patch));
  const nextWay = (b: Board) => { const used = new Set(b.circuits.map((c) => c.way)); let w = 1; while (used.has(w)) w++; return w; };
  const dup = (cid: string) => update(board.id, (b) => { const i = b.circuits.findIndex((x) => x.id === cid); const c = b.circuits[i]; if (!c) return; b.circuits.splice(i + 1, 0, { ...c, id: newCircuitId(), way: nextWay(b), desc: c.desc + " (copy)" }); });
  const del = (cid: string) => update(board.id, (b) => { b.circuits = b.circuits.filter((x) => x.id !== cid); });
  const addPreset = (p: (typeof PRESETS)[number]) => update(board.id, (b) => { b.circuits.push(fromPreset(p, nextWay(b))); });
  const addBlank = () => addPreset(PRESETS[1]!);
  const autoBal = () => update(board.id, (b) => { b.circuits = autoBalance(b).circuits; });
  const issue = () => { update(board.id, (b) => { b.status = "issued"; }); onPrint(board.id); };
  const reopen = () => update(board.id, (b) => { b.status = "active"; });
  // Two-step inline confirm (no window.confirm — house no-alert rule). Arm on
  // first click, delete on the second; auto-disarms after a few seconds.
  const [armDelete, setArmDelete] = useState(false);
  useEffect(() => {
    if (!armDelete) return;
    const t = setTimeout(() => setArmDelete(false), 3500);
    return () => clearTimeout(t);
  }, [armDelete]);
  const onDeleteClick = () => { if (armDelete) onDelete(board.id); else setArmDelete(true); };

  const dragHandlers: DragHandlers = {
    start: (id) => setDragBoth({ id, overId: id, pos: "before" }),
    over: (e, id) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const r = e.currentTarget.getBoundingClientRect();
      const pos = e.clientY - r.top < r.height / 2 ? "before" : "after";
      setDragBoth((d) => { if (!d || d.id === id) return d; if (d.overId === id && d.pos === pos) return d; return { ...d, overId: id, pos }; });
    },
    drop: (e) => { e.preventDefault(); const d = dragRef.current; if (d && d.id !== d.overId) update(board.id, (b) => moveCircuit(b, d.id, d.overId, d.pos)); setDragBoth(null); },
    end: () => setDragBoth(null),
  };

  const spares = Math.max(0, board.ways - board.circuits.length);
  const cols = is3 ? 16 : 15;

  return (
    <div className="cs-builder">
      <div className="bos-pagehdr center">
        <div className="titlerow">
          <button className="btn ghost pl8" onClick={onBack}><Ic.back /> Boards</button>
          <div>
            <h1 className="h1sm">{board.name}</h1>
            <div className="sub">{[job.name, board.ref, job.drawing].filter(Boolean).join(" · ")}</div>
          </div>
        </div>
        <div className="bos-pagehdr-actions">
          {canManage && (
            <button className={"btn ghost" + (armDelete ? " danger-armed" : "")} onClick={onDeleteClick} title={armDelete ? "Click again to delete" : "Delete this board"}>
              <Ic.trash /> {armDelete ? "Confirm delete" : "Delete"}
            </button>
          )}
          {is3 && !locked && <button className="btn" onClick={autoBal}><Ic.scale /> Auto-balance</button>}
          {canManage && issued && <button className="btn" onClick={reopen}><Ic.lock /> Re-open to edit</button>}
          <button className="btn" onClick={() => onPrint(board.id)}><Ic.printer /> Preview</button>
          {issued ? (
            <button className="btn dark" onClick={() => onPrint(board.id)}><Ic.download /> Re-export</button>
          ) : (
            <button className="btn dark" disabled={!canManage || t.errCount > 0} title={t.errCount ? "Clear errors before issuing" : ""} onClick={issue}><Ic.download /> Issue &amp; export</button>
          )}
        </div>
      </div>

      {locked && (
        <div className="cs-locked">
          <span className="lk-ic"><Ic.lock /></span>
          <span><b>Issued schedule.</b> Locked for record. The on-site worker can still raise edits in Phil — re-issue here to supersede.</span>
        </div>
      )}

      <div className="cs-hdr">
        <div className="cs-hdr-top">
          <div className="h-mark"><Ic.board /></div>
          <div>
            <div className="cs-hdr-name">{board.name}<small>{board.ref}</small></div>
            <div className="cs-hdr-sub">{board.location} · fed from {board.suppliedFrom}</div>
          </div>
          <button className={"cs-hdr-collapse" + (open ? " open" : "")} onClick={() => setOpen(!open)}>{open ? "Hide supply" : "Show supply"} <Ic.chev className="chev" /></button>
        </div>

        {open && (
          <div className="cs-supply">
            <div><dt>Supply</dt><dd className={locked ? "" : "editable"}>{locked ? (is3 ? "3-phase" : "Single-phase") : <SelectCell value={is3 ? "3-phase" : "Single-phase"} options={["Single-phase", "3-phase"]} wide title="Supply type" onCommit={(v) => editBoard({ supply: v === "3-phase" ? "3ph" : "1ph", voltage: v === "3-phase" ? 415 : 230 })} />}</dd></div>
            <div><dt>Voltage</dt><dd className={locked ? "" : "editable"}>{locked ? <>{board.voltage} V</> : <><EditCell value={board.voltage} numeric onCommit={(v) => editBoard({ voltage: Number(v) })} /> V</>}</dd></div>
            <div><dt>Main switch</dt><dd className={locked ? "" : "editable"}>{locked ? <>{board.mainRating} A {board.mainPoles}</> : <><EditCell value={board.mainRating} numeric onCommit={(v) => editBoard({ mainRating: Number(v) })} /> A <SelectCell value={board.mainPoles} options={["1P", "2P", "3P", "4P"]} title="Main switch poles" onCommit={(v) => editBoard({ mainPoles: v })} /></>}</dd></div>
            <div><dt>Fault level</dt><dd className={locked ? "" : "editable"}>{locked ? <>{board.faultKA} kA</> : <><EditCell value={board.faultKA} numeric onCommit={(v) => editBoard({ faultKA: Number(v) })} /> kA</>}</dd></div>
            <div><dt>Main RCD</dt><dd className={locked ? "" : "editable"}>{locked ? (board.mainRcd ? "Yes" : "Per circuit") : <SelectCell value={board.mainRcd ? "Yes" : "Per circuit"} options={["Per circuit", "Yes"]} wide title="Main RCD" onCommit={(v) => editBoard({ mainRcd: v === "Yes" })} />}</dd></div>
            <div><dt>Surge (SPD)</dt><dd className={locked ? "" : "editable"}>{locked ? (board.spd ? "Fitted" : "No") : <SelectCell value={board.spd ? "Fitted" : "No"} options={["No", "Fitted"]} wide title="Surge protection" onCommit={(v) => editBoard({ spd: v === "Fitted" })} />}</dd></div>
          </div>
        )}

        <div className="cs-summary">
          <div className="sm"><span className="sm-lbl">Ways</span><span className="sm-val">{t.used}<span className="sm-frac">/{board.ways}</span></span></div>
          <div className="sm"><span className="sm-lbl">Spare</span><span className="sm-val">{t.spare}</span></div>
          <div className="sm"><span className="sm-lbl">{is3 ? "Worst-phase load" : "Connected load"}</span><span className={"sm-val " + (t.overloaded ? "warn" : t.loadPct > 0.85 ? "amber" : "ok")}>{t.connected.toFixed(0)} A</span><span className="cs-mono sm-of">of {board.mainRating} A · {(t.loadPct * 100).toFixed(0)}%</span></div>
          {is3 && bal && (
            <div className="sm">
              <span className="sm-lbl">Phases</span>
              <div className="cs-pchips">
                {(["A", "B", "C"] as const).map((p) => <div key={p} className={"cs-pchip" + (bal[p] === bal.max && bal.imb > 12 ? " hi" : "")}><span className="pp">L{p === "A" ? 1 : p === "B" ? 2 : 3}</span><span className="pa">{bal[p].toFixed(0)}</span></div>)}
              </div>
            </div>
          )}
          <div className="sm-spacer" />
          <div className="sm">{t.errCount ? <Pill tone="red">{t.errCount} error{t.errCount > 1 ? "s" : ""}</Pill> : t.warnCount ? <Pill tone="amber">{t.warnCount} to check</Pill> : <Pill tone="green" dotted>Compliant</Pill>}</div>
        </div>
      </div>

      <div className="cs-body rail-side">
        <div className="cs-gridcard">
          {/* #666 — honest mobile note: the grid is a desktop authoring tool;
              on a phone it scrolls sideways inside its wrapper rather than
              breaking the page. sm:hidden so desktop never sees this. */}
          <p className="cs-mobile-hint sm:hidden">
            Best edited on a desktop — scroll the grid sideways to review.
          </p>
          {!locked && (
            <div className="cs-presets">
              <span className="pl">Quick add</span>
              {PRESETS.map((p) => (
                <button key={p.key} className="cs-preset" onClick={() => addPreset(p)}>
                  <span className="pk">{p.rating}A</span>{p.label}
                </button>
              ))}
            </div>
          )}

          <div className="cs-tablewrap overflow-x-auto">
            {board.circuits.length === 0 ? (
              <div className="cs-empty-board">
                <div className="eb-ic"><Ic.zap /></div>
                <h3>No circuits yet</h3>
                <p>Use a quick-add preset above to drop in a common circuit, or add a blank way and fill it in.</p>
                <button className="btn primary" onClick={addBlank}><Ic.plus /> Add first circuit</button>
              </div>
            ) : (
              <table className="cs-grid">
                <thead>
                  <tr>
                    <th className="c-grip-cell"></th>
                    <th className="num">Way</th><th>Description</th>{is3 && <th className="tac">Ph</th>}
                    <th>Device</th><th className="num">Rating</th><th className="tac">Poles</th>
                    <th className="tac">Curve</th><th className="num">kA</th><th>RCD</th>
                    <th>Cable A/N</th><th>Cores</th><th className="num">Len</th><th>Install method</th>
                    <th className="num">Load</th><th className="num">Vd</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {board.circuits.slice().sort((a, b) => a.way - b.way).map((c) => (
                    <CircuitRow key={c.id} c={c} board={board} locked={locked} sel={sel} onSel={setSel} onEdit={edit} onDup={dup} onDel={del}
                      dragging={!!drag && drag.id === c.id}
                      dragOver={drag && drag.id !== c.id && drag.overId === c.id ? drag.pos : null}
                      dragHandlers={dragHandlers} />
                  ))}
                  {Array.from({ length: spares }).map((_, i) => (
                    <tr className="cs-spare" key={"sp" + i} onClick={!locked ? addBlank : undefined}>
                      <td className="c-grip-cell"></td>
                      <td className="c-way">·</td>
                      <td colSpan={cols - 2}><span className="spare-lbl">spare way</span> {!locked && <span className="spare-add">— click to fill</span>}</td>
                      <td></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {!locked && board.circuits.length > 0 && (
            <div className="cs-grid-foot">
              <span className="cs-add-row" onClick={addBlank}><span className="plus">+</span> Add circuit</span>
              <span className="cs-grid-hint">Drag to reorder ways · click any value or dropdown to edit · trash to remove</span>
            </div>
          )}
        </div>

        <ValidationRail board={board} warnings={warnings} onJump={setSel} />
      </div>
    </div>
  );
}
