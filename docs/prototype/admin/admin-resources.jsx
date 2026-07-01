// admin-resources.jsx — People (crew register) + Gear (test & tag register).
// Exports PeoplePage, GearPage to window.

// Admin-only employee drawer — surfaces the confidential, effective-dated
// cost-rate history (private; never shown in the general list).
function PersonDrawer({ p, onClose }) {
  const rates = (window.BX.costRates || {})[p.name] || [];
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-hd">
          <div className="drawer-id"><Avatar name={p.name} tone={p.status[1] === "invited" ? "yellow" : ""} /><div><b>{p.name}</b><small>{p.role}</small></div></div>
          <button className="btn" onClick={onClose}>Close ✕</button>
        </div>
        <div className="drawer-body">
          <div className="card">
            <div className="set-rows">
              <div className="sr"><span className="sk">Surface</span><span className="sv"><span className="src-badge">{p.surface}</span></span></div>
              <div className="sr"><span className="sk">Mobile</span><span className="sv mono">{p.mobile}</span></div>
              <div className="sr"><span className="sk">Status</span><span className="sv"><Pill status={p.status} dotted /></span></div>
              <div className="sr"><span className="sk">Last activity</span><span className="sv" style={{ fontWeight: 400 }}>{p.last}</span></div>
            </div>
          </div>
          <div className="drawer-conf">
            <div className="conf-hd"><Ic n="lock" s={13} /> Cost rates <span className="conf-tag">admin only · confidential</span></div>
            {rates.length ? (
              <table className="dtable conf-table">
                <thead><tr><th>Effective from</th><th className="num">Cost / hr</th><th className="num">Charge-out</th><th>Reason</th></tr></thead>
                <tbody>
                  {rates.map((r, i) => (
                    <tr key={i}>
                      <td className="cell-mono">{r.from}{i === 0 && <span className="cur"> · current</span>}</td>
                      <td className="num cell-mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{r.cost}</td>
                      <td className="num cell-mono">{r.charge}</td>
                      <td className="cell-sub" style={{ fontSize: 11.5 }}>{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="conf-empty">No cost-rate history on file for {p.name.split(" ")[0]}.</div>}
            <div className="conf-foot">Cost rates are private to admins and never appear in shared lists or exports.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PeoplePage() {
  const P = window.WS.people;
  const [sel, setSel] = useState(null);
  const onSite = P.filter((p) => p.status[1] === "on site").length;
  const office = P.filter((p) => p.surface === "BuhlOS").length;
  return (
    <>
      <PageHead title="Employees" sub={`${P.length} employees · ${P.filter((p) => p.status[1] === "invited").length} pending setup`}
        actions={<><button className="btn">Export</button><button className="btn primary">+ Add employee</button></>} />
      <div className="kpi-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <div className="kpi"><div className="lbl">On site now</div><div className="num ok">{onSite}</div><div className="delta">across 4 jobs</div></div>
        <div className="kpi"><div className="lbl">Office · BuhlOS</div><div className="num">{office}</div><div className="delta">admin + payroll</div></div>
        <div className="kpi"><div className="lbl">Field · Phil</div><div className="num">{P.length - office}</div><div className="delta">tradies + apprentices</div></div>
        <div className="kpi"><div className="lbl">Pending setup</div><div className="num amber">{P.filter((p) => p.status[1] === "invited").length}</div><div className="delta">invite sent</div></div>
      </div>
      <div className="card">
        <table className="dtable">
          <thead><tr><th>Name</th><th>Role</th><th>Surface</th><th>Mobile</th><th>Status</th><th>Last activity</th></tr></thead>
          <tbody>
            {P.map((p, i) => (
              <tr key={i} className="click" onClick={() => setSel(p)}>
                <td><div className="who-cell"><Avatar name={p.name} tone={p.status[1] === "invited" ? "yellow" : ""} /><span className="cell-name">{p.name}</span></div></td>
                <td className="cell-sub">{p.role}</td>
                <td><span className="src-badge">{p.surface}</span></td>
                <td className="cell-mono">{p.mobile}</td>
                <td><Pill status={p.status} dotted /></td>
                <td className="cell-mono" style={{ color: "var(--ink-3)" }}>{p.last}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sel && <PersonDrawer p={sel} onClose={() => setSel(null)} />}
    </>
  );
}

function GearPage() {
  const G = window.WS.gear;
  const [filter, setFilter] = useState("all");
  const issues = G.filter((g) => g.status[0] !== "green");
  const rows = filter === "all" ? G : filter === "issue" ? issues : G.filter((g) => g.holder === "Store");
  return (
    <>
      <PageHead title="Gear" sub={`${G.length} tracked · ${issues.length} need attention`}
        actions={<><button className="btn">Scan in</button><button className="btn primary">+ Register gear</button></>} />
      <div className="kpi-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <div className="kpi"><div className="lbl">In use</div><div className="num">{G.filter((g) => g.status[1] === "in use").length}</div><div className="delta">issued to crew</div></div>
        <div className="kpi"><div className="lbl">Quarantined</div><div className="num warn">{G.filter((g) => g.status[0] === "red").length}</div><div className="delta">test tag expired</div></div>
        <div className="kpi"><div className="lbl">Cal due soon</div><div className="num amber">{G.filter((g) => g.status[1].startsWith("cal")).length}</div><div className="delta">test gear</div></div>
        <div className="kpi"><div className="lbl">Available</div><div className="num ok">{G.filter((g) => g.status[1] === "available").length}</div><div className="delta">in store</div></div>
      </div>
      <div className="seg-row">
        <div className="seg">
          <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All <span className="c">{G.length}</span></button>
          <button className={filter === "issue" ? "on" : ""} onClick={() => setFilter("issue")}>Needs action <span className="c">{issues.length}</span></button>
          <button className={filter === "store" ? "on" : ""} onClick={() => setFilter("store")}>In store <span className="c">{G.filter((g) => g.holder === "Store").length}</span></button>
        </div>
      </div>
      <div className="card">
        <table className="dtable">
          <thead><tr><th>Asset</th><th>Category</th><th>Held by</th><th>Status</th><th>Note</th><th></th></tr></thead>
          <tbody>
            {rows.map((g) => (
              <tr key={g.id} className="click">
                <td><div className="cell-name" style={{ fontSize: 13 }}>{g.label}<small>{g.id}</small></div></td>
                <td className="cell-sub">{g.cat}</td>
                <td className="cell-mono">{g.holder}</td>
                <td><Pill status={g.status} dotted /></td>
                <td className="cell-sub" style={{ fontSize: 12, color: "var(--ink-3)" }}>{g.note}</td>
                <td className="num">{g.status[0] === "red" ? <button className="btn">Quarantine</button> : g.status[0] === "amber" ? <button className="btn">Book test</button> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

Object.assign(window, { PeoplePage, GearPage });
