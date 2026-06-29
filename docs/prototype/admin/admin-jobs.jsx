// admin-jobs.jsx — Jobs portfolio + the per-job hub (the central single-job page).
// The hub mirrors birdwood /v2/jobs/[jobId]: a stacked record (header → build &
// publish → pre-start readiness → labour → evidence → activity/audit → induction
// → site) with an Office/Field view toggle and a full section directory.
// Exports JobsPage to window. openJobId/setOpenJob are owned by the app.

const ALL_JOBS = () => [...window.WS.jobs, ...window.BX.extraJobs];
const findJob = (id) => ALL_JOBS().find((x) => x.id === id);

// quick pending counts for a job (evidence / snags / ITPs)
function jobCounts(j) {
  const snags = window.BX.defects.filter((d) => d.job === j.name && d.status === "open").length;
  const qa = window.BX.qa.find((q) => q.jobId === j.id);
  const itps = qa ? qa.review : 0;
  const ev = ((window.BX.jobHub[j.id] || {}).evidence || []).reduce((a, x) => a + x[2], 0);
  return { ev, snags, itps };
}

function JobCard({ j, onOpen }) {
  const c = jobCounts(j);
  const chips = [["E", c.ev], ["S", c.snags], ["I", c.itps]].filter(([, n]) => n > 0);
  return (
    <div className="jcard" onClick={() => onOpen(j.id)}>
      <div className="jc-top">
        <div className="jc-name">{j.name}<small>{j.id} · {j.client}</small></div>
        <Pill status={j.status} dotted />
      </div>
      <dl className="jc-meta">
        <div><dt>Value</dt><dd>{j.value}</dd></div>
        <div><dt>Billed</dt><dd>{Math.round(j.billed * 100)}%</dd></div>
        <div><dt>Crew</dt><dd>{j.crew}</dd></div>
        <div><dt>PM</dt><dd style={{ fontSize: 12 }}>{j.pm}</dd></div>
      </dl>
      <div className="jc-next"><span className={"dot " + (j.status[0] === "green" ? "" : j.status[0])} />{j.next}</div>
      <div className="jc-foot">
        <div className="jc-pending">
          {chips.length ? chips.map(([k, n]) => (
            <span className={"jc-chip " + (k === "E" ? "ev" : k === "S" ? "sn" : "it")} key={k} title={k === "E" ? "Evidence to review" : k === "S" ? "Open snags" : "ITPs to sign off"}>{k} {n}</span>
          )) : <span className="jc-clean">clean</span>}
        </div>
        <div className="risk-meter">
          <span className="cell-mono" style={{ textTransform: "uppercase", letterSpacing: ".1em", fontSize: 9 }}>Risk</span>
          <Bar pct={j.risk / 100} tone={j.risk > 65 ? "red" : j.risk > 40 ? "amber" : ""} />
          <span className="rv">{j.risk}</span>
        </div>
      </div>
    </div>
  );
}

// per-job section data — anchor job has deep hub data; others use cross-job filters
function sectionsFor(j) {
  const B = window.BX, A = window.WS.arthur;
  const hub = B.hub[j.id];
  const deep = j.id === "P25-014";
  return {
    itps: deep ? A.itps : [],
    snags: B.defects.filter((d) => d.job === j.name && d.status === "open"),
    evidence: hub ? hub.evidence : [],
    plans: hub ? hub.plans : [],
    materials: B.materials.filter((m) => m.job === j.name),
    obs: B.observations.filter((o) => o.job === j.name),
    activity: hub ? hub.activity : [{ who: j.pm, what: "is the project manager on this job", age: "—" }],
  };
}

