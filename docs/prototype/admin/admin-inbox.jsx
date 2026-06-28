// admin-inbox.jsx — the cross-job field-to-office inboxes:
// Defects · Observations · Material requests · Expenses · Dayworks.
// Each is a filterable register over the live source data. Exports the pages.

function KpiStrip({ cells }) {
  return (
    <div className="kpi-row" style={{ gridTemplateColumns: `repeat(${cells.length},1fr)` }}>
      {cells.map((c, i) => (
        <div className="kpi" key={i}>
          <div className="lbl">{c.lbl}</div>
          <div className={"num " + (c.tone || "")}>{c.v}</div>
          <div className="delta">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
function Seg({ value, onChange, options }) {
  return (
    <div className="seg-row"><div className="seg">
      {options.map(([k, t, c]) => (
        <button key={k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>{t}{c != null && <span className="c">{c}</span>}</button>
      ))}
    </div></div>
  );
}

// ════════════════════════════════════════════════════════════ DEFECTS ════════
function DefectsPage({ setOpenJob }) {
  const D = window.BX.defects;
  const [f, setF] = useState("open");
  const open = D.filter((d) => d.status === "open");
  const urgent = open.filter((d) => d.priority[1] === "urgent" || d.priority[1] === "high");
  const rows = f === "all" ? D : f === "open" ? open : f === "urgent" ? urgent : D.filter((d) => d.status === "closed");
  return (
    <>
      <PageHead title="Defects" sub={`Cross-job register · ${open.length} open · ${urgent.length} priority`}
        actions={<><button className="btn">Export</button><button className="btn">Bulk close</button></>} />
      <KpiStrip cells={[
        { lbl: "Open", v: open.length, sub: "across all jobs" },
        { lbl: "Urgent / high", v: urgent.length, sub: "need owner now", tone: "warn" },
        { lbl: "Stale > 3 days", v: open.filter((d) => /[3-9]d/.test(d.age)).length, sub: "past threshold", tone: "amber" },
        { lbl: "Closed · 7d", v: D.filter((d) => d.status === "closed").length, sub: "verified + signed", tone: "ok" },
      ]} />
      <Seg value={f} onChange={setF} options={[["open", "Open", open.length], ["urgent", "Priority", urgent.length], ["all", "All", D.length], ["closed", "Closed", D.filter((d) => d.status === "closed").length]]} />
      <div className="card">
        <table className="dtable">
          <thead><tr><th>Defect</th><th>Job</th><th>Area</th><th>Priority</th><th>Raised by</th><th>Age</th><th></th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="click" onClick={() => setOpenJob && setOpenJob(jobIdByName(d.job))}>
                <td><div className="cell-name" style={{ fontSize: 13 }}>{d.what}<small>{d.id}{d.photos ? " · " + d.photos + " photo" + (d.photos > 1 ? "s" : "") : ""}</small></div></td>
                <td className="cell-sub">{d.job}</td>
                <td className="cell-mono">{d.area}</td>
                <td><Pill status={d.priority} dotted /></td>
                <td className="cell-sub">{d.who}</td>
                <td className="cell-mono" style={{ color: "var(--ink-3)" }}>{d.age}</td>
                <td className="num">{d.status === "open" ? <button className="btn">Close</button> : <span className="tick">✓</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════ OBSERVATIONS ════════
function ObservationsPage({ setOpenJob }) {
  const O = window.BX.observations;
  const [f, setF] = useState("action");
  const needs = O.filter((o) => o.priority[1] === "needs action");
  const types = Array.from(new Set(O.map((o) => o.type)));
  const rows = f === "action" ? needs : f === "all" ? O : O.filter((o) => o.type === f);
  return (
    <>
      <PageHead title="From site" sub={`Field-to-office triage · ${needs.length} need action · ${O.length} total`}
        actions={<button className="btn primary">+ Log observation</button>} />
      <KpiStrip cells={[
        { lbl: "Needs action", v: needs.length, sub: "blockers · mismatches · RFIs", tone: "warn" },
        { lbl: "Open total", v: O.filter((o) => o.priority[1] !== "resolved").length, sub: "awaiting triage" },
        { lbl: "Plan mismatches", v: O.filter((o) => o.type === "Plan mismatch").length, sub: "vs current revision" },
        { lbl: "Resolved · 7d", v: O.filter((o) => o.priority[1] === "resolved").length, sub: "closed out", tone: "ok" },
      ]} />
      <Seg value={f} onChange={setF} options={[["action", "Needs action", needs.length], ["all", "All", O.length], ...types.slice(0, 3).map((t) => [t, t, O.filter((o) => o.type === t).length])]} />
      <div className="card obs-list">
        {rows.map((o) => (
          <div className="reg-row" key={o.id} onClick={() => setOpenJob && setOpenJob(jobIdByName(o.job))} style={{ cursor: "default" }}>
            <span className={"reg-row-accent " + o.priority[0]} />
            <div className="reg-row-body" style={{ paddingLeft: 6 }}>
              <div className="reg-row-title">
                <span className="src-badge">{o.type}</span>
                <span className="reg-row-name">{o.what}</span>
              </div>
              <div className="reg-row-meta"><b>{o.job}</b> · {o.area} · {o.who} · {o.age}{o.photo ? " · 📷" : ""}</div>
            </div>
            <div className="reg-row-actions">
              <Pill status={o.priority} dotted />
              {o.priority[1] === "needs action" && <button className="btn">Triage</button>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════ MATERIALS ══════════
function MaterialsPage() {
  const M = window.BX.materials;
  const [f, setF] = useState("requested");
  const byStatus = (s) => M.filter((m) => m.status[1] === s);
  const rows = f === "all" ? M : byStatus(f);
  const stages = [["requested", "Requested"], ["approved", "Approved"], ["ordered", "Ordered"], ["delivered", "Delivered"]];
  return (
    <>
      <PageHead title="Material requests" sub={`Procurement queue · ${byStatus("requested").length} to approve`}
        actions={<button className="btn primary">+ Raise request</button>} />
      <div className="pipeline">
        {stages.map(([k, t], i) => (
          <div className={"pl-stage" + (f === k ? " on" : "")} key={k} onClick={() => setF(k)}>
            <div className="pl-num">{byStatus(k).length}</div>
            <div className="pl-lbl">{t}</div>
            {i < stages.length - 1 && <span className="pl-arrow">→</span>}
          </div>
        ))}
      </div>
      <Seg value={f} onChange={setF} options={[["requested", "Requested", byStatus("requested").length], ["approved", "Approved", byStatus("approved").length], ["ordered", "Ordered", byStatus("ordered").length], ["delivered", "Delivered", byStatus("delivered").length], ["all", "All", M.length]]} />
      <div className="card">
        <table className="dtable">
          <thead><tr><th>Item</th><th>Job</th><th>Requested by</th><th>Supplier</th><th className="num">Value</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className="click">
                <td><div className="cell-name" style={{ fontSize: 13 }}>{m.item}<small>{m.id}{m.priority !== "normal" ? " · " + m.priority : ""}</small></div></td>
                <td className="cell-sub">{m.job}</td>
                <td className="cell-sub">{m.who}</td>
                <td className="cell-mono">{m.supplier}</td>
                <td className="num cell-mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{m.value}</td>
                <td><Pill status={m.status} dotted /></td>
                <td className="num">{m.status[1] === "requested" ? <button className="btn go">Approve</button> : m.status[1] === "approved" ? <button className="btn">Order</button> : ""}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} style={{ textAlign: "center", padding: 28, color: "var(--ink-3)" }}>Nothing {f} right now.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════ EXPENSES ═══════════
function ExpensesPage() {
  const E = window.BX.expenses;
  const [f, setF] = useState("submitted");
  const byStatus = (s) => E.filter((e) => e.status[1] === s);
  const rows = f === "all" ? E : byStatus(f);
  const pending = byStatus("submitted");
  return (
    <>
      <PageHead title="Expenses" sub={`Reimbursement queue · ${pending.length} to review`}
        actions={<button className="btn">Export for payroll</button>} />
      <KpiStrip cells={[
        { lbl: "Awaiting review", v: pending.length, sub: "field receipts", tone: "warn" },
        { lbl: "Approved · unpaid", v: byStatus("approved").length, sub: "next payroll run" },
        { lbl: "Reimbursed · 30d", v: byStatus("reimbursed").length, sub: "paid out", tone: "ok" },
        { lbl: "This week", v: "$" + (28.5 + 142 + 96.4 + 54).toFixed(0), sub: "submitted total" },
      ]} />
      <Seg value={f} onChange={setF} options={[["submitted", "To review", pending.length], ["approved", "Approved", byStatus("approved").length], ["reimbursed", "Reimbursed", byStatus("reimbursed").length], ["all", "All", E.length]]} />
      <div className="card">
        <table className="dtable">
          <thead><tr><th>Worker</th><th>Category</th><th className="num">Amount</th><th>Job</th><th>Receipt</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id} className="click">
                <td><div className="who-cell"><Avatar name={e.who} /><span className="cell-name" style={{ fontSize: 13 }}>{e.who}</span></div></td>
                <td className="cell-sub">{e.cat}</td>
                <td className="num cell-mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{e.amount}</td>
                <td className="cell-sub">{e.job}</td>
                <td>{e.receipt ? <span className="src-badge">📷 receipt</span> : <span className="cell-mono" style={{ color: "var(--red)" }}>missing</span>}</td>
                <td><Pill status={e.status} dotted /></td>
                <td className="num">{e.status[1] === "submitted" ? <div style={{ display: "flex", gap: 4, justifyContent: "flex-end" }}><button className="btn go">Approve</button><button className="btn">Decline</button></div> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════ DAYWORKS ═══════════
function DayworksPage({ setOpenJob }) {
  const W = window.BX.dayworks;
  const [f, setF] = useState("unsigned");
  const unsigned = W.filter((d) => d.status[1] === "unsigned");
  const rows = f === "all" ? W : f === "unsigned" ? unsigned : W.filter((d) => d.status[1] === "signed");
  const atRisk = unsigned.filter((d) => d.risk === "high");
  return (
    <>
      <PageHead title="Dayworks" sub={`Cross-job rollup · ${unsigned.length} unsigned · payment risk`}
        actions={<button className="btn">Export</button>} />
      <KpiStrip cells={[
        { lbl: "Unsigned", v: unsigned.length, sub: "awaiting client sign", tone: "warn" },
        { lbl: "At risk", v: atRisk.length, sub: "aging > 5 days", tone: "warn" },
        { lbl: "Unsigned value", v: "$3,488", sub: "exposure", tone: "amber" },
        { lbl: "Signed · 30d", v: W.filter((d) => d.status[1] === "signed").length, sub: "billable", tone: "ok" },
      ]} />
      <Seg value={f} onChange={setF} options={[["unsigned", "Unsigned", unsigned.length], ["signed", "Signed", W.filter((d) => d.status[1] === "signed").length], ["all", "All", W.length]]} />
      <div className="card">
        <table className="dtable">
          <thead><tr><th>Ref</th><th>Job</th><th>Description</th><th className="num">Hours</th><th className="num">Value</th><th>Status</th><th>Age</th></tr></thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} className="click" onClick={() => setOpenJob && setOpenJob(jobIdByName(d.job))}>
                <td className="cell-mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{d.id}</td>
                <td className="cell-sub">{d.job}</td>
                <td className="cell-sub" style={{ maxWidth: 280 }}>{d.desc}</td>
                <td className="num cell-mono">{d.hours}</td>
                <td className="num cell-mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{d.value}</td>
                <td><Pill status={d.status} dotted /></td>
                <td className="cell-mono" style={{ color: d.risk === "high" ? "var(--red)" : "var(--ink-3)" }}>{d.age}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// name → jobId helper so inbox rows can deep-link to the job hub
function jobIdByName(name) {
  const all = [...window.WS.jobs, ...window.BX.extraJobs];
  const j = all.find((x) => x.name === name);
  return j ? j.id : null;
}

Object.assign(window, { DefectsPage, ObservationsPage, MaterialsPage, ExpensesPage, DayworksPage, jobIdByName });
