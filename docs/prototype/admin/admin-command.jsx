// admin-command.jsx — BuhlOS Command Centre.
// "What needs me NOW": one focal status line + a tight decision-metric strip +
// the Needs-Attention inbox (a deterministic projection of the source registers)
// + Job risk + Close the day. Exports CommandCentre to window.

const SEV_ORDER = { critical: 0, warning: 1, info: 2 };
const SEV_TONE = { critical: "red", warning: "amber", info: "grey" };

function NeedsAttention({ items, setRoute, openJob }) {
  const [view, setView] = useState("all");

  // route an exception's next action to the surface that owns it
  const act = (e) => {
    const a = e.action;
    if (a === "Assign workers" || a === "Open builder") return openJob(e.jobId);
    if (a === "Approve & order" || a === "Place order") return setRoute("mats");
    if (a === "Open approvals") return setRoute("hours");
    if (a === "Open observation") return setRoute("obs");
    if (a === "Open defects") return setRoute("defects");
    return openJob(e.jobId);
  };

  const sorted = [...items].sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
  const shown = view === "action" ? sorted.filter((e) => e.sev !== "info") : sorted;
  const total = items.length;
  const crit = items.filter((e) => e.sev === "critical").length;
  const jobsAff = new Set(items.map((e) => e.job)).size;

  const Row = (e) => (
    <div className={"nax-row " + e.sev} key={e.id}>
      <span className="nax-rail" />
      <div className="nax-main">
        <div className="nax-meta">
          <span className="src-badge">{e.source}</span>
          <span className="nax-job">{e.job}</span>
          <span className="nax-age">{e.age}</span>
        </div>
        <div className="nax-title">
          <span className={"sev-dot " + SEV_TONE[e.sev]} />
          {e.title}
          {e.money && <span className="nax-money">{e.money}</span>}
          {e.count && <span className="nax-count">×{e.count}</span>}
        </div>
        <div className="nax-why">{e.why}</div>
      </div>
      <div className="nax-action">
        <button className="btn sm" onClick={() => act(e)}>{e.action} ›</button>
      </div>
    </div>
  );

  const grouped = (keyFn) => {
    const m = {};
    shown.forEach((e) => { (m[keyFn(e)] = m[keyFn(e)] || []).push(e); });
    return Object.keys(m).sort().map((k) => (
      <div className="nax-group" key={k}>
        <div className="nax-group-hdr"><h4>{k}</h4><span className="count">{m[k].length}</span></div>
        {m[k].map(Row)}
      </div>
    ));
  };

  return (
    <div className="card nax">
      <div className="card-hdr">
        <h3>Needs attention</h3>
        <span className="count">{total} open · <b style={{ color: "var(--red)" }}>{crit} critical</b> · {jobsAff} jobs</span>
      </div>
      <div className="nax-tabs">
        <div className="seg">
          {[["all", "All", total], ["action", "Needs action", items.filter((e) => e.sev !== "info").length],
            ["job", "By job", jobsAff], ["source", "By source", new Set(items.map((e) => e.source)).size]].map(([k, t, c]) => (
            <button key={k} className={view === k ? "on" : ""} onClick={() => setView(k)}>{t} <span className="c">{c}</span></button>
          ))}
        </div>
      </div>
      <div className="nax-list">
        {view === "job" ? grouped((e) => e.job)
          : view === "source" ? grouped((e) => e.source)
          : shown.map(Row)}
        {!shown.length && <div className="nax-allclear"><b>All clear.</b> Nothing in this view needs you right now.</div>}
      </div>
    </div>
  );
}