// merge rich overrides (BX.jobHub) with sensible derived defaults for any job
function deriveHub(j) {
  const O = (window.BX.jobHub || {})[j.id] || {};
  const red = j.status[0] === "red", amber = j.status[0] === "amber";
  const draft = j.status[1] === "draft" || j.crew === 0;
  const seed = j.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const structure = O.structure || {
    areaGroups: 2 + (seed % 4), areas: 6 + (seed % 12),
    roughIn: draft ? 0 : 40 + (seed % 90),
    fitOff: (j.stage === "Fit-off" || j.stage === "Handover") ? 30 + (seed % 70) : (seed % 30),
  };
  const items = (O.readiness && O.readiness.items) || [
    { label: "Site induction", ok: !draft, note: draft ? "No crew assigned yet" : "Crew inducted" },
    { label: "Electrical licences", ok: !draft, note: draft ? "Pending crew assignment" : "All field crew current" },
    { label: "Safety docs · SWMS", ok: !draft && !red, note: draft ? "Not started" : red ? "Needs re-sign" : "Signed + on file" },
    { label: "Pre-start checklist", ok: !draft && !red && !amber, note: draft ? "Draft — not published" : red || amber ? "Open item before start" : "Cleared" },
  ];
  const fails = items.filter((i) => !i.ok).length;
  const state = (O.readiness && O.readiness.state) || (draft ? "blocked" : fails === 0 ? "ready" : fails >= 2 ? "blocked" : "caution");
  return {
    published: O.published != null ? O.published : !draft,
    fromQuote: O.fromQuote, created: O.created || "—",
    structure,
    readiness: { state, items },
    labour: O.labour || { pending: 0 },
    evidence: O.evidence || [],
    induction: O.induction || { required: !draft, inducted: draft ? 0 : j.crew, total: j.crew, missing: null },
    site: O.site || {
      contact: j.client, role: j.type, phone: "",
      access: "Access notes added by the office before mobilising.",
      parking: "", safety: (amber || red) ? "Standard PPE — site-specific controls apply." : "Standard PPE site-wide.",
    },
    activity: O.activity || [],
  };
}

// ── Hub overview cards ─────────────────────────────────────────────────────
function HubBuild({ j, H, onBuild }) {
  const s = H.structure;
  return (
    <div className="card">
      <div className="card-hdr">
        <h3>Build &amp; publish</h3>
        <div className="card-hdr-actions">
          {H.published
            ? <span className="bp-state ok"><Ic n="eye" s={13} /> Published</span>
            : <span className="bp-state off"><Ic n="lock" s={13} /> Office-only</span>}
          <button className="btn" onClick={onBuild}><Ic n="pencil-ruler" s={13} /> Open builder</button>
        </div>
      </div>
      <div className="bp-note">{H.published
        ? "Structure is visible to the assigned field crew in Phil."
        : "Not yet published — the field can't see this job until you publish."}</div>
      <div className="struct-grid">
        {[["Area groups", s.areaGroups], ["Areas", s.areas], ["Rough-in tasks", s.roughIn], ["Fit-off tasks", s.fitOff]].map(([l, v]) => (
          <div className="struct-stat" key={l}><div className="sv">{v}</div><div className="sl">{l}</div></div>
        ))}
      </div>
    </div>
  );
}

