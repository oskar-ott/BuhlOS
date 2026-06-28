// admin-hours.jsx — Hours: the weekly pay-run approval (the office ritual).
// One row per worker per week; seven-day strip shows the shape of the week;
// flagged weeks open an ask-on-Phil composer + query thread. Exports HoursPage.

const money = (n) => "$" + Math.round(n).toLocaleString("en-AU");
const sumWeek = (w) => w.reduce((a, d) => a + (d.s === "none" || d.s === "off" ? 0 : d.h), 0);

const CANNED_REPLY = {
  "Kane Bell": "Carlton was short — covered for Dwyer Thu & Fri to keep the riser on programme. Both genuine.",
  "Ruth Strauss": "Yep, on site Thursday 7.5h — phone died so it didn't sync. Sorry!",
};

function WeekRow({ c, state, onApprove, onUndo, onAsk, onResolve }) {
  const H = window.WS.hours;
  const total = sumWeek(c.week);
  const q = state.query;
  const approved = state.approved;
  const needsLook = !!c.note && !(q && q.status === "answered");
  const [asking, setAsking] = useState(false);
  const [draft, setDraft] = useState(c.ask || "");
  const chips = ["Confirm the hours", "Which job?", "Why the long days?", "Did you work that day?"];

  // per-job split — a worker's week can span multiple jobs, and a single DAY can
  // be split across jobs too (day.parts: [{ j, h }]). dayParts() normalises both.
  const PAL = ["#2a6fdb", "#1f8a5b", "#d18b1c", "#7c5cff"];
  const dayParts = (d) => (d.s === "off" || d.s === "none") ? []
    : d.parts ? d.parts.map((p) => ({ j: p.j, h: p.h })) : [{ j: d.j || c.job, h: d.h }];
  const allParts = c.week.flatMap(dayParts);
  const jobsInWeek = [...new Set(allParts.map((p) => p.j))];
  const split = jobsInWeek.length > 1;
  const jobColor = (jb) => PAL[Math.max(jobsInWeek.indexOf(jb), 0) % PAL.length];
  const dayFill = (parts) => {
    if (parts.length <= 1) return jobColor(parts[0] ? parts[0].j : c.job);
    const tot = parts.reduce((a, p) => a + p.h, 0) || 1;
    let acc = 0;
    const stops = parts.map((p) => { const s = acc / tot * 100; acc += p.h; return jobColor(p.j) + " " + s + "% " + (acc / tot * 100) + "%"; });
    return "linear-gradient(90deg, " + stops.join(", ") + ")";
  };
  const breakdown = jobsInWeek.map((jb) => {
    const hrs = allParts.filter((p) => p.j === jb).reduce((a, p) => a + p.h, 0);
    return { job: jb, hrs, val: hrs * c.rate };
  });

  return (
    <div className={"hwk" + (approved ? " approved" : needsLook ? " look" : "")}>
      <div className="hwk-main">
        <div className="hwk-who">
          <Avatar name={c.who} tone={approved ? "" : needsLook ? "amber" : ""} />
          <div className="hwk-who-b">
            <div className="hwk-name">{c.who}</div>
            <div className="hwk-sub">
              <span className={"hwk-job" + (split ? " multi" : "")}>{split ? jobsInWeek.length + " jobs" : c.job}</span>
              <span className="hwk-role"> · {c.role}</span>
            </div>
          </div>
        </div>
        <div className="hwk-strip">
          {c.week.map((d, i) => {
            const parts = dayParts(d);
            const tip = parts.length ? " · " + parts.map((p) => p.j + " " + p.h + "h").join(" · ") : "";
            return (
              <div key={i} className={"hwk-day " + d.s + (parts.length > 1 ? " daysplit" : "")} title={H.days[i] + " " + H.dates[i] + tip}>
                <span className="d">{H.days[i]}</span>
                <span className="h">{d.s === "none" ? "—" : d.s === "off" ? "·" : d.h}</span>
                {parts.length > 1 && <span className="hwk-day-split">÷</span>}
                {split && parts.length > 0 && <span className="hwk-day-bar" style={{ background: dayFill(parts) }} />}
              </div>
            );
          })}
        </div>
        <div className="hwk-tot">
          <div className="th">{total}<small>h</small></div>
          <div className="tv">{money(total * c.rate)}</div>
        </div>
        <div className="hwk-act">
          {approved ? (
            <>
              <span className="pill green"><span className="dot" />approved</span>
              <button className="btn ghost hwk-undo" onClick={onUndo}>Undo</button>
            </>
          ) : needsLook ? (
            <>
              <span className={"pill " + c.note[0]}><span className={"dot " + (c.note[0] === "green" ? "" : c.note[0])} />needs a look</span>
              <div className="hwk-btns">
                {!q && <button className="btn" onClick={() => setAsking(true)}>Ask</button>}
                <button className="btn go" onClick={onApprove}>Approve anyway</button>
              </div>
            </>
          ) : (
            <button className="btn go hwk-approve" onClick={onApprove}>Approve week</button>
          )}
        </div>
      </div>

      {split && (
        <div className="hwk-split">
          <span className="hwk-split-lbl">Split this week</span>
          {breakdown.map((b) => (
            <span className="hwk-split-chip" key={b.job}>
              <i style={{ background: jobColor(b.job) }} />{b.job}<b>{b.hrs}h</b><span className="hwk-split-val">{money(b.val)}</span>
            </span>
          ))}
        </div>
      )}

      {(needsLook || q) && !approved && (
        <div className="hwk-exp">
          {c.note && (
            <div className="hwk-reason"><span className={"hwk-reason-dot " + c.note[0]} /><span>{c.note[1]}</span></div>
          )}
          {asking && !q && (
            <div className="hwk-ask">
              <div className="hwk-ask-hd">Ask {c.who.split(" ")[0]} on Phil</div>
              <div className="hwk-chips">
                {chips.map((ch) => <button key={ch} className="hwk-chip" onClick={() => setDraft(ch)}>{ch}</button>)}
              </div>
              <textarea className="hwk-ta" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Type a question…" />
              <div className="hwk-ask-act">
                <button className="btn ghost" onClick={() => setAsking(false)}>Cancel</button>
                <button className="btn primary" disabled={!draft.trim()} onClick={() => { setAsking(false); onAsk(draft.trim()); }}>Send to Phil →</button>
              </div>
            </div>
          )}
          {q && (
            <div className="hwk-thread">
              <div className="hwk-msg out"><span className="hwk-msg-from">You asked</span><span className="hwk-msg-tx">{q.text}</span></div>
              {q.status === "answered" ? (
                <div className="hwk-msg in"><span className="hwk-msg-from">{c.who} replied</span><span className="hwk-msg-tx">{q.reply}</span></div>
              ) : (
                <div className="hwk-pending"><span className="hwk-spin" /> Sent to Phil · awaiting reply<button className="hwk-sim" onClick={onResolve}>simulate reply</button></div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HoursPage() {
  const H = window.WS.hours;
  const [mode, setMode] = useState("week");
  const [rows, setRows] = useState(() => H.crew.map(() => ({ approved: false, query: undefined })));
  const setRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const approvedCount = rows.filter((r) => r.approved).length;
  const total = H.crew.length;
  const cleanRemaining = H.crew.map((c, i) => ({ c, i })).filter(({ c, i }) => !c.note && !rows[i].approved);
  const totalHrs = H.crew.reduce((a, c) => a + sumWeek(c.week), 0);
  const totalVal = H.crew.reduce((a, c) => a + sumWeek(c.week) * c.rate, 0);
  const needLook = H.crew.filter((c, i) => c.note && !(rows[i].query && rows[i].query.status === "answered")).length;
  const approveAllClean = () => setRows((rs) => rs.map((r, i) => (H.crew[i].note ? r : { ...r, approved: true })));

  return (
    <>
      <PageHead title="Hours" sub={`${H.week} · ${H.range} · pay run ${H.payday}`}
        actions={<><button className="btn">Weekly closeout</button><button className="btn">Export CSV</button></>} />
      <div className="seg-row" style={{ marginBottom: 2 }}>
        <div className="seg">
          <button className={mode === "week" ? "on" : ""} onClick={() => setMode("week")}>Approvals <span className="c">{needLook || total}</span></button>
          <button className={mode === "history" ? "on" : ""} onClick={() => setMode("history")}>History <span className="c">{H.history.length}</span></button>
        </div>
      </div>

      {mode === "week" ? (
        <>
          <div className="hrs-payday">
            <div className="hrs-payday-l">
              <div className="hrs-payday-eyebrow">Pay run · {H.payday}</div>
              <h2>{H.week} ready to approve</h2>
              <div className="hrs-payday-meta">
                <span><b>{totalHrs}h</b> logged</span>
                <span><b>{money(totalVal)}</b> labour</span>
                <span><b>{total}</b> crew</span>
                <span className={needLook ? "warn" : ""}><b>{needLook}</b> need a look</span>
              </div>
            </div>
            <div className="hrs-payday-r">
              <div className="hrs-prog">
                <div className="hrs-prog-bar"><i style={{ width: (approvedCount / total) * 100 + "%" }} /></div>
                <span className="hrs-prog-tx">{approvedCount} of {total} approved</span>
              </div>
              {approvedCount === total ? (
                <button className="btn primary lg" disabled>All approved ✓</button>
              ) : (
                <button className="btn primary lg" disabled={!cleanRemaining.length} onClick={approveAllClean}>
                  {cleanRemaining.length ? `Approve all clean · ${cleanRemaining.length}` : "Clean weeks done — clear the flags"}
                </button>
              )}
            </div>
          </div>

          <div className="hwk-list card">
            {H.crew.map((c, i) => (
              <WeekRow key={i} c={c} state={rows[i]}
                onApprove={() => setRow(i, { approved: true })}
                onUndo={() => setRow(i, { approved: false })}
                onAsk={(text) => setRow(i, { query: { text, status: "sent" } })}
                onResolve={() => setRow(i, { query: { ...rows[i].query, status: "answered", reply: CANNED_REPLY[c.who] || "Confirmed — all good." } })}
              />
            ))}
          </div>

          <div className="hrs-foot">
            Approving a week sends it to the {H.payday} payroll export. Workers can still see their hours in Phil; only the office approves.
          </div>
        </>
      ) : <HoursHistory H={H} />}
    </>
  );
}

function HoursHistory({ H }) {
  const [q, setQ] = useState("");
  const [who, setWho] = useState("all");
  const people = ["all", ...Array.from(new Set(H.history.map((r) => r.who)))];
  const rows = H.history.filter((r) => {
    if (who !== "all" && r.who !== who) return false;
    if (!q.trim()) return true;
    return (r.who + " " + r.job + " " + r.week + " " + r.range).toLowerCase().includes(q.trim().toLowerCase());
  });
  const totHrs = rows.reduce((a, r) => a + r.hrs, 0);
  const totVal = rows.reduce((a, r) => a + r.value, 0);

  return (
    <>
      <div className="hrs-hist-bar">
        <div className="hrs-search">
          <span className="hrs-search-ic">⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search hours — worker, job or week…" />
          {q && <button className="hrs-search-x" onClick={() => setQ("")}>✕</button>}
        </div>
        <div className="hrs-who-chips">
          {people.map((p) => <button key={p} className={"hwk-chip" + (who === p ? " on" : "")} onClick={() => setWho(p)}>{p === "all" ? "Everyone" : p.split(" ")[0]}</button>)}
        </div>
      </div>
      <div className="hrs-hist-sum">
        <span><b>{rows.length}</b> {rows.length === 1 ? "record" : "records"}</span>
        <span><b>{totHrs}h</b> total</span>
        <span><b>{money(totVal)}</b> paid</span>
      </div>
      <div className="card">
        <table className="dtable">
          <thead><tr><th>Week</th><th>Worker</th><th>Job</th><th className="num">Hours</th><th className="num">Value</th><th>Status</th><th>Approved</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="click">
                <td><div className="cell-name" style={{ fontSize: 13 }}>{r.week}<small>{r.range}</small></div></td>
                <td><div className="who-cell"><Avatar name={r.who} /><span className="cell-name" style={{ fontSize: 13 }}>{r.who}</span></div></td>
                <td className="cell-sub">{r.job}</td>
                <td className="num cell-mono" style={{ fontWeight: 600, color: "var(--ink)" }}>{r.hrs}</td>
                <td className="num cell-mono">{money(r.value)}</td>
                <td><Pill status={r.status} dotted /></td>
                <td className="cell-mono" style={{ color: "var(--ink-3)" }}>{r.by.split(" ")[0]} · {r.on}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={7} style={{ textAlign: "center", padding: "32px 16px", color: "var(--ink-3)", fontSize: 13 }}>No hours match “{q}”.</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

Object.assign(window, { HoursPage });
