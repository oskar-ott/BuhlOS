// admin-builder.jsx — BuhlOS Job Builder v2 cockpit (the scope-to-field surface).
// Three panes: LEFT rail (grouped section nav + live readiness meter) · CENTER
// canvas (active section, routed via window.BSections) · RIGHT inspector (the
// selected row: certainty state, refs, proof, field-visibility, quick actions).
// Owns ALL builder state; the certainty state machine + readiness/publish gate
// recompute live as you confirm/ignore/RFI. Exports BuilderCockpit to window.
// Shared atoms (CertChip, SysTag, isReview, taskBroken, cnt) come from
// admin-builder-sections.jsx via the shared script scope.

// ── Rail layout: grouped sections + the pinned review queue ──────────────────
const RAIL = [
  { group: "Plan", items: [
    { k: "overview", t: "Overview", ic: "briefcase" },
    { k: "scope", t: "Scope intake", ic: "file-text" },
    { k: "areas", t: "Areas & zones", ic: "map" },
    { k: "stages", t: "Stages", ic: "layers" },
    { k: "tasks", t: "Tasks", ic: "list-checks" },
  ] },
  { group: "Deliver", items: [
    { k: "plans", t: "Plans & docs", ic: "file-check" },
    { k: "materials", t: "Materials", ic: "package" },
    { k: "gear", t: "Gear & setup", ic: "wrench" },
    { k: "itps", t: "ITPs / QA", ic: "clipboard-list" },
    { k: "risks", t: "Risks & RFIs", ic: "shield-alert" },
    { k: "crew", t: "Crew", ic: "hard-hat" },
  ] },
  { group: "Ship", items: [
    { k: "philpreview", t: "Phil preview", ic: "eye" },
    { k: "publish", t: "Publish", ic: "check-circle" },
  ] },
];

// ── Readiness model — pure derivation from the live state ────────────────────
function buildModel(d) {
  const scope = d.scope.items, tasks = d.tasks, products = d.products.items;
  const areas = d.areaGroups.reduce((acc, g) => acc.concat(g.areas), []);

  const scopeReview = cnt(scope, (i) => isReview(i.cert));
  const taskReview = cnt(tasks, (t) => isReview(t.cert));
  const taskBrokenN = cnt(tasks, taskBroken);
  const areaSugg = cnt(areas, (a) => a.cert === "suggested");
  const prodReview = cnt(products, (p) => isReview(p.cert));
  const noInd = cnt(d.crew, (c) => c.induction === "missing");
  const expL = cnt(d.crew, (c) => c.licences === "expiring");
  const openRfi = cnt(d.rfis, (r) => r.status === "open");
  const gearNeeded = d.gear.needed.length;
  const longLead = d.materials.counts.longLead;
  const errLint = cnt(d.fieldLint, (l) => l.sev === "err");

  const blockers = [];
  if (scopeReview) blockers.push({ msg: `${scopeReview} scope ${scopeReview === 1 ? "line" : "lines"} still need review`, go: "scope" });
  if (taskReview) blockers.push({ msg: `${taskReview} ${taskReview === 1 ? "task is" : "tasks are"} not yet confirmed`, go: "tasks" });
  if (taskBrokenN) blockers.push({ msg: `${taskBrokenN} ${taskBrokenN === 1 ? "task has" : "tasks have"} no area or instruction`, go: "tasks" });
  if (noInd) blockers.push({ msg: `${noInd} ${noInd === 1 ? "worker is" : "workers are"} not inducted`, go: "crew" });

  const warnings = [];
  if (areaSugg) warnings.push({ msg: `${areaSugg} suggested ${areaSugg === 1 ? "area" : "areas"} not confirmed`, go: "areas" });
  if (openRfi) warnings.push({ msg: `${openRfi} open RFI${openRfi === 1 ? "" : "s"} on this job`, go: "risks" });
  if (d.planAlert) warnings.push({ msg: "Plan re-ack outstanding (EL rev C)", go: "plans" });
  if (longLead) warnings.push({ msg: `${longLead} long-lead material at risk`, go: "materials" });
  if (gearNeeded) warnings.push({ msg: `${gearNeeded} gear items still to assign`, go: "gear" });
  if (expL) warnings.push({ msg: `${expL} licence expiring`, go: "crew" });

  const spine = scope.map((i) => i.cert).concat(tasks.map((t) => t.cert));
  const resolved = spine.filter((c) => c === "confirmed" || c === "converted" || c === "ignored").length;
  const pct = Math.round((100 * resolved) / spine.length);

  const state = blockers.length ? "no" : warnings.length ? "warnings" : "yes";
  const stateLabel = state === "no" ? "Not ready" : state === "warnings" ? "With warnings" : "Ready to publish";

  const sectionMeta = {
    overview: { tick: true },
    scope: { count: scopeReview, block: scopeReview > 0 },
    areas: { count: areaSugg, warn: true },
    stages: { tick: true },
    tasks: { count: taskReview, block: taskReview > 0 || taskBrokenN > 0 },
    plans: { warn: !!d.planAlert },
    materials: { warn: longLead > 0 },
    gear: { warn: gearNeeded > 0 },
    itps: { tick: true },
    risks: { count: openRfi, warn: true },
    crew: { count: noInd, block: noInd > 0 },
    philpreview: errLint ? { count: errLint, block: true } : { warn: true },
    publish: blockers.length ? { gate: true } : { tick: true },
  };

  return {
    pct, state, stateLabel, blockers, warnings, sectionMeta,
    reviewTotal: scopeReview + taskReview + areaSugg + prodReview,
  };
}

