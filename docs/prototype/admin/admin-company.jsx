// admin-company.jsx — Quotes · Reports (owner numbers) · QA status ·
// ITP templates · Notification settings. Exports the pages to window.

// ════════════════════════════════════════════════════════════ QUOTES ═════════
// Admin-only quote drawer — per-line cost + internal margin (private; the
// client copy shows the sell price only).
function QuoteDrawer({ q, onClose }) {
  const data = (window.BX.quoteLines || {})[q.id];
  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-hd">
          <div className="drawer-id"><div><b>{q.name}</b><small>{q.id} · {q.client}</small></div></div>
          <button className="btn" onClick={onClose}>Close ✕</button>
        </div>
        <div className="drawer-body">
          <div className="card">
            <div className="set-rows">
              <div className="sr"><span className="sk">Status</span><span className="sv"><Pill status={q.status} dotted /></span></div>
              <div className="sr"><span className="sk">Owner</span><span className="sv">{q.owner}</span></div>
              <div className="sr"><span className="sk">Sell price</span><span className="sv" style={{ fontWeight: 700 }}>{q.value}</span></div>
              <div className="sr"><span className="sk">Win likelihood</span><span className="sv" style={{ fontWeight: 400 }}>{q.win}</span></div>
            </div>
          </div>
          <div className="drawer-conf">
            <div className="conf-hd"><Ic n="lock" s={13} /> Cost &amp; internal margin <span className="conf-tag">admin only · confidential</span></div>
            {data ? (
              <>
                <div className="qmar-sum">
                  <div className="qmar-cell"><div className="qmar-l">Sell</div><div className="qmar-v">{data.summary.sell}</div></div>
                  <div className="qmar-cell"><div className="qmar-l">Cost</div><div className="qmar-v">{data.summary.cost}</div></div>
                  <div className="qmar-cell"><div className="qmar-l">Margin</div><div className="qmar-v ok">{data.summary.marginPct}</div><div className="qmar-s">{data.summary.marginVal}</div></div>
                </div>
                <table className="dtable conf-table">
                  <thead><tr><th>Line item</th><th className="num">Sell</th><th className="num">Cost</th><th className="num">Margin</th></tr></thead>
                  <tbody>
                    {data.lines.map((l, i) => (
                      <tr key={i}>
                        <td><div className="cell-name" style={{ fontSize: 12.5 }}>{l.item}<small>{l.qty}</small></div></td>
                        <td className="num cell-mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{l.sell}</td>
                        <td className="num cell-mono">{l.cost}</td>
                        <td className="num cell-mono" style={{ color: "var(--green)", fontWeight: 600 }}>{l.margin}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : <div className="conf-empty">Per-line cost &amp; margin are authored in the quote builder. Open {q.id} to price its lines.</div>}
            <div className="conf-foot">Cost and internal margin are admin-only — the client copy shows the sell price only.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function QuotesPage() {
  const Q = window.WS.quotes;
  const [sel, setSel] = useState(null);
  const pipeline = Q.filter((q) => !["won", "lost"].includes(q.status[1])).length;
  return (
    <>
      <PageHead title="Quotes" sub={`${pipeline} in pipeline · 1 ready to send`}
        actions={<><button className="btn"><Ic n="file-spreadsheet" s={13} /> Import BOQ</button><button className="btn">Rate presets</button><button className="btn primary">+ New quote</button></>} />
      <div className="kpi-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <div className="kpi"><div className="lbl">Pipeline value</div><div className="num">$257k</div><div className="delta">3 open quotes</div></div>
        <div className="kpi"><div className="lbl">Ready to send</div><div className="num amber">$48.2k</div><div className="delta">Hilton · 1 day old</div></div>
        <div className="kpi"><div className="lbl">Won · May</div><div className="num ok">$214k</div><div className="delta">Prospect townhouses</div></div>
        <div className="kpi"><div className="lbl">Win rate · 90d</div><div className="num">61%</div><div className="delta">11 of 18</div></div>
      </div>
      <div className="card">
        <table className="dtable">
          <thead><tr><th>Quote</th><th>Client</th><th className="num">Value</th><th>Owner</th><th>Status</th><th className="num">Win</th></tr></thead>
          <tbody>
            {Q.map((q) => (
              <tr key={q.id} className="click" onClick={() => setSel(q)}>
                <td><div className="cell-name" style={{ fontSize: 13 }}>{q.name}<small>{q.id} · {q.age}</small></div></td>
                <td className="cell-sub">{q.client}</td>
                <td className="num cell-mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{q.value}</td>
                <td className="cell-mono">{q.owner}</td>
                <td><Pill status={q.status} dotted /></td>
                <td className="num cell-mono">{q.win}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sel && <QuoteDrawer q={sel} onClose={() => setSel(null)} />}
    </>
  );
}

// ═══════════════════════════════════════════════ REPORTS · owner numbers ══════
function ReportsPage({ setRoute, setOpenJob }) {
  const N = window.BX.ownerNumbers;
  const months = [["Jan", 188, 220], ["Feb", 214, 220], ["Mar", 246, 230], ["Apr", 272, 250], ["May", 231, 260]];
  const max = 300;
  const drill = (d) => { if (d === "jobs") setOpenJob("CRH-2026-03"); else setRoute(d); };
  return (
    <>
      <PageHead title="Reports" sub="The six numbers · this week · all jobs"
        actions={<><button className="btn">Period</button><button className="btn primary">Export PDF</button></>} />
      <div className="page-note">How the business is <b>trending</b> — six numbers, each defined in one place, each drilling into the records behind it. The Command Centre is what needs you <b>now</b>; this is the direction of travel.</div>
      <div className="own-grid">
        {N.map((n) => (
          <div className={"own-tile " + n.state} key={n.id} onClick={() => drill(n.drill)}>
            <span className="own-rail" />
            <div className="own-lbl">{n.label}</div>
            <div className="own-val">{n.value}</div>
            <div className="own-trend">{n.trend}</div>
            <div className="own-note">{n.note}</div>
            <div className="own-drill">View records →</div>
          </div>
        ))}
      </div>
      <div className="card">
        <div className="card-hdr"><h3>Invoiced vs target · $k / month</h3><span className="count">trailing 5</span></div>
        <div className="chart">
          {months.map(([m, inv, tgt]) => (
            <div className="col" key={m}>
              <div className="stack" style={{ height: Math.round((inv / max) * 150) + "px", background: "transparent" }}>
                <i style={{ height: "100%", background: inv >= tgt ? "var(--green)" : "var(--amber)" }} />
              </div>
              <div className="cl">{m}</div>
            </div>
          ))}
        </div>
        <div className="legend">
          <span><i style={{ background: "var(--green)" }} />at / above target</span>
          <span><i style={{ background: "var(--amber)" }} />below target</span>
          <span style={{ marginLeft: "auto", color: "var(--ink-3)" }}>target band 220–260 / mo</span>
        </div>
      </div>
    </>
  );
}

// ════════════════════════════════════════════════════════════ QA STATUS ══════
function QaPage({ setOpenJob }) {
  const QA = window.BX.qa;
  const tot = QA.reduce((a, j) => a + j.total, 0);
  const signed = QA.reduce((a, j) => a + j.signed, 0);
  const review = QA.reduce((a, j) => a + j.review, 0);
  const open = QA.reduce((a, j) => a + j.open, 0);
  return (
    <>
      <PageHead title="QA status" sub={`Cross-job ITP rollup · ${review} need sign-off · read-only`}
        actions={<button className="btn">Export QA pack</button>} />
      <div className="kpi-row" style={{ gridTemplateColumns: "repeat(4,1fr)" }}>
        <div className="kpi"><div className="lbl">ITPs total</div><div className="num">{tot}</div><div className="delta">across {QA.length} jobs</div></div>
        <div className="kpi"><div className="lbl">Signed off</div><div className="num ok">{signed}</div><div className="delta">{Math.round((signed / tot) * 100)}% complete</div></div>
        <div className="kpi"><div className="lbl">Need review</div><div className="num amber">{review}</div><div className="delta">office sign-off</div></div>
        <div className="kpi"><div className="lbl">Open on site</div><div className="num">{open}</div><div className="delta">in progress</div></div>
      </div>
      <div className="card">
        <table className="dtable">
          <thead><tr><th>Job</th><th className="num">ITPs</th><th className="num">Signed</th><th className="num">Review</th><th className="num">Open</th><th>Completion</th><th></th></tr></thead>
          <tbody>
            {QA.map((j) => (
              <tr key={j.jobId} className="click" onClick={() => setOpenJob(j.jobId)}>
                <td><div className="cell-name" style={{ fontSize: 13 }}>{j.job}<small>{j.jobId}</small></div></td>
                <td className="num cell-mono">{j.total}</td>
                <td className="num cell-mono" style={{ color: "var(--green)" }}>{j.signed}</td>
                <td className="num cell-mono" style={{ color: j.review ? "var(--amber)" : "var(--ink-3)", fontWeight: j.review ? 600 : 400 }}>{j.review || "—"}</td>
                <td className="num cell-mono">{j.open}</td>
                <td><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Bar pct={j.pct} tone={j.pct === 1 ? "" : j.pct < 0.4 ? "navy" : "amber"} /><span className="cell-mono">{Math.round(j.pct * 100)}%</span></div></td>
                <td className="num">{j.review ? <button className="btn">Review</button> : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════ ITP TEMPLATES ═══════
function ItpTemplatesPage() {
  const T = window.BX.itpTemplates;
  return (
    <>
      <PageHead title="ITP templates" sub={`${T.length} templates · the library jobs draw from`}
        actions={<button className="btn primary">+ New template</button>} />
      <div className="page-note">Reusable inspection & test plans. Each job instantiates a template into a live ITP its crew fills out on Phil; the office reviews and countersigns. Edit a template here and new jobs pick it up.</div>
      <div className="card">
        <table className="dtable">
          <thead><tr><th>Template</th><th>Discipline</th><th className="num">Rows</th><th className="num">Used on</th><th>Updated</th><th></th></tr></thead>
          <tbody>
            {T.map((t) => (
              <tr key={t.id} className="click">
                <td><div className="cell-name" style={{ fontSize: 13 }}>{t.name}<small>{t.id}</small></div></td>
                <td><span className="src-badge">{t.discipline}</span></td>
                <td className="num cell-mono">{t.rows}</td>
                <td className="num cell-mono">{t.usedOn} jobs</td>
                <td className="cell-mono" style={{ color: "var(--ink-3)" }}>{t.updated}</td>
                <td className="num"><button className="btn">Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════ NOTIFICATION SETTINGS ════════
function SettingsPage() {
  const c = window.WS.company;
  const [prefs, setPrefs] = useState(() => window.BX.notifPrefs.map((p) => p.on));
  return (
    <>
      <PageHead title="Notification settings" sub="What BuhlOS tells you about — per type" />
      <div className="set-grid">
        <div className="page-note" style={{ paddingTop: 4 }}>The notify engine consults these at delivery — flip one off and that type stops paging you. Hours, defects and overrun stay on by default. Granular per-job routing lands in a later pass.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="card">
            <div className="card-hdr"><h3>Notify me when…</h3></div>
            <div className="set-rows">
              {window.BX.notifPrefs.map((p, i) => (
                <div className="sr" key={p.k}>
                  <div className="sv">{p.label}<small>{p.desc}</small></div>
                  <div className={"mini-toggle toggle-pill" + (prefs[i] ? " on" : "")} onClick={() => setPrefs((s) => s.map((v, j) => (j === i ? !v : v)))}><i /></div>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <div className="card-hdr"><h3>Company</h3></div>
            <div className="set-rows">
              <div className="sr"><span className="sk">Business name</span><span className="sv">{c.name}</span></div>
              <div className="sr"><span className="sk">ABN</span><span className="sv">{c.abn}</span></div>
              <div className="sr"><span className="sk">Licence</span><span className="sv">{c.licence}</span></div>
              <div className="sr"><span className="sk">Location</span><span className="sv">{c.city}</span></div>
            </div>
          </div>
          <div className="card">
            <div className="card-hdr"><h3>Surfaces</h3></div>
            <a className="link-card" href="Phil.html" style={{ border: 0, borderRadius: 0 }}>
              <div className="lc-ico" style={{ background: "var(--yellow)", color: "var(--yellow-ink)" }}>P</div>
              <div className="lc-b">Phil · field app<small>Preview the mobile app your crew uses on site</small></div>
              <span className="arr">→</span>
            </a>
          </div>
        </div>
      </div>
    </>
  );
}

Object.assign(window, { QuotesPage, ReportsPage, QaPage, ItpTemplatesPage, SettingsPage });
