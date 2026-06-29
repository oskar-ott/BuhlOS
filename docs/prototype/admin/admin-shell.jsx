// admin-shell.jsx — BuhlOS Admin chrome + shared primitives.
// Exports to window: initials, NAV, Pill, Bar, Dot, Avatar, SevBadge, SourceBadge,
// ActionBadge, PageHead, Sidebar, Topbar, GlobalSearch, counts.

const { useState, useMemo, useEffect, useRef } = React;

const initials = (name) =>
  (name || "").split(/[\s·]+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join("").toUpperCase();

// ── Live counts derived from the registers (drive sidebar badges) ─────────────
function counts() {
  const B = window.BX, W = window.WS;
  return {
    cc: B.exceptions.filter((e) => e.sev === "critical").length,
    jobs: W.jobs.length,
    hours: W.hours.anomalies,
    defects: B.defects.filter((d) => d.status === "open").length,
    obs: B.observations.filter((o) => o.priority[1] === "needs action").length,
    mats: B.materials.filter((m) => m.status[1] === "requested").length,
    exp: B.expenses.filter((e) => e.status[1] === "submitted").length,
    daywork: B.dayworks.filter((d) => d.status[1] === "unsigned").length,
    people: W.people.length,
    gear: W.gear.filter((g) => g.status[0] !== "green").length,
    quotes: W.quotes.filter((q) => q.status[1] === "ready to send" || q.status[1] === "with client").length,
    qa: B.qa.reduce((a, j) => a + j.review, 0),
  };
}

// nav config — groups + items, mirroring birdwood/src/components/admin/nav.ts
// (the single source of truth for the office IA). ic = lucide icon name;
// badge:true shows the count as a red attention pip when > 0.
const NAV = [
  { sec: "Today" },
  { k: "cc",       t: "Command centre",   ic: "layout-grid",     c: (x) => x.cc, badge: true },
  { k: "obs",      t: "From site",        ic: "inbox",           c: (x) => x.obs, badge: true },
  { k: "mats",     t: "Material requests", ic: "package",        c: (x) => x.mats },
  { k: "exp",      t: "Expenses",         ic: "wallet",          c: (x) => x.exp },
  { sec: "Jobs" },
  { k: "jobs",     t: "Jobs",             ic: "briefcase",       c: (x) => x.jobs },
  { k: "quotes",   t: "Quotes",           ic: "calculator",      c: (x) => x.quotes },
  { k: "defects",  t: "Defects",          ic: "bug",             c: (x) => x.defects, badge: true },
  { k: "itp",      t: "ITP templates",    ic: "clipboard-list" },
  { k: "qa",       t: "QA status",        ic: "clipboard-check", c: (x) => x.qa },
  { k: "daywork",  t: "Dayworks",         ic: "receipt",         c: (x) => x.daywork, badge: true },
  { sec: "Hours" },
  { k: "hours",    t: "Hours",            ic: "clock",           c: (x) => x.hours, badge: true },
  { sec: "People & gear" },
  { k: "people",   t: "Employees",        ic: "users",           c: (x) => x.people },
  { k: "gear",     t: "Gear",             ic: "wrench",          c: (x) => x.gear, badge: true },
  { sec: "Company" },
  { k: "reports",  t: "Reports",          ic: "bar-chart" },
];

// breadcrumb group label per route key
const GROUP = {
  cc: "Today", obs: "Today", mats: "Today", exp: "Today",
  jobs: "Jobs", quotes: "Jobs", defects: "Jobs", itp: "Jobs", qa: "Jobs", daywork: "Jobs",
  hours: "Hours",
  people: "People & gear", gear: "People & gear",
  reports: "Company",
  settings: "Settings",
};
const TITLE = {
  cc: "Command Centre", jobs: "Jobs", hours: "Hours", defects: "Defects",
  obs: "From site", mats: "Material requests", exp: "Expenses", daywork: "Dayworks",
  people: "Employees", gear: "Gear", quotes: "Quotes", reports: "Reports",
  qa: "QA status", itp: "ITP templates", settings: "Notification settings",
};

// ── Primitives ───────────────────────────────────────────────────────────────
function Pill({ status, dotted }) {
  if (!status) return null;
  const [tone, label] = status;
  return <span className={"pill " + tone}>{dotted && <span className={"dot " + (tone === "green" ? "" : tone)} />}{label}</span>;
}
function Bar({ pct, tone }) {
  return <span className="bar"><i className={tone || ""} style={{ width: Math.round((pct || 0) * 100) + "%" }} /></span>;
}
function Dot({ tone }) { return <span className={"dot " + (tone && tone !== "green" ? tone : "")} />; }
function Avatar({ name, tone }) { return <span className={"avatar " + (tone || "")}>{initials(name)}</span>; }

// Severity badge — words first, colour reinforces (critical/warning/info)
function SevBadge({ sev }) {
  const map = { critical: ["red", "Critical"], warning: ["amber", "Warning"], info: ["grey", "Info"] };
  const [tone, label] = map[sev] || map.info;
  return <span className={"sev " + tone}><i />{label}</span>;
}
// Source tag — which register the item came from
function SourceBadge({ source }) { return <span className="src-badge">{source}</span>; }
// Action-state badge — honest about whether the next action is exact or a fallback
function ActionBadge({ state }) {
  if (state === "fallback") return <span className="act-badge fallback">Fallback</span>;
  return <span className="act-badge ok">Exact action</span>;
}

function PageHead({ title, sub, actions }) {
  return (
    <div className="bos-pagehdr">
      <div>
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="bos-pagehdr-actions">{actions}</div>}
    </div>
  );
}