// ── Resolve the inspector's selected row from the live state ─────────────────
function findSel(d, sel) {
  if (!sel) return null;
  const { kind, id } = sel;
  if (kind === "task") return d.tasks.find((t) => t.id === id);
  if (kind === "scope") return d.scope.items.find((i) => i.id === id);
  if (kind === "product") return d.products.items.find((p) => p.id === id);
  if (kind === "rfi") return d.rfis.find((r) => r.id === id);
  if (kind === "material") return d.materials.rows.find((r) => r.id === id);
  if (kind === "plan") return d.plans.find((p) => p.id + p.rev === id);
  if (kind === "area") {
    for (const g of d.areaGroups) {
      const a = g.areas.find((x) => x.id === id);
      if (a) return Object.assign({ group: g.name }, a);
    }
  }
  return null;
}

const KIND_LABEL = { task: "Task", scope: "Scope line", area: "Area", product: "Requirement", rfi: "RFI", material: "Material", plan: "Document" };
const HAS_CERT = { task: 1, scope: 1, area: 1, product: 1 };

function railEnd(meta) {
  if (!meta) return <span className="jbx-rail-todo" />;
  if (meta.gate) return <span className="jbx-rail-count block">!</span>;
  if (meta.count != null && meta.count > 0) return <span className={"jbx-rail-count" + (meta.block ? " block" : "")}>{meta.count}</span>;
  if (meta.warn) return <span className="jbx-rail-warn"><Ic n="alert-triangle" s={13} /></span>;
  if (meta.tick) return <span className="jbx-rail-tick"><Ic n="check-circle" s={14} /></span>;
  return <span className="jbx-rail-todo" />;
}

// One inspector field row.
function IRow({ k, v, bad, muted }) {
  return <div className="insp-field"><span className="ik">{k}</span><span className={"iv" + (bad ? " bad" : muted ? " muted" : "")}>{v}</span></div>;
}

// Certainty transition controls — the core loop, on any cert-bearing row.
function CertTransitions({ cert, onSet }) {
  return (
    <div className="insp-trans">
      {cert !== "confirmed" && <button className="confirm" onClick={() => onSet("confirmed")}><Ic n="check" s={12} /> Confirm</button>}
      {cert !== "review" && <button onClick={() => onSet("review")}><Ic n="alert-triangle" s={12} /> Needs review</button>}
      {cert !== "rfi" && <button className="rfi" onClick={() => onSet("rfi")}><Ic n="alert-octagon" s={12} /> Raise RFI</button>}
      {cert !== "ignored" && <button className="ignore" onClick={() => onSet("ignored")}><Ic n="circle" s={12} /> Ignore</button>}
    </div>
  );
}