function HubReadiness({ H }) {
  const r = H.readiness;
  const map = { ready: ["green", "Ready to start"], caution: ["amber", "Start with caution"], blocked: ["red", "Not ready to start"] };
  const [tone, label] = map[r.state] || map.caution;
  return (
    <div className="card">
      <div className="card-hdr">
        <h3>Can we start?</h3>
        <span className={"rdy-verdict " + tone}><span className={"dot " + (tone === "green" ? "" : tone)} />{label}</span>
      </div>
      <div className="rdy-list">
        {r.items.map((it, i) => (
          <div className="rdy-item" key={i}>
            <Ic n={it.ok ? "check-circle" : "alert-triangle"} s={17} cls={"rdy-ic " + (it.ok ? "ok" : "no")} />
            <div className="rdy-b"><div className="rdy-l">{it.label}</div><div className="rdy-n">{it.note}</div></div>
            <span className={"pill " + (it.ok ? "green" : "amber")}>{it.ok ? "OK" : "Action"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function HubLabour({ H }) {
  const l = H.labour;
  return (
    <div className="card">
      <div className="card-hdr"><h3>Labour</h3><span className="count">hours on this job</span></div>
      {l.pending ? (
        <>
          <div className="lab-row">
            <div className="lab-main"><b>{l.pendingHrs}</b> awaiting approval<small>{l.who} · {l.week} · {l.pendingVal}</small></div>
            <button className="btn go">Open approvals ›</button>
          </div>
          {l.approved && <div className="lab-foot">Approved on this job · <b>{l.approved}</b> in the last 7 days</div>}
        </>
      ) : <Empty msg="No hours awaiting approval on this job." />}
    </div>
  );
}

function HubEvidence({ H, onOpen }) {
  const e = H.evidence;
  const total = e.reduce((a, x) => a + x[2], 0);
  return (
    <div className="card">
      <div className="card-hdr"><h3>Evidence</h3><span className="count">{total} captures</span></div>
      {total ? (
        <div className="evid-sum">
          {e.map(([tone, label, n], i) => (
            <div className="evid-cell" key={i}><div className="evid-n">{n}</div><Pill status={[tone, label]} /></div>
          ))}
          <button className="btn" style={{ marginLeft: "auto" }} onClick={() => onOpen("evidence")}>Review ›</button>
        </div>
      ) : <Empty msg="No captures waiting. Field evidence lands here from Phil." />}
    </div>
  );
}

function HubActivity({ j, H }) {
  const acts = [...H.activity];
  if (H.fromQuote) acts.push({ who: j.pm, what: <>converted quote <b>{H.fromQuote}</b> → this job</>, age: H.created, audit: "quote.converted" });
  acts.push({ who: j.pm, what: "created this job in Job Builder", age: H.created, audit: "job.created" });
  return (
    <div className="card">
      <div className="card-hdr"><h3>Recent activity</h3><span className="count">audit trail</span></div>
      {acts.map((a, i) => (
        <div className="row" key={i}>
          <Avatar name={a.who} />
          <div className="row-grow">
            <div className="row-title" style={{ fontSize: 12.5 }}><b style={{ fontWeight: 700 }}>{a.who}</b> {a.what}</div>
            {a.audit && <div className="row-meta" style={{ marginTop: 3 }}><span className="audit-tag">{a.audit}</span></div>}
          </div>
          <span className="cell-mono" style={{ color: "var(--ink-3)" }}>{a.age}</span>
        </div>
      ))}
    </div>
  );
}

function HubInduction({ H }) {
  const i = H.induction;
  if (!i.required && !i.total) return null;
  const done = i.total > 0 && i.inducted >= i.total;
  return (
    <div className="card">
      <div className="card-hdr"><h3>Induction</h3><span className="count">{i.inducted}/{i.total} crew</span></div>
      <div className="ind-row">
        <Ic n="hard-hat" s={19} cls={"ind-ic " + (done ? "ok" : "no")} />
        <div className="ind-b">
          {done
            ? <><b>All crew inducted</b><small>{i.total} on this job · records on file</small></>
            : <><b>{Math.max(i.total - i.inducted, 0) || "—"} not inducted</b><small>{i.missing ? i.missing + " outstanding" : "assign + induct crew before mobilising"}</small></>}
        </div>
        <span className={"pill " + (done ? "green" : "amber")}>{done ? "Complete" : "Action"}</span>
      </div>
    </div>
  );
}

function HubSite({ j, H }) {
  const s = H.site;
  const rows = [
    ["map-pin", "Address", j.addr],
    ["user", "Contact", [s.contact, s.role].filter(Boolean).join(" · ") + (s.phone ? "   " + s.phone : "")],
    ["key-round", "Access", s.access],
    s.parking ? ["map", "Parking", s.parking] : null,
    s.safety ? ["shield-alert", "Safety", s.safety] : null,
  ].filter(Boolean);
  return (
    <div className="card">
      <div className="card-hdr"><h3>Site</h3></div>
      <div className="site-grid">
        {rows.map(([ic, l, v], i) => (
          <div className="site-field" key={i}>
            <Ic n={ic} s={15} cls="site-ic" />
            <div className="site-b"><div className="site-l">{l}</div><div className="site-v">{v}</div></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Field view (read-only Phil preview) ────────────────────────────────────
function FieldView({ j, S, H }) {
  const A = window.WS.arthur;
  const areas = j.id === "P25-014" ? A.stages : [{ name: j.stage + " · whole job", pct: j.billed || 0, status: j.status }];
  return (
    <div className="card fieldview">
      <div className="fv-banner"><Ic n="eye" s={14} /> Field view · read-only — what the crew sees in Phil</div>
      <div className="fv-sec">
        <h4>Areas on {j.name}</h4>
        {areas.slice(0, 5).map((a, i) => (
          <div className="fv-row" key={i}><span>{a.name}</span><Pill status={a.status} /></div>
        ))}
      </div>
      <div className="fv-sec">
        <h4>Required proof</h4>
        <div className="fv-row"><span>{H.published ? "Capture site photos against your assigned tasks." : "Not published yet — nothing to capture."}</span></div>
      </div>
      <div className="fv-sec">
        <h4>Open snags · {S.snags.length}</h4>
        {S.snags.length
          ? S.snags.slice(0, 3).map((s) => <div className="fv-row" key={s.id}><span>{s.what}</span><Pill status={s.priority} /></div>)
          : <div className="fv-empty">None on site.</div>}
      </div>
    </div>
  );
}

// ── Section directory + inline panels ──────────────────────────────────────
function sectionList(j, S) {
  return [
    { k: "evidence", ic: "camera", label: "Evidence", desc: "Photo / note captures, admin review, history.", count: S.evidence.reduce((a, x) => a + x[2], 0) },
    { k: "snags", ic: "alert-octagon", label: "Snags", desc: "Defects raised from the field, transitions, rejection reasons.", count: S.snags.length },
    { k: "obs", ic: "inbox", label: "Observations", desc: "Blockers, plan mismatches, RFIs and instructions on this job.", count: S.obs.length },
    { k: "itps", ic: "clipboard-check", label: "ITP / QA", desc: "Attached inspection / test plans, field results, sign-off.", count: S.itps.length },
    { k: "scope", ic: "scale", label: "Scope reconciliation", desc: "Scope-vs-quote: confirmed clauses and open conflicts before work starts." },
    { k: "control", ic: "list-checks", label: "Job control", desc: "Author required proof — tie a scope clause to a worker task." },
    { k: "docs", ic: "file-text", label: "Documents & specs", desc: "Plans, schedules, install specs, supplier docs.", count: S.plans.length },
    { k: "circuit", ic: "zap", label: "Circuit schedules", desc: "AS/NZS 3000 board schedule — voltage-drop / phase-balance / capacity checks.", href: "BuhlOS Circuit Schedule.html" },
    { k: "plans", ic: "map", label: "Plans", desc: "Open drawings in the in-app viewer — zoom, rotate, page revisions.", count: S.plans.length },
    { k: "materials", ic: "package", label: "Material requests", desc: "Procurement — requested / approved / ordered / delivered.", count: S.materials.length },
    { k: "activity", ic: "history", label: "Activity", desc: "Consolidated audit trail across every section on this job." },
  ];
}

function SectionDirectory({ j, S, open, onOpen }) {
  const rows = sectionList(j, S);
  return (
    <div className="card">
      <div className="card-hdr"><h3>Sections</h3><span className="count">every part of the job, one place</span></div>
      <div className="secdir">
        {rows.map((r) => {
          const inner = (
            <>
              <Ic n={r.ic} s={18} cls="secrow-ic" />
              <div className="secrow-b"><div className="secrow-l">{r.label}</div><div className="secrow-d">{r.desc}</div></div>
              {typeof r.count === "number" && <span className={"pill " + (r.count > 0 ? "navy" : "grey")}>{r.count}</span>}
              <Ic n={r.href ? "external-link" : "chevron-right"} s={16} cls="secrow-chev" />
            </>
          );
          return r.href
            ? <a className="secrow" href={r.href} key={r.k}>{inner}</a>
            : <div className={"secrow" + (open === r.k ? " on" : "")} key={r.k} onClick={() => onOpen(r.k)}>{inner}</div>;
        })}
      </div>
    </div>
  );
}

function SectionPanel({ sect, j, S, onClose }) {
  const A = window.WS.arthur;
  const titles = {
    evidence: "Evidence to review", snags: "Open snags", obs: "Observations", itps: "Inspection & test plans",
    scope: "Scope reconciliation", control: "Job control · required proof", docs: "Documents & specs",
    plans: "Plans", materials: "Material requests", activity: "Activity",
  };
  let body;
  if (sect === "evidence") body = S.evidence.length
    ? S.evidence.map(([tone, label, n], i) => (
      <div className="row" key={i}><div className="photo-tile" style={{ width: 36, height: 36, aspectRatio: "auto", flexShrink: 0 }}>IMG</div>
        <div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}>{n} captures</div></div><Pill status={[tone, label]} /></div>))
    : <Empty msg="No captures waiting." />;
  else if (sect === "snags") body = S.snags.length
    ? S.snags.map((s) => (<div className="row" key={s.id}><div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}>{s.what}</div><div className="row-meta">{s.id} · {s.area} · {s.who} · {s.age}</div></div><Pill status={s.priority} dotted /></div>))
    : <Empty msg="No open snags. Clean job." />;
  else if (sect === "obs") body = S.obs.length
    ? S.obs.map((o) => (<div className="row" key={o.id}><div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}><span className="src-badge" style={{ marginRight: 6 }}>{o.type}</span>{o.what}</div><div className="row-meta">{o.area} · {o.who} · {o.age}</div></div><Pill status={o.priority} dotted /></div>))
    : <Empty msg="Nothing raised from site on this job." />;
  else if (sect === "itps") body = S.itps.length
    ? S.itps.map((t) => (<div className="row" key={t.id}><div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}>{t.title}</div><div className="row-meta">{t.id} · {t.note}</div></div><Bar pct={t.done / t.rows} tone={t.status[0] === "amber" ? "amber" : t.status[0] === "grey" ? "navy" : ""} /><span className="cell-mono">{t.done}/{t.rows}</span><Pill status={t.status} /></div>))
    : <Empty msg="No ITPs raised on this job yet." />;
  else if (sect === "plans" || sect === "docs") body = S.plans.length
    ? S.plans.map((p) => (<div className="row" key={p.id}><div className="photo-tile wide" style={{ width: 54, height: 36, aspectRatio: "auto", flexShrink: 0 }}>PLAN</div><div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}>{p.name}</div><div className="row-meta">{p.id} · {p.date}</div></div><Pill status={p.status} /></div>))
    : <Empty msg="No drawings uploaded for this job yet." />;
  else if (sect === "materials") body = S.materials.length
    ? S.materials.map((m) => (<div className="row" key={m.id}><div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}>{m.item}</div><div className="row-meta">{m.id} · {m.who} · {m.supplier}</div></div><span className="cell-mono">{m.value}</span><Pill status={m.status} dotted /></div>))
    : <Empty msg="No material requests on this job." />;
  else if (sect === "activity") body = S.activity.map((a, i) => (<div className="row" key={i}><Avatar name={a.who} /><div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}><b style={{ fontWeight: 700 }}>{a.who}</b> {a.what}</div></div><span className="cell-mono" style={{ color: "var(--ink-3)" }}>{a.age}</span></div>));
  else if (sect === "scope") {
    const clauses = [
      ["Cl 2.4 · Emergency & exit lighting", ["green", "included"]],
      ["Cl 3.1 · Comms backbone + patch", ["grey", "by others"]],
      ["Cl 5.2 · L5 plant power upgrade", ["red", "excluded — owed"]],
      ["Cl 6.0 · Tenant metering", ["amber", "alternate"]],
    ];
    body = clauses.map(([t, st], i) => (<div className="row" key={i}><div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}>{t}</div></div><Pill status={st} /></div>));
  } else if (sect === "control") {
    const proofs = [
      ["L2 ceiling rough-in", "Photo before ceiling close"],
      ["Riser 2 penetrations", "Photo of seal + tag"],
      ["MSB termination", "Torque-tag photo + test sheet"],
    ];
    body = proofs.map(([t, p], i) => (<div className="row" key={i}><div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}>{t}</div><div className="row-meta">required proof · {p}</div></div><span className="src-badge">required</span></div>));
  }
  return (
    <div className="card sectpanel">
      <div className="card-hdr"><h3>{titles[sect] || "Section"}</h3><div className="card-hdr-actions"><button className="btn" onClick={onClose}>Close ✕</button></div></div>
      {body}
    </div>
  );
}

function Empty({ msg }) {
  return <div style={{ padding: "24px 16px", textAlign: "center", color: "var(--ink-3)", fontSize: 12.5 }}>{msg}</div>;
}

function JobHub({ id, onBack, openBuilder }) {
  const j = findJob(id);
  const [view, setView] = useState("office");
  const [sect, setSect] = useState(null);
  if (!j) return <div className="card" style={{ padding: 24 }}>Job not found.</div>;
  const S = sectionsFor(j);
  const H = deriveHub(j);

  return (
    <>
      <div>
        <div className="back-link" onClick={onBack}>← All jobs</div>
        <div className="job-hero">
          <div>
            <h1>{j.name}</h1>
            <div className="hsub">{j.id} · {j.type} · {j.client} · {j.addr}</div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Pill status={j.status} dotted />
            {j.status[1] === "draft" ? <button className="btn primary">Publish job</button>
              : j.crew === 0 ? <button className="btn primary">Assign crew</button>
              : <><button className="btn">Open drawings</button><button className="btn primary">New variation</button></>}
          </div>
        </div>
      </div>

      <div className="job-toggle">
        <div className="seg">
          <button className={view === "office" ? "on" : ""} onClick={() => setView("office")}><Ic n="layout-grid" s={13} /> Office</button>
          <button className={view === "field" ? "on" : ""} onClick={() => setView("field")}><Ic n="eye" s={13} /> Field view</button>
        </div>
        <span className="job-toggle-hint">{view === "office" ? "The full office record." : "A read-only preview of what the field crew sees in Phil."}</span>
      </div>

      {view === "field" ? <FieldView j={j} S={S} H={H} /> : (
        <>
          <HubBuild j={j} H={H} onBuild={() => openBuilder && openBuilder(j.id)} />
          <HubReadiness H={H} />
          <div className="hub-2col">
            <HubLabour H={H} />
            <HubEvidence H={H} onOpen={setSect} />
          </div>
          <HubActivity j={j} H={H} />
          <div className="hub-2col">
            <HubInduction H={H} />
            <HubSite j={j} H={H} />
          </div>
          <SectionDirectory j={j} S={S} open={sect} onOpen={(k) => setSect(sect === k ? null : k)} />
          {sect && <SectionPanel sect={sect} j={j} S={S} onClose={() => setSect(null)} />}
        </>
      )}
    </>
  );
}

function JobsPage({ openJobId, setOpenJob, openBuilder }) {
  const [filter, setFilter] = useState("all");
  if (openJobId) return <JobHub id={openJobId} onBack={() => setOpenJob(null)} openBuilder={openBuilder} />;
  const jobs = ALL_JOBS();
  const shown = filter === "all" ? jobs
    : filter === "risk" ? jobs.filter((j) => j.risk > 40)
    : filter === "draft" ? jobs.filter((j) => j.status[1] === "draft" || j.crew === 0)
    : jobs.filter((j) => j.stage.toLowerCase().includes(filter));
  const totalContract = "$2.79M";
  return (
    <>
      <PageHead title="Jobs" sub={`${jobs.length} jobs · ${jobs.filter((j) => j.status[0] !== "green").length} need attention`}
        actions={<><button className="btn">Archive</button><button className="btn primary" onClick={() => openBuilder && openBuilder("P25-014")}>+ New job</button></>} />
      <div className="seg-row">
        <div className="seg">
          {[["all", "All"], ["risk", "At risk"], ["rough-in", "Rough-in"], ["fit", "Fit-out/off"], ["handover", "Handover"], ["draft", "Drafts / no crew"]].map(([k, t]) => (
            <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{t}</button>
          ))}
        </div>
        <div className="spacer" />
        <span className="cell-mono">Total contract · {totalContract}</span>
      </div>
      <div className="job-grid">
        {shown.map((j) => <JobCard key={j.id} j={j} onOpen={setOpenJob} />)}
      </div>
    </>
  );
}

Object.assign(window, { JobsPage });