// ── Sidebar — bühl logo lead + full live nav ─────────────────────────────────
function Sidebar({ route, setRoute }) {
  const u = window.WS.user;
  const x = counts();
  return (
    <aside className="bos-side">
      <div className="bos-brand">
        <img className="bos-brand-logo" src="brand/buhl-logo-white.png" alt="bühl electrical" />
        <small>BuhlOS · office command centre</small>
      </div>
      <nav className="bos-nav">
        {NAV.map((it, i) => {
          if (it.sec !== undefined) return <div key={i} className="bos-nav-section">{it.sec}</div>;
          const n = it.c ? it.c(x) : null;
          const attn = it.badge && n > 0;
          return (
            <div key={i} className={"bos-nav-item" + (route === it.k ? " active" : "")} onClick={() => setRoute(it.k)}>
              <Ic n={it.ic} s={16} cls="bos-nav-ic" />
              <span className="bos-nav-label">{it.t}</span>
              {n != null && n > 0 && <span className={"nav-count" + (attn ? " attn" : "")}>{n}</span>}
            </div>
          );
        })}
      </nav>
      <div className="bos-side-footer">
        <div className={"bos-nav-item foot" + (route === "settings" ? " active" : "")} onClick={() => setRoute("settings")}>
          <Ic n="bell" s={16} cls="bos-nav-ic" />
          <span className="bos-nav-label">Notification settings</span>
        </div>
        <div className="bos-user">
          <div className="bos-user-avatar">{u.initials}</div>
          <div className="bos-user-meta"><b>{u.name}</b><small>{u.role}</small></div>
          <div className="bos-signout" title="Sign out">⎋</div>
        </div>
      </div>
    </aside>
  );
}

// ── Global search — jump to any job or screen ────────────────────────────────
function GlobalSearch({ setRoute, openJob }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const allJobs = [...window.WS.jobs, ...window.BX.extraJobs];

  useEffect(() => {
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const term = q.trim().toLowerCase();
  const jobHits = term ? allJobs.filter((j) => (j.name + " " + j.id + " " + j.client).toLowerCase().includes(term)).slice(0, 5) : [];
  const navHits = term ? NAV.filter((n) => n.k && n.t.toLowerCase().includes(term)).slice(0, 4) : [];
  const has = jobHits.length || navHits.length;

  const go = (fn) => { fn(); setQ(""); setOpen(false); };

  return (
    <div className="bos-search-wrap" ref={wrapRef}>
      <div className="bos-search2">
        <span className="ic">⌕</span>
        <input value={q} onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          placeholder="Search jobs, people, screens…" />
        <span className="kbd">⌘K</span>
      </div>
      {open && term && (
        <div className="bos-search-pop">
          {!has && <div className="bos-search-empty">No match for “{q}”</div>}
          {jobHits.length > 0 && <div className="bos-search-sec">Jobs</div>}
          {jobHits.map((j) => (
            <div key={j.id} className="bos-search-row" onClick={() => go(() => openJob(j.id))}>
              <Pill status={j.status} />
              <span className="r-name">{j.name}</span>
              <span className="r-meta">{j.id} · {j.client}</span>
            </div>
          ))}
          {navHits.length > 0 && <div className="bos-search-sec">Screens</div>}
          {navHits.map((n) => (
            <div key={n.k} className="bos-search-row" onClick={() => go(() => setRoute(n.k))}>
              <span className="r-name">{n.t}</span>
              <span className="r-meta">{GROUP[n.k]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Topbar({ route, setRoute, openJob, action }) {
  return (
    <div className="bos-topbar">
      <div className="bos-crumbs">{GROUP[route]} / <b>{TITLE[route]}</b></div>
      <div className="surface-switch" style={{ marginLeft: 18 }}>
        <a className="on">BuhlOS · office</a>
        <a href="Phil.html">Phil · field</a>
      </div>
      <GlobalSearch setRoute={setRoute} openJob={openJob} />
      {action}
    </div>
  );
}

Object.assign(window, {
  initials, NAV, GROUP, TITLE, counts,
  Pill, Bar, Dot, Avatar, SevBadge, SourceBadge, ActionBadge,
  PageHead, Sidebar, Topbar, GlobalSearch,
});