// ── Right pane: the inspector ────────────────────────────────────────────────
function Inspector({ d, sel, act }) {
  const obj = findSel(d, sel);
  if (!obj) {
    return (
      <div className="jbx-insp-empty">
        <div className="ie-ic"><Ic n="pencil-ruler" s={20} /></div>
        <b>Inspector</b>
        <p>Select any row — a scope line, task, area or requirement — to see its certainty state, references, required proof and what the field will see.</p>
      </div>
    );
  }
  const kind = sel.kind;
  const onSet = (next) => act.setCert(kind, sel.id, next);
  const title = obj.name || obj.text || obj.q || obj.item || (obj.id + " rev " + obj.rev);
  const idLine = obj.id ? (obj.id + (obj.ref ? " · " + obj.ref : "")) : null;
  const areaNames = [];
  d.areaGroups.forEach((g) => g.areas.forEach((a) => { if (!areaNames.includes(a.name)) areaNames.push(a.name); }));
  if (!areaNames.includes("all areas")) areaNames.push("all areas");

  return (
    <div className="jbx-insp">
      <div className="jbx-insp-h">
        <div className="jbx-insp-kicker">
          <span className="jbx-insp-kind">{KIND_LABEL[kind] || kind}</span>
          {HAS_CERT[kind] && <CertChip cert={obj.cert} />}
        </div>
        <div className="jbx-insp-title">{title}</div>
        {idLine && <div className="jbx-insp-id">{idLine}</div>}
      </div>
      <div className="jbx-insp-b">
        {HAS_CERT[kind] && (
          <div className="jbx-insp-sec">
            <div className="jbx-insp-lbl">Certainty</div>
            <div className="insp-state-row"><CertChip cert={obj.cert} lg /></div>
            <CertTransitions cert={obj.cert} onSet={onSet} />
            {obj.cert === "confirmed" && kind === "scope" && <button className="btn primary" style={{ marginTop: 4 }} onClick={() => onSet("converted")}><Ic n="arrow-right" s={12} /> Convert to task</button>}
          </div>
        )}

        {kind === "task" && (
          <>
            <div className="jbx-insp-sec">
              <div className="jbx-insp-lbl">Instruction · what to do</div>
              <textarea
                className={"insp-instr-edit" + (obj.instruction ? "" : " empty")}
                value={obj.instruction || ""}
                placeholder="No instruction — the field won't know what to do. Type one to clear the blocker."
                onChange={(e) => act.setTaskField(obj.id, { instruction: e.target.value })}
              />
            </div>
            <div className="jbx-insp-sec">
              <div className="jbx-insp-lbl">Wiring · the facets</div>
              <div>
                <div className="insp-field">
                  <span className="ik">Area</span>
                  <select className={"insp-sel" + (obj.area ? "" : " bad")} value={obj.area || ""} onChange={(e) => act.setTaskField(obj.id, { area: e.target.value || null })}>
                    <option value="">— none</option>
                    {areaNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <IRow k="Stage" v={obj.stage} />
                <IRow k="System" v={obj.system ? <SysTag system={obj.system} /> : "—"} muted={!obj.system} />
                <IRow k="Worker" v={obj.worker || "unassigned"} muted={!obj.worker} />
                <IRow k="Scope ref" v={obj.scopeRef} />
                <IRow k="Plan" v={obj.planRef} />
              </div>
            </div>
            <div className="jbx-insp-sec">
              <div className="jbx-insp-lbl">Required proof</div>
              {(obj.evidence && obj.evidence.length)
                ? obj.evidence.map((e, i) => (
                  <div className="insp-proof" key={i}><Ic n="camera" s={14} cls="dim" /><span className="ip-t">{e.type}</span><span className={"pill " + (e.required ? "amber" : "grey")}>{e.required ? "Required" : "Optional"}</span></div>))
                : <div className="insp-proof"><Ic n="camera" s={14} cls="dim" /><span className="ip-t" style={{ color: "var(--ink-3)" }}>No proof set — nothing to capture before sign-off.</span></div>}
            </div>
            <div className="jbx-insp-sec">
              <div className="jbx-insp-lbl">Field visibility</div>
              <div className="insp-vis">
                <div className="iv-b">
                  <div className="iv-t">Visible in Phil</div>
                  <div className="iv-s">{(obj.cert === "confirmed" || obj.cert === "converted") ? "Reaches assigned crew" : "Set — but only ships once Confirmed"}</div>
                </div>
                <div className={"jb-tog" + (obj.vis ? " on" : "")} onClick={() => act.toggleVis(obj.id)}><span className="sw" /></div>
              </div>
            </div>
            <div className="insp-actions">
              <button className="btn"><Ic n="user" s={13} /> Assign worker</button>
              <button className="btn"><Ic n="camera" s={13} /> Add required proof</button>
            </div>
          </>
        )}

        {kind === "scope" && (
          <>
            {obj.note && <div className="jbx-insp-sec"><div className="jbx-insp-lbl">Note</div><div className="insp-instr">{obj.note}</div></div>}
            <div className="jbx-insp-sec">
              <div className="jbx-insp-lbl">References</div>
              <div>
                <IRow k="Clause" v={obj.ref} />
                <IRow k="System" v={obj.system ? <SysTag system={obj.system} /> : "—"} />
                <IRow k="Drives" v={obj.drives} muted={obj.drives === "—"} />
                <IRow k="Plan" v={obj.plan || "—"} muted={!obj.plan} />
                <IRow k="Required proof" v={obj.proof || "—"} muted={!obj.proof} />
              </div>
            </div>
          </>
        )}

        {kind === "area" && (
          <>
            {obj.note && <div className="jbx-insp-sec"><div className="jbx-insp-lbl">Note</div><div className="insp-instr">{obj.note}</div></div>}
            <div className="jbx-insp-sec">
              <div className="jbx-insp-lbl">Detail</div>
              <div>
                <IRow k="Group" v={obj.group} />
                <IRow k="Level" v={obj.level} />
                <IRow k="Systems" v={(obj.systems || []).join(" · ") || "—"} />
                <IRow k="Rough-in tasks" v={obj.roughIn} />
                <IRow k="Fit-off tasks" v={obj.fitOff} />
              </div>
            </div>
          </>
        )}

        {kind === "product" && (
          <>
            {obj.note && <div className="jbx-insp-sec"><div className="jbx-insp-lbl">Note</div><div className="insp-instr">{obj.note}</div></div>}
            <div className="jbx-insp-sec">
              <div className="jbx-insp-lbl">Detail</div>
              <div>
                <IRow k="Code" v={obj.code} />
                <IRow k="Type" v={obj.type} />
                <IRow k="Area" v={obj.area} />
                <IRow k="System" v={obj.system ? <SysTag system={obj.system} /> : "—"} />
                <IRow k="Reference" v={obj.ref} />
              </div>
            </div>
          </>
        )}

        {kind === "rfi" && (
          <>
            <div className="jbx-insp-sec">
              <div className="jbx-insp-lbl">Question</div>
              <div className="insp-instr">{obj.q}</div>
            </div>
            <div className="jbx-insp-sec">
              <div className="jbx-insp-lbl">Detail</div>
              <div>
                <IRow k="Status" v={obj.status === "open" ? <CertChip cert="rfi" /> : <span className="pill green">answered</span>} />
                <IRow k="System" v={<SysTag system={obj.system} />} />
                <IRow k="Raised by" v={obj.raisedBy} />
                <IRow k="Age" v={obj.age} />
                <IRow k="Links" v={obj.links} />
                <IRow k="Gates work" v={obj.blocks ? "Yes" : "No"} bad={obj.blocks} />
              </div>
            </div>
            {obj.answer && <div className="jbx-insp-sec"><div className="jbx-insp-lbl">Answer</div><div className="rfi-answer">{obj.answer}</div></div>}
            {obj.status === "open" && <div className="insp-actions"><button className="btn primary"><Ic n="check" s={13} /> Record answer</button></div>}
          </>
        )}

        {kind === "material" && (
          <div className="jbx-insp-sec">
            <div className="jbx-insp-lbl">Detail</div>
            <div>
              <IRow k="Stage" v={obj.stage} />
              <IRow k="Lead" v={obj.lead} bad={obj.risk} />
              <IRow k="Value" v={obj.value} />
              <IRow k="Status" v={obj.status} />
              {obj.note && <IRow k="Flag" v={obj.note} bad />}
            </div>
          </div>
        )}

        {kind === "plan" && (
          <div className="jbx-insp-sec">
            <div className="jbx-insp-lbl">Detail</div>
            <div>
              <IRow k="Rev" v={obj.rev} />
              <IRow k="Status" v={obj.current ? "Current" : "Superseded"} bad={!obj.current} />
              <IRow k="Pages" v={obj.pages} />
              <IRow k="Linked tasks" v={obj.linked || "—"} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Center canvas: the global review queue ───────────────────────────────────
function ReviewQueue({ d, rvqList, idx, onAct, onClose, onSelect }) {
  const total = rvqList.length;
  const cleared = rvqList.filter((r) => { const o = findSel(d, r); return o && !isReview(o.cert); }).length;
  const done = idx >= total;

  if (total === 0) {
    return (
      <div className="rvq">
        <div className="rvq-done">
          <div className="rd-ic"><Ic n="check-circle" s={28} /></div>
          <h3>Nothing to review</h3>
          <p>Every scope line, task and area has been triaged. New suggestions land here as documents are read.</p>
          <button className="btn" onClick={onClose}>Back to the builder</button>
        </div>
      </div>
    );
  }
  if (done) {
    const left = total - cleared;
    return (
      <div className="rvq">
        <div className="rvq-done">
          <div className="rd-ic"><Ic n="check-circle" s={28} /></div>
          <h3>Queue cleared</h3>
          <p>{cleared} of {total} triaged{left ? ` · ${left} still flagged Needs review` : " — all confirmed, ignored or raised as RFIs"}.</p>
          <button className="btn primary" onClick={onClose}>Back to the builder</button>
        </div>
      </div>
    );
  }

  const ref = rvqList[idx];
  const obj = findSel(d, ref) || {};
  const kind = ref.kind;
  const title = obj.name || obj.text || "";
  const meta = [];
  if (kind === "scope") { meta.push(["Clause", obj.ref]); meta.push(["System", obj.system]); meta.push(["Drives", obj.drives]); meta.push(["Plan", obj.plan || "—"]); }
  else if (kind === "task") { meta.push(["Area", obj.area || "— none"]); meta.push(["Stage", obj.stage]); meta.push(["System", obj.system || "—"]); meta.push(["Worker", obj.worker || "unassigned"]); }
  else if (kind === "area") { meta.push(["Group", obj.group]); meta.push(["Level", obj.level]); meta.push(["Rough-in", obj.roughIn]); meta.push(["Fit-off", obj.fitOff]); }
  else if (kind === "product") { meta.push(["Code", obj.code]); meta.push(["Type", obj.type]); meta.push(["Area", obj.area]); meta.push(["System", obj.system]); }

  const upNext = [];
  for (let i = idx + 1; i < total && upNext.length < 3; i++) { const o = findSel(d, rvqList[i]); if (o) upNext.push({ ref: rvqList[i], o }); }

  return (
    <div className="rvq">
      <div className="rvq-top">
        <button className="rvq-close" onClick={onClose}><Ic n="chevron-right" s={14} cls="flip" /> Close queue</button>
        <div className="rvq-prog"><i style={{ width: (total ? (cleared / total) * 100 : 0) + "%" }} /></div>
        <span className="rvq-count">{cleared} of {total} cleared</span>
      </div>

      <div className="rvq-card">
        <div className="rvq-card-h">
          <span className="rvq-kind">{KIND_LABEL[kind]}</span>
          <CertChip cert={obj.cert} />
          <span className="rvq-ref">{obj.id || obj.ref}</span>
        </div>
        <div className="rvq-body">
          <div className="rvq-title">{title}</div>
          {(kind === "task" && taskBroken(obj))
            ? <div className="rvq-note"><Ic n="alert-octagon" s={15} cls="ic" style={{ color: "var(--red)" }} /><span>{obj.note || "No area or instruction — the field won't know where or what."}</span></div>
            : obj.note ? <div className="rvq-note"><Ic n="alert-triangle" s={15} cls="ic" /><span>{obj.note}</span></div> : null}
          <div className="rvq-meta">
            {meta.map(([k, v], i) => (
              <div className="rm" key={i}><span className="k">{k}</span><span className="v">{k === "System" && v && v !== "—" ? <SysTag system={v} /> : v}</span></div>
            ))}
          </div>
        </div>
        <div className="rvq-acts">
          <button className="rvq-btn confirm" onClick={() => onAct("confirm")}><Ic n="check" s={15} /> Confirm</button>
          <button className="rvq-btn review" onClick={() => onAct("review")}><Ic n="alert-triangle" s={15} /> Needs review</button>
          <button className="rvq-btn rfi" onClick={() => onAct("rfi")}><Ic n="alert-octagon" s={15} /> RFI</button>
          <button className="rvq-btn ignore" onClick={() => onAct("ignore")}><Ic n="circle" s={15} /> Ignore</button>
        </div>
      </div>

      <div className="rvq-keys">
        <span className="rvq-key"><span className="kbd">C</span> confirm</span>
        <span className="rvq-key"><span className="kbd">R</span> RFI</span>
        <span className="rvq-key"><span className="kbd">X</span> ignore</span>
        <span className="rvq-key"><span className="kbd">␣</span> needs review · next</span>
      </div>

      {upNext.length > 0 && (
        <div className="rvq-scan">
          <div className="rvq-scan-h">Up next</div>
          {upNext.map(({ ref: r, o }, i) => (
            <div className="rvq-scan-row" key={i} onClick={() => onSelect(r.kind, r.id)}>
              <span className="rvq-kind">{KIND_LABEL[r.kind]}</span>
              <span className="sname">{o.name || o.text}</span>
              <CertChip cert={o.cert} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Cockpit shell ───────────────────────────────────────────────────────────
function BuilderCockpit({ jobId, onClose }) {
  const B0 = window.BX.builder;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const [scopeItems, setScopeItems] = useState(() => clone(B0.scope.items));
  const [tasks, setTasks] = useState(() => clone(B0.tasks));
  const [areaGroups, setAreaGroups] = useState(() => clone(B0.areaGroups));
  const [products, setProducts] = useState(() => clone(B0.products.items));
  const [crew, setCrew] = useState(() => clone(B0.crew));
  const [published, setPublished] = useState(false);

  const [sect, setSect] = useState("overview");
  const [sel, setSel] = useState(null);
  const [rvqList, setRvqList] = useState([]);
  const [rvqIdx, setRvqIdx] = useState(0);
  const [rvqFrom, setRvqFrom] = useState("scope");

  const d = useMemo(() => Object.assign({}, B0, {
    scope: Object.assign({}, B0.scope, { items: scopeItems }),
    tasks, areaGroups, crew,
    products: Object.assign({}, B0.products, { items: products }),
    published,
  }), [scopeItems, tasks, areaGroups, products, crew, published, B0]);

  const model = useMemo(() => buildModel(d), [d]);

  function setCert(kind, id, next) {
    if (kind === "scope") setScopeItems((a) => a.map((i) => (i.id === id ? Object.assign({}, i, { cert: next }) : i)));
    else if (kind === "task") setTasks((a) => a.map((t) => (t.id === id ? Object.assign({}, t, { cert: next }) : t)));
    else if (kind === "product") setProducts((a) => a.map((p) => (p.id === id ? Object.assign({}, p, { cert: next }) : p)));
    else if (kind === "area") setAreaGroups((gs) => gs.map((g) => Object.assign({}, g, { areas: g.areas.map((a) => (a.id === id ? Object.assign({}, a, { cert: next }) : a)) })));
  }

  function openReview(filter) {
    const list = [];
    const add = (k, arr, getId) => arr.forEach((x) => { if (isReview(x.cert)) list.push({ kind: k, id: getId(x) }); });
    if (!filter || filter === "scope") add("scope", scopeItems, (x) => x.id);
    if (!filter || filter === "task") add("task", tasks, (x) => x.id);
    if (!filter || filter === "area") areaGroups.forEach((g) => g.areas.forEach((a) => { if (isReview(a.cert)) list.push({ kind: "area", id: a.id }); }));
    if (!filter || filter === "product") add("product", products, (x) => x.id);
    setRvqList(list); setRvqIdx(0);
    setRvqFrom(sect === "review" ? rvqFrom : sect);
    setSect("review");
  }

  function rvqAct(action) {
    const ref = rvqList[rvqIdx];
    if (ref) {
      const next = action === "confirm" ? "confirmed" : action === "ignore" ? "ignored" : action === "rfi" ? "rfi" : "review";
      setCert(ref.kind, ref.id, next);
    }
    setRvqIdx((i) => i + 1);
  }

  const act = {
    go: (k) => setSect(k),
    select: (kind, id) => setSel({ kind, id }),
    setCert, toggleVis: (id) => setTasks((a) => a.map((t) => (t.id === id ? Object.assign({}, t, { vis: !t.vis }) : t))),
    setTaskField: (id, patch) => setTasks((a) => a.map((t) => (t.id === id ? Object.assign({}, t, patch) : t))),
    recordInduction: (id) => setCrew((cs) => cs.map((c) => (c.id === id ? Object.assign({}, c, { induction: "ok" }) : c))),
    openReview, publish: () => setPublished((p) => !p),
  };

  // Keyboard shortcuts while the review queue is open.
  useEffect(() => {
    if (sect !== "review") return;
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if (k === "c") { e.preventDefault(); rvqAct("confirm"); }
      else if (k === "r") { e.preventDefault(); rvqAct("rfi"); }
      else if (k === "x" || k === "i") { e.preventDefault(); rvqAct("ignore"); }
      else if (k === " " || k === "enter" || k === "n") { e.preventDefault(); rvqAct("review"); }
      else if (k === "escape") { e.preventDefault(); setSect(rvqFrom || "scope"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sect, rvqIdx, rvqList, rvqFrom]);

  const canvas = sect === "review"
    ? <ReviewQueue d={d} rvqList={rvqList} idx={rvqIdx} onAct={rvqAct} onClose={() => setSect(rvqFrom || "scope")} onSelect={act.select} />
    : (() => { const Comp = window.BSections[sect] || window.BSections.overview; return <Comp d={d} model={model} act={act} sel={sel} />; })();

  const reviewActive = sect === "review";

  return (
    <div className="jbx">
      <div className="jbx-top">
        <img className="jbx-logo os-hdr-logo" src="brand/buhl-logo-ink.png" alt="bühl electrical" />
        <button className="jbx-back" onClick={onClose}><Ic n="chevron-right" s={16} cls="flip" /> Job hub</button>
        <div className="jbx-top-id"><b>Job Builder</b><span>{d.overview.name} · {d.overview.ref}</span></div>
        <div className="jbx-ready">
          <button className="btn" onClick={() => act.openReview()} style={reviewActive ? { borderColor: "var(--yellow)" } : null}>
            <Ic n="clipboard-check" s={14} /> Review queue
            {model.reviewTotal > 0 && <span className="jbx-rail-count" style={{ marginLeft: 2 }}>{model.reviewTotal}</span>}
          </button>
          <div className="jbx-ready-bar"><i style={{ width: model.pct + "%" }} /></div>
          <span className="mono">{model.pct}% · {model.blockers.length} blocker{model.blockers.length === 1 ? "" : "s"}</span>
        </div>
        <button className="btn" onClick={onClose}>Save & close</button>
        <button className="btn primary" onClick={() => act.go("publish")}>{model.blockers.length ? "Review publish" : published ? "Published ✓" : "Publish"}</button>
      </div>

      <div className="jbx-grid">
        <aside className="jbx-rail">
          <div className="jbx-meter">
            <div className="jbx-meter-top">
              <div className="jbx-meter-pct">{model.pct}%</div>
              <span className={"jbx-meter-state " + model.state}>{model.stateLabel}</span>
            </div>
            <div className="jbx-meter-cap">Readiness · scope & tasks triaged</div>
            <div className="jbx-meter-bar"><i className={model.state} style={{ width: model.pct + "%" }} /></div>
            <div className="jbx-meter-split">
              <div className="jbx-ms block" onClick={() => act.go("publish")}><b>{model.blockers.length}</b><span>Blockers</span></div>
              <div className="jbx-ms warn" onClick={() => act.go("publish")}><b>{model.warnings.length}</b><span>Warnings</span></div>
            </div>
          </div>

          <button className={"jbx-rail-item rvq" + (reviewActive ? " on" : "")} onClick={() => act.openReview()}>
            <Ic n="clipboard-check" s={15} cls="jbx-rail-ic" />
            <span className="jbx-rail-t">Review queue</span>
            <span className="jbx-rail-end">{model.reviewTotal > 0 ? <span className="jbx-rail-count">{model.reviewTotal}</span> : <span className="jbx-rail-tick"><Ic n="check-circle" s={14} /></span>}</span>
          </button>

          {RAIL.map((grp) => (
            <div key={grp.group}>
              <div className="jbx-rail-group">{grp.group}</div>
              {grp.items.map((s) => (
                <button key={s.k} className={"jbx-rail-item" + (sect === s.k ? " on" : "")} onClick={() => act.go(s.k)}>
                  <Ic n={s.ic} s={15} cls="jbx-rail-ic" />
                  <span className="jbx-rail-t">{s.t}</span>
                  <span className="jbx-rail-end">{railEnd(model.sectionMeta[s.k])}</span>
                </button>
              ))}
            </div>
          ))}
        </aside>

        <main className="jbx-canvas">{canvas}</main>

        <aside className="jbx-ctx">
          <Inspector d={d} sel={sel} act={act} />
        </aside>
      </div>
    </div>
  );
}

Object.assign(window, { BuilderCockpit });
