"use client";

import { type Board } from "@/domains/circuit-schedule/schema";
import { totals, balance, rowCurrent, rowVd, hasRcd } from "@/domains/circuit-schedule/compute";
import { formatEditedAt } from "@/domains/circuit-schedule/format";
import { Ic } from "./icons";

interface Job { name: string; id: string; client: string; drawing: string; }

function DocTable({ board }: { board: Board }) {
  const is3 = board.supply === "3ph";
  const spares = Math.max(0, board.ways - board.circuits.length);
  return (
    <table className="cs-doc-table">
      <thead>
        <tr>
          <th className="num">Way</th><th>Description</th>{is3 && <th>Ph</th>}
          <th>Device</th><th className="num">A</th><th>Poles</th><th>Curve</th><th className="num">kA</th>
          <th>RCD</th><th>Active</th><th>N/E</th><th>Cores</th><th className="num">Len</th>
          <th>Install</th><th className="num">Load</th><th className="num">Vd%</th>
        </tr>
      </thead>
      <tbody>
        {board.circuits.slice().sort((a, b) => a.way - b.way).map((c) => (
          <tr key={c.id}>
            <td className="num">{c.way}</td>
            <td className="dn">{c.desc}{c.notes ? <div className="doc-note">{c.notes}</div> : null}</td>
            {is3 && <td>{c.poles === "3P" ? "L1-3" : "L" + (c.phase === "A" ? 1 : c.phase === "B" ? 2 : 3)}</td>}
            <td>{c.device}</td><td className="num">{c.rating}</td><td>{c.poles}</td><td>{c.curve}</td><td className="num">{c.kA}</td>
            <td>{hasRcd(c) ? c.rcd + (c.rcdType ? " " + c.rcdType : "") : "—"}</td>
            <td>{c.active}</td><td>{c.neut}</td><td>{c.cores}</td><td className="num">{c.length}</td>
            <td className="method">{c.method}</td><td className="num">{rowCurrent(c).toFixed(0)}</td><td className="num">{rowVd(c).toFixed(1)}</td>
          </tr>
        ))}
        {Array.from({ length: spares }).map((_, i) => (
          <tr className="spare" key={"s" + i}><td className="num">·</td><td className="dn" colSpan={is3 ? 15 : 14}>SPARE</td></tr>
        ))}
      </tbody>
    </table>
  );
}

export function SchedulePreview({ board, job, onBack }: { board: Board; job: Job; onBack: () => void }) {
  const t = totals(board);
  const bal = balance(board);
  return (
    <div className="cs-builder">
      <div className="bos-pagehdr titlerow">
        <div className="titlerow">
          <button className="btn ghost pl8" onClick={onBack}><Ic.back /> Back</button>
          <div><h1 className="h1sm">Schedule preview</h1><div className="sub">{board.name} · {board.ref} · print / PDF</div></div>
        </div>
        <div className="bos-pagehdr-actions">
          <button className="btn" onClick={() => window.print()}><Ic.printer /> Print</button>
          <button className="btn primary" onClick={() => window.print()}><Ic.download /> Save PDF</button>
        </div>
      </div>

      <div className="cs-preview-wrap">
        <div className="cs-paper">
          <div className="cs-doc-hd">
            <div className="dh-left">
              <div className="dh-wordmark">bühl electrical</div>
              <div className="dh-eyebrow">Circuit schedule</div>
              <h1>{board.name}</h1>
              <div className="dh-sub">{board.ref} · {board.location}</div>
            </div>
            <div className="dh-right">
              <div className="dh-co">bühl electrical</div>
              <div className="dh-co"><small>ABN 61 204 887 113</small></div>
              <div className="dh-co"><small>Lic. PGE 198447 · Sydney NSW</small></div>
            </div>
          </div>

          <dl className="cs-doc-meta">
            <div><dt>Project</dt><dd>{job.name}</dd></div>
            <div><dt>Job no.</dt><dd>{job.id}</dd></div>
            <div><dt>Client</dt><dd>{job.client || "—"}</dd></div>
            <div><dt>Drawing</dt><dd>{job.drawing || "—"}</dd></div>
            <div><dt>Supply</dt><dd>{board.supply === "3ph" ? "3-phase" : "Single-phase"} · {board.voltage} V</dd></div>
            <div><dt>Main switch</dt><dd>{board.mainRating} A {board.mainPoles}</dd></div>
            <div><dt>Fault level</dt><dd>{board.faultKA} kA</dd></div>
            <div><dt>Fed from</dt><dd className="dh-fedfrom">{board.suppliedFrom}</dd></div>
            <div><dt>Ways used</dt><dd>{t.used} of {board.ways} ({t.spare} spare)</dd></div>
            <div><dt>{board.supply === "3ph" ? "Worst phase" : "Connected"}</dt><dd>{t.connected.toFixed(0)} A ({(t.loadPct * 100).toFixed(0)}%)</dd></div>
            {bal ? (
              <div><dt>Phase balance</dt><dd>L1 {bal.A.toFixed(0)} · L2 {bal.B.toFixed(0)} · L3 {bal.C.toFixed(0)} A</dd></div>
            ) : (
              <div><dt>Surge (SPD)</dt><dd>{board.spd ? "Fitted" : "—"}</dd></div>
            )}
            <div><dt>Issued</dt><dd>{board.status === "issued" ? (formatEditedAt(board.updated) || "Issued") : "Draft"}</dd></div>
          </dl>

          {/* #666 — contain the wide schedule table so it scrolls inside the
              paper on a phone instead of forcing page-wide overflow. The print
              rule targets .cs-paper, so this wrapper doesn't affect export. */}
          <div className="overflow-x-auto">
            <DocTable board={board} />
          </div>

          <div className="cs-doc-sign">
            <div className="sg"><dt>Designed by</dt><dd>Oskar Bühl</dd></div>
            <div className="sg"><dt>Installed / verified by</dt><dd>{(board.updatedBy || "").split(" · ")[0]}</dd></div>
            <div className="sg"><dt>Date</dt><dd>&nbsp;</dd></div>
          </div>

          <div className="cs-doc-foot">
            <span>Schedule prepared in BuhlOS · circuit values indicative, verify on site against AS/NZS 3000 &amp; AS/NZS 3008.</span>
            <span>{board.id} · page 1 of 1</span>
          </div>
        </div>
      </div>
    </div>
  );
}