function CommandCentre({ setRoute, openJob, dayState }) {
  const D = window.OPS, B = window.BX;
  const [done, setDone] = useState({});
  const [showAllNow, setShowAllNow] = useState(false);

  const fire = dayState === "fire";
  const quiet = dayState === "quiet";
  const exceptions = quiet
    ? B.exceptions.filter((e) => e.sev !== "critical").slice(0, 4)
    : fire
      ? [
          { id: "x1", sev: "critical", source: "Safety", job: "100 Arthur", jobId: "P25-014",
            title: "Near-miss — edge protection removed, L5", why: "Kane Bell stood the L5 crew (4) down and reported it. Needs an instant call — stop-work + builder escalation.",
            age: "6m", action: "Open observation", state: "available" },
          { id: "x2", sev: "critical", source: "Blocker", job: "Carlton Hotel · stage 3", jobId: "CRH-2026-03",
            title: "No power to site — temp board tripped overnight", why: "Six on site with no power after overnight ingress. Dispatch a sparky or the day is lost.",
            age: "22m", action: "Open observation", state: "available" },
          ...B.exceptions,
        ]
      : B.exceptions;
  const crit = exceptions.filter((e) => e.sev === "critical").length;

  const risk = quiet ? D.variants.quiet.risk : fire ? D.variants.overload.risk : D.risk;

  // one focal sentence instead of a loud filled card
  const status = quiet
    ? { tone: "green", node: <>No crew-blocking decisions waiting — the desk is calm. Work the inbox at your own pace.</> }
    : fire
      ? { tone: "red", node: <><b>Site emergency in progress</b> — 2 crews stood down. Two critical calls need you right now.</> }
      : { tone: "red", node: <><b>{crit} decisions are holding crews up</b> right now — 100 Arthur L2 set-out and a no-crew job. Clear the critical items first.</> };

  // ── Today strip — the operational morning view (who's on the clock,
  //    hours logged today, pending approvals, jobs live). ──────────────
  const T = quiet ? { clk: 6, ros: 21, hrs: "38.0h", jobs: 6 }
          : fire  ? { clk: 19, ros: 21, hrs: "142.0h", jobs: 8 }
          :         { clk: 14, ros: 21, hrs: "96.5h", jobs: 8 };

  // ── Attention queues — count cards that go navy when they need you,
  //    calm/light when cleared. Mirrors /command-centre's queue grid. ──
  const Q_BASE = [
    { k: "proof", ic: "file-check",      label: "Proof to sign off",       n: 2,  sub: "2 tasks with site photos", cta: "Review proof",           empty: "Site photos against required evidence land here.", go: () => openJob("P25-014") },
    { k: "hours", ic: "clipboard-check", label: "Hours pending approval",  n: 5,  sub: "Oldest 1d ago",            cta: "Review approvals",       empty: "No timesheets waiting for you.",  go: () => setRoute("hours") },
    { k: "evid",  ic: "camera",          label: "Evidence to review",      n: 11, sub: "100 Arthur",               cta: "Open evidence",          empty: "No evidence waiting for review.", go: () => openJob("P25-014") },
    { k: "snags", ic: "alert-octagon",   label: "Snags needing attention", n: 7,  sub: "5 jobs affected",          cta: "Open snags",             empty: "Nice — no open snags right now.", go: () => setRoute("defects") },
    { k: "itp",   ic: "file-check",      label: "ITPs needing sign-off",   n: 3,  sub: "3 jobs affected",          cta: "Open ITP queue",         empty: "No ITPs waiting for sign-off.",   go: () => setRoute("qa") },
    { k: "obs",   ic: "inbox",           label: "Observations to action",  n: 3,  sub: "3 jobs affected",          cta: "Open inbox",             empty: "No field observations need action.", go: () => setRoute("obs") },
    { k: "rej",   ic: "rotate-ccw",      label: "Rejected hours",          n: 1,  sub: "Oldest 1d ago",           cta: "Review rejections",      empty: "No rejected timesheets.",         go: () => setRoute("hours") },
    { k: "miss",  ic: "user-x",          label: "Missing hours",           n: 1,  sub: "Ruth Strauss · Thu",       cta: "Chase missing hours",    empty: "Everyone's hours are in.",        go: () => setRoute("hours") },
    { k: "plan",  ic: "layers",          label: "Plan mismatches",         n: 1,  sub: "100 Arthur",              cta: "Open inbox",             empty: "No plan mismatches from site.",   go: () => setRoute("obs") },
    { k: "mats",  ic: "package",         label: "Material requests",       n: 2,  sub: "2 jobs affected",          cta: "Open material requests", empty: "No material requests waiting.",   go: () => setRoute("mats") },
  ];
  const SPIKE = { proof: 4, hours: 9, evid: 18, snags: 12, itp: 5, obs: 6, rej: 3, miss: 4, plan: 3, mats: 5 };
  const queues = Q_BASE.map((q) => ({ ...q, n: quiet ? 0 : fire ? SPIKE[q.k] : q.n }));
  const pending = queues.find((q) => q.k === "hours").n;
  const allClear = queues.every((q) => q.n === 0);

  const heroLine = quiet
    ? "The desk is calm — work the inbox at your own pace."
    : fire
      ? "Site emergency in progress — 2 crews stood down."
      : `${crit} ${crit === 1 ? "decision is" : "decisions are"} holding crews up right now.`;
  const NOW_ICON = { Safety: "shield-alert", Blocker: "alert-octagon", Hours: "clock", Materials: "package", Material: "package", Observation: "inbox", Defect: "alert-octagon", Defects: "alert-octagon", Crew: "users", Plan: "layers", ITP: "file-check" };
  const nowItems = [...exceptions].filter((e) => e.sev !== "info").sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev]);
  const iconFor = (e) => NOW_ICON[e.source] || (e.sev === "critical" ? "alert-octagon" : "alert-triangle");
  const routeFor = (e) => () => {
    const a = e.action;
    if (a === "Assign workers" || a === "Open builder") return openJob(e.jobId);
    if (a === "Approve & order" || a === "Place order") return setRoute("mats");
    if (a === "Open approvals") return setRoute("hours");
    if (a === "Open observation") return setRoute("obs");
    if (a === "Open defects") return setRoute("defects");
    return openJob(e.jobId);
  };
  const totalOpen = queues.reduce((s, q) => s + q.n, 0);
  const loadClass = (n) => (n >= 8 ? "hi" : n >= 4 ? "mid" : "lo");
  const shownNow = showAllNow ? nowItems : nowItems.slice(0, 4);

  return (
    <>
      <PageHead title="Command Centre" sub={`${D.now.day} ${D.now.date} · ${D.now.time} · ${D.now.week}`}
        actions={<><button className="btn">{D.now.siteDay}</button><button className="btn" onClick={() => setRoute("reports")}>Owner numbers →</button></>} />

      <div className={"cc-hero " + status.tone}>
        <div className="cc-hero-ic"><Ic n={fire ? "alert-octagon" : quiet ? "check-circle" : "alert-triangle"} s={24} /></div>
        <div className="cc-hero-b">
          <div className="cc-hero-k">State of play · {D.now.time}</div>
          <div className="cc-hero-h">{heroLine}</div>
        </div>
        <div className="cc-hero-tag">{quiet ? "CALM" : fire ? "ON FIRE" : "BUSY"}</div>
      </div>

      <div className="cc-pulse">
        <div className="cc-tile">
          <div className="cc-ring" style={{ "--p": Math.round((T.clk / T.ros) * 100) }}><span>{T.clk}<i>/{T.ros}</i></span></div>
          <div className="cc-tile-l">on the clock</div>
        </div>
        <div className="cc-tile">
          <div className="cc-tile-n">{T.hrs}</div>
          <div className="cc-tile-l">logged today</div>
        </div>
        <div className={"cc-tile" + (pending > 0 ? " amber" : "")}>
          <div className="cc-tile-n"><Ic n="clipboard-check" s={18} cls="cc-tile-ic" />{pending}</div>
          <div className="cc-tile-l">pending approvals</div>
        </div>
        <div className="cc-tile">
          <div className="cc-tile-n"><Ic n="briefcase" s={18} cls="cc-tile-ic" />{T.jobs}</div>
          <div className="cc-tile-l">jobs live today</div>
        </div>
      </div>

      <div className="cc-zone">
        <div className="cc-zone-h">Needs you now {nowItems.length > 0 && <span className="cc-zone-c">{nowItems.length}</span>}</div>
        {nowItems.length === 0 ? (
          <div className="cc-clear-big"><Ic n="check-circle" s={20} /> <span><b>All clear.</b> Nothing is holding a crew up right now.</span></div>
        ) : (
          <div className="cc-now">
            {shownNow.map((e) => (
              <div className={"cc-now-card " + e.sev} key={e.id} onClick={routeFor(e)}>
                <div className="cc-now-ic"><Ic n={iconFor(e)} s={18} /></div>
                <div className="cc-now-b">
                  <div className="cc-now-meta">{e.source} · {e.job} · {e.age}</div>
                  <div className="cc-now-t">{e.title}</div>
                </div>
                <Ic n="arrow-right" s={16} cls="cc-now-go" />
              </div>
            ))}
            {nowItems.length > 4 && (
              <button className="cc-now-more" onClick={() => setShowAllNow((s) => !s)}>{showAllNow ? "Show fewer" : `+${nowItems.length - 4} more need action`}</button>
            )}
          </div>
        )}
      </div>

      <div className="cc-zone">
        <div className="cc-zone-h">Open work {totalOpen > 0 && <span className="cc-zone-c">{totalOpen}</span>}</div>
        {allClear ? (
          <div className="cc-clear-big"><Ic n="check-circle" s={20} /> <span><b>No open work.</b> New submissions land here as they come in.</span></div>
        ) : (
          <div className="cc-work">
            {queues.filter((q) => q.n > 0).sort((a, b) => b.n - a.n).map((q) => (
              <div className={"cc-w " + loadClass(q.n)} key={q.k} onClick={q.go}>
                <Ic n={q.ic} s={18} cls="cc-w-ic" />
                <div className="cc-w-n">{q.n}</div>
                <div className="cc-w-l">{q.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

Object.assign(window, { CommandCentre, NeedsAttention });
