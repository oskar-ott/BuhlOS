// admin-builder-sections.jsx — the 13 section canvases for the Job Builder v2
// cockpit. Pure presentational: each takes a common ctx ({ d, model, act, sel })
// from BuilderCockpit, reads the LIVE state, and calls act.* to mutate it.
// Shared atoms (CertChip, SysTag, CvHead, FS, Fld) + the BSections registry are
// exported to window so admin-builder.jsx can route to them.

const CERT_LABEL = {
  suggested: "Suggested", review: "Needs review", confirmed: "Confirmed",
  converted: "Converted", ignored: "Ignored", rfi: "RFI",
};

// The certainty badge — mono uppercase chip + state dot (StatusChip family).
function CertChip({ cert, lg }) {
  return (
    <span className={"cchip " + cert + (lg ? " lg" : "")}>
      <span className="cdot" />{CERT_LABEL[cert] || cert}
    </span>
  );
}
function SysTag({ system }) {
  if (!system) return null;
  return <span className={"systag " + system}>{system}</span>;
}

function CvHead({ title, sub, block, phil, right }) {
  return (
    <div className="jbx-cvh">
      <div>
        <h2>{title}{block && <span className="tag-block">blocks publish</span>}{phil && <span className="tag-phil">shows in Phil</span>}</h2>
        {sub && <div className="jbx-cvh-sub">{sub}</div>}
      </div>
      {right}
    </div>
  );
}
function FS({ n, title, right, children }) {
  return (
    <div className="jb-fs">
      <div className="jb-fs-h">{n != null && <span className="fh-n">{n}</span>}<h3>{title}</h3>{right && <span className="fh-r">{right}</span>}</div>
      {children}
    </div>
  );
}
function Fld({ label, value, span }) {
  return <div className={"jb-fld" + (span ? " span" + span : "")}><div className="fl">{label}</div><div className="jb-input">{value}</div></div>;
}

const isReview = (c) => c === "suggested" || c === "review";
const taskBroken = (t) => !t.area || !t.instruction;
const cnt = (arr, pred) => arr.filter(pred).length;

// ── OVERVIEW ────────────────────────────────────────────────────────────────
function SecOverview({ d, model, act }) {
  const o = d.overview;
  const fieldVisible = cnt(d.tasks, (t) => t.vis && (t.cert === "confirmed" || t.cert === "converted"));
  const live = cnt(d.tasks, (t) => t.cert === "converted");
  return (
    <>
      <CvHead title="Job overview" block sub="The identity of the job and the pre-start facts a crew needs before they arrive — and the running readiness it rolls up to. This becomes the header card in Phil." />
      <div className="ov-head">
        <div className="ov-meter">
          <div className="ov-meter-top">
            <div className="ov-pct">{model.pct}%</div>
            <div>
              <span className={"jbx-meter-state " + model.state}>{model.stateLabel}</span>
              <div className="jbx-meter-cap">scope &amp; tasks triaged</div>
            </div>
          </div>
          <div className="ov-bw">
            <div className="ov-bw-c block" onClick={() => act.go("publish")}>
              <div className="n">{model.blockers.length}</div>
              <div className="l">Blockers · stop publish</div>
            </div>
            <div className="ov-bw-c warn" onClick={() => act.go("publish")}>
              <div className="n">{model.warnings.length}</div>
              <div className="l">Warnings · advisory</div>
            </div>
          </div>
          <div className="ov-lint">
            {model.blockers.slice(0, 3).map((b, i) => (
              <div className="ov-lint-row" key={i}><Ic n="alert-triangle" s={13} cls="ic" style={{ color: "var(--red)" }} /><span>{b.msg}</span></div>
            ))}
            {model.blockers.length === 0 && <div className="ov-lint-row"><Ic n="check-circle" s={13} cls="ic" style={{ color: "var(--green)" }} /><span>No blockers — the gate is clear to publish.</span></div>}
          </div>
        </div>
        <div className="ov-field-card">
          <div className="ofc-h"><Ic n="eye" s={12} /> What the field sees</div>
          <div className="ofc-j">{o.shortName}</div>
          <div className="ofc-m">{o.philLevel} · Day {o.day}/{o.days}</div>
          <div className="ofc-stat">
            <div className="s"><b>{fieldVisible}</b><span>field-visible</span></div>
            <div className="s"><b>{live}</b><span>live tasks</span></div>
            <div className="s"><b>{o.induction ? "Yes" : "No"}</b><span>induction</span></div>
          </div>
        </div>
      </div>
      <FS n="A" title="Identity">
        <div className="jb-grid">
          <Fld label="Job name" value={o.name} span={2} />
          <Fld label="Reference" value={o.ref} />
          <Fld label="Client / builder" value={o.client} />
          <Fld label="Site address" value={o.address} span={2} />
          <Fld label="Drawing set" value={o.dwg} />
          <Fld label="Job type" value={o.type} />
        </div>
      </FS>
      <FS n="B" title="Program">
        <div className="jb-grid c3">
          <Fld label="Start" value={o.start} />
          <Fld label="Finish" value={o.finish} />
          <Fld label="Day" value={`Day ${o.day} of ${o.days}`} />
        </div>
      </FS>
      <FS n="C" title="Site conditions & pre-start" right={<span className="tag-phil">Phil pre-start</span>}>
        <div className="jb-grid c2">
          <Fld label="Induction required" value={o.induction ? "Yes · " + o.inductionVia : "No"} />
          <Fld label="Site hours" value={o.siteHours} />
          <Fld label="Site contact" value={`${o.contact} · ${o.phone}`} />
          <Fld label="Parking" value={o.parking} />
          <Fld label="Safety" value={o.safety} span={2} />
        </div>
      </FS>
    </>
  );
}

// ── SCOPE INTAKE ──────────────────────────────────────────────────────────────
function SecScope({ d, act, sel }) {
  const [filt, setFilt] = useState("all");
  const items = d.scope.items;
  const review = cnt(items, (i) => isReview(i.cert));
  const shown = items.filter((i) =>
    filt === "all" ? true :
    filt === "review" ? isReview(i.cert) :
    i.cert === filt);
  const fc = (k) => filt === k ? "on" : "";
  return (
    <>
      <CvHead title="Scope intake" block
        sub="Drop the SOW, drawings and schedules — the builder reads them and proposes scope lines. Nothing reaches Phil until a human confirms it. Confirm turns a line into a task; it is never auto-applied."
        right={<button className="btn primary" disabled={review === 0} onClick={() => act.openReview("scope")}><Ic n="clipboard-check" s={13} /> Review {review}</button>} />
      <div className="sc-drop"><Ic n="file-text" s={20} /><div className="sc-drop-b"><b>{d.scope.docs.length} documents read</b><small>{d.scope.docs.join(" · ")} — drag more to add</small></div><button className="btn">Add docs</button></div>
      <div className="seg-row" style={{ marginTop: 4 }}>
        <div className="seg">
          {[["all", "All " + items.length], ["review", "Needs review " + review], ["confirmed", "Confirmed"], ["rfi", "RFI"], ["ignored", "Ignored"]].map(([k, t]) => (
            <button key={k} className={fc(k)} onClick={() => setFilt(k)}>{t}</button>
          ))}
        </div>
        <div className="spacer" />
        <span className="mono dim">{cnt(items, (i) => i.cert === "confirmed" || i.cert === "converted")} confirmed · {cnt(items, (i) => i.cert === "rfi")} RFI</span>
      </div>
      <div className="card" style={{ marginTop: 10 }}>
        <div className="ex-list" style={{ padding: "0 16px" }}>
          {shown.map((it) => {
            const on = sel && sel.kind === "scope" && sel.id === it.id;
            return (
              <div className={"ex-row" + (on ? " sel-row" : "")} key={it.id} onClick={() => act.select("scope", it.id)} style={on ? { background: "var(--paper-2)" } : null}>
                <span className="ex-ref mono">{it.ref}</span>
                <div className="ex-b">
                  <div className="ex-t">{it.text}</div>
                  <div className="ex-n" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
                    <SysTag system={it.system} />{it.note && <span>{it.note}</span>}
                  </div>
                </div>
                <span className="ex-drives mono">{it.drives}</span>
                <CertChip cert={it.cert} />
              </div>
            );
          })}
          {shown.length === 0 && <div className="ex-row" style={{ color: "var(--ink-3)", justifyContent: "center" }}>Nothing in this filter.</div>}
        </div>
      </div>
    </>
  );
}

// ── AREAS ───────────────────────────────────────────────────────────────────
function SecAreas({ d, act, sel }) {
  const total = d.areaGroups.reduce((a, g) => a + g.areas.length, 0);
  const sugg = d.areaGroups.reduce((a, g) => a + cnt(g.areas, (x) => x.cert === "suggested"), 0);
  return (
    <>
      <CvHead title="Areas & zones" phil
        sub={`${total} areas across ${d.areaGroups.length} groups${sugg ? ` · ${sugg} suggested from the drawings, not yet confirmed` : ""}. An area is a facet of a task — this is the place-first view the crew navigates by.`}
        right={<button className="btn"><Ic n="map" s={13} /> Add area</button>} />
      <div className="area-groups">
        {d.areaGroups.map((g) => (
          <div className="area-group" key={g.id}>
            <div className="ag-h"><b>{g.name}</b><span className="mono dim">{g.areas.length} {g.areas.length === 1 ? "area" : "areas"}</span></div>
            <div className="area-grid">
              {g.areas.map((a) => {
                const on = sel && sel.kind === "area" && sel.id === a.id;
                return (
                  <div className={"area-card" + (on ? " on" : "")} key={a.id} onClick={() => act.select("area", a.id)}>
                    <div className="ac-top"><span className="ac-level mono">{a.level}</span><CertChip cert={a.cert} /></div>
                    <div className="ac-name">{a.name}</div>
                    <div style={{ display: "flex", gap: 5, marginTop: 7, flexWrap: "wrap" }}>{(a.systems || []).map((s) => <SysTag key={s} system={s} />)}</div>
                    <div className="ac-tasks"><span><b>{a.roughIn}</b> rough-in</span><span><b>{a.fitOff}</b> fit-off</span></div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ── STAGES (with close gates) ─────────────────────────────────────────────────
function SecStages({ d }) {
  const enabled = d.stages.filter((s) => s.enabled);
  return (
    <>
      <CvHead title="Stages" phil sub={`${enabled.length} of ${d.stages.length} stages enabled, in trade sequence. Each stage carries a close GATE — the conditions that must be met before it can be signed off and the next stage opens.`} />
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {d.stages.map((s) => {
          if (!s.enabled) {
            return (
              <div className="sgate stage-disabled" key={s.id}>
                <div className="sgate-h"><div className="jb-tog"><span className="sw" /></div><span className="gname">{s.name}</span><span className="gstate mono dim">off</span></div>
              </div>
            );
          }
          const conds = (s.gate && s.gate.conditions) || [];
          const open = conds.filter((c) => !c.met).length;
          return (
            <div className="sgate" key={s.id}>
              <div className="sgate-h">
                <div className="jb-tog on"><span className="sw" /></div>
                <span className="gname">{s.name}</span>
                {!s.gate ? <span className="gstate mono dim">no gate</span> :
                  <span className="gstate">{open === 0
                    ? <span className="pill green">gate clear</span>
                    : <span className="pill amber">{open} to close</span>}</span>}
              </div>
              {conds.map((c, i) => (
                <div className={"sgate-c " + (c.met ? "met" : "unmet")} key={i}>
                  <Ic n={c.met ? "check-circle" : "circle"} s={15} cls="gc-mk" />
                  <span className="gc-l">{c.label}</span>
                  {c.detail && <span className="gc-d">{c.detail}</span>}
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── TASKS (the spine) ─────────────────────────────────────────────────────────
function SecTasks({ d, act, sel }) {
  const [filt, setFilt] = useState("all");
  const tasks = d.tasks;
  const review = cnt(tasks, (t) => isReview(t.cert));
  const broken = cnt(tasks, taskBroken);
  const shown = tasks.filter((t) =>
    filt === "all" ? true :
    filt === "review" ? isReview(t.cert) :
    filt === "unassigned" ? !t.worker :
    filt === "broken" ? taskBroken(t) :
    filt === "field" ? t.vis : true);
  const fc = (k) => filt === k ? "on" : "";
  return (
    <>
      <CvHead title="Tasks" block
        sub="The operational spine. Every row is one task instance with its facets — area · stage · system · worker · proof — and a certainty state. Only Confirmed tasks reach the field. No task ships without an area AND an instruction."
        right={<button className="btn primary" disabled={review === 0} onClick={() => act.openReview("task")}><Ic n="clipboard-check" s={13} /> Review {review}</button>} />
      <div className="seg-row" style={{ marginTop: 2 }}>
        <div className="seg">
          {[["all", "All " + tasks.length], ["review", "Needs review " + review], ["unassigned", "Unassigned"], ["field", "Field-visible"], ["broken", "Incomplete " + broken]].map(([k, t]) => (
            <button key={k} className={fc(k)} onClick={() => setFilt(k)}>{t}</button>
          ))}
        </div>
        <div className="spacer" />
        <span className="mono dim">{cnt(tasks, (t) => t.cert === "confirmed" || t.cert === "converted")} confirmed · {cnt(tasks, (t) => t.vis)} field-visible</span>
      </div>
      <div className="card" style={{ marginTop: 10 }}>
        <table className="dtable">
          <thead><tr><th>Task</th><th>Area</th><th>Stage</th><th>System</th><th>Worker</th><th className="num">Proof</th><th>Certainty</th></tr></thead>
          <tbody>
            {shown.map((t) => {
              const on = sel && sel.kind === "task" && sel.id === t.id;
              const bad = taskBroken(t);
              return (
                <tr key={t.id} className={"click" + (bad ? " risk" : "")} onClick={() => act.select("task", t.id)} style={on ? { background: "var(--paper-2)", boxShadow: "inset 2px 0 0 var(--yellow)" } : null}>
                  <td><div className="cell-name" style={{ fontSize: 13 }}>{t.name}<small>{t.id}{!t.vis ? " · office-only" : ""}</small></div></td>
                  <td className="cell-sub">{t.area || <span style={{ color: "var(--red)" }}>no area</span>}</td>
                  <td className="cell-sub">{t.stage}</td>
                  <td><SysTag system={t.system} /></td>
                  <td className="cell-mono">{t.worker || <span style={{ color: "var(--ink-3)" }}>—</span>}</td>
                  <td className="num cell-mono">{t.proof || "—"}</td>
                  <td><CertChip cert={t.cert} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── PLANS ─────────────────────────────────────────────────────────────────────
function SecPlans({ d, act, sel }) {
  return (
    <>
      <CvHead title="Plans & documents" phil sub="One current revision, always. Mark the current rev, link pages to tasks, and force a re-ack when a drawing is superseded — so nobody works to a dead plan." />
      <div className="lint-r err"><Ic n="alert-triangle" s={16} /><div><b>{d.planAlert.msg}</b><small>{d.planAlert.detail}</small></div><button className="btn">Force re-ack</button></div>
      <div className="card" style={{ marginTop: 10 }}>
        <table className="dtable">
          <thead><tr><th>Document</th><th>Rev</th><th className="num">Pages</th><th className="num">Linked tasks</th><th>Status</th></tr></thead>
          <tbody>
            {d.plans.map((p, i) => {
              const on = sel && sel.kind === "plan" && sel.id === p.id + p.rev;
              return (
                <tr key={i} className="click" onClick={() => act.select("plan", p.id + p.rev)} style={on ? { background: "var(--paper-2)" } : null}>
                  <td><div className="cell-name" style={{ fontSize: 13 }}>{p.name}<small>{p.id}{p.note ? " · " + p.note : ""}</small></div></td>
                  <td className="cell-mono">rev {p.rev}</td>
                  <td className="num cell-mono">{p.pages}</td>
                  <td className="num cell-mono">{p.linked || "—"}</td>
                  <td>{p.current ? <span className="pill green">current</span> : <span className="pill grey">superseded</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── MATERIALS ───────────────────────────────────────────────────────────────
function SecMaterials({ d, act, sel }) {
  const m = d.materials;
  return (
    <>
      <CvHead title="Materials & equipment" sub="Ready by stage, not in the abstract. Each line tracks planned → ordered → delivered; long-lead items and scope gaps are flagged against the program." right={<span className="tag-opt">warn-only at publish</span>} />
      <div className="lint-r warn"><Ic n="clock" s={16} /><div><b>{m.alert}</b><small>{m.counts.lines} lines · {m.counts.longLead} long-lead · {m.counts.scopeGap} scope gap</small></div></div>
      <div className="card" style={{ marginTop: 10 }}>
        <table className="dtable">
          <thead><tr><th>Item</th><th>Stage</th><th>Lead</th><th className="num">Value</th><th>Status</th></tr></thead>
          <tbody>
            {m.rows.map((r) => {
              const on = sel && sel.kind === "material" && sel.id === r.id;
              return (
                <tr key={r.id} className={"click" + (r.risk ? " risk" : "")} onClick={() => act.select("material", r.id)} style={on ? { boxShadow: "inset 2px 0 0 var(--yellow)" } : null}>
                  <td><div className="cell-name" style={{ fontSize: 13 }}>{r.item}{r.note ? <small>{r.note}</small> : null}</div></td>
                  <td className="cell-sub">{r.stage}</td>
                  <td className="cell-mono" style={{ color: r.risk ? "var(--amber)" : "var(--ink-3)" }}>{r.lead}</td>
                  <td className="num cell-mono">{r.value}</td>
                  <td><span className={"pill " + (r.status === "delivered" ? "green" : r.status === "ordered" ? "navy" : "grey")}>{r.status}</span></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── GEAR ──────────────────────────────────────────────────────────────────────
function SecGear({ d }) {
  const g = d.gear;
  return (
    <>
      <CvHead title="Gear & site setup" sub="Assign the testers, temp boards, leads, keys and passes the job needs — to the job, an area, a stage or a worker. The pack-up list writes itself." />
      <div className="jb-grid c2" style={{ alignItems: "start", border: 0, padding: 0, gap: 12 }}>
        <FS title="Assigned to this job" right={<span className="mono dim">{g.assigned.length}</span>}>
          {g.assigned.map((x) => (
            <div className="row" key={x.id}><Ic n="wrench" s={15} cls="dim" /><div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}>{x.label}</div><div className="row-meta">{x.id}</div></div><span className="src-badge">{x.scope}: {x.to}</span></div>
          ))}
        </FS>
        <FS title="Still needed" right={<span className="mono dim">{g.needed.length}</span>}>
          {g.needed.map((n, i) => (
            <div className="row" key={i}><Ic n="circle" s={14} cls="dim" /><div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}>{n}</div></div><button className="btn">Assign</button></div>
          ))}
        </FS>
      </div>
    </>
  );
}

// ── ITPs / QA ─────────────────────────────────────────────────────────────────
function SecItps({ d }) {
  return (
    <>
      <CvHead title="ITPs / QA" sub="Inspection & test points set on the job now, captured in the field later. Hold points stop the work until signed; witness points need a second set of eyes; records are evidence of test." right={<button className="btn"><Ic n="clipboard-list" s={13} /> Add ITP</button>} />
      <div className="card">
        <table className="dtable">
          <thead><tr><th>Inspection / test point</th><th>Stage</th><th>Area</th><th>Type</th><th>Status</th></tr></thead>
          <tbody>
            {d.itps.map((it) => (
              <tr key={it.id}>
                <td><div className="cell-name" style={{ fontSize: 13 }}>{it.name}<small>{it.id}</small></div></td>
                <td className="cell-sub">{it.stage}</td>
                <td className="cell-sub">{it.area}</td>
                <td><span className={"itp-type " + it.type}>{it.type}</span></td>
                <td><span className="pill grey">scheduled</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="lint-r info"><Ic n="clipboard-check" s={16} /><div><b>All {d.itps.length} ITPs are scheduled and wired to a stage.</b><small>They become capture prompts in Phil — none can be signed off from the desk.</small></div></div>
    </>
  );
}

// ── RISKS & RFIs ────────────────────────────────────────────────────────────
function SecRisks({ d, act, sel }) {
  const open = cnt(d.rfis, (r) => r.status === "open");
  return (
    <>
      <CvHead title="Risks & RFIs" sub="The unknowns. An RFI is how the office says “we don't know yet” out loud — never a guess on the drawing. Open RFIs that gate work are flagged; risks carry the control that makes them safe." right={<button className="btn primary"><Ic n="alert-triangle" s={13} /> Raise RFI</button>} />
      <FS title="RFIs" right={<span className="mono dim">{open} open · {d.rfis.length - open} answered</span>}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 14 }}>
          {d.rfis.map((r) => {
            const on = sel && sel.kind === "rfi" && sel.id === r.id;
            return (
              <div className={"rfi-card " + r.status} key={r.id} onClick={() => act.select("rfi", r.id)} style={on ? { boxShadow: "0 0 0 1px var(--yellow)" } : null}>
                <div className="rfi-top">
                  <span className="rfi-id">{r.id}</span><SysTag system={r.system} />
                  {r.blocks && <span className="tag-block">blocks work</span>}
                  <span style={{ marginLeft: "auto" }}>{r.status === "open" ? <CertChip cert="rfi" /> : <span className="pill green">answered</span>}</span>
                </div>
                <div className="rfi-q">{r.q}</div>
                <div className="rfi-meta">Raised by {r.raisedBy} · {r.age} · links {r.links}</div>
                {r.answer && <div className="rfi-answer"><b>Answer:</b> {r.answer}</div>}
              </div>
            );
          })}
        </div>
      </FS>
      <FS title="Risks" right={<span className="mono dim">{d.risks.length}</span>}>
        {d.risks.map((r) => (
          <div className="risk-row" key={r.id}>
            <span className={"risk-sev " + r.sev} />
            <div className="risk-b"><div className="risk-t">{r.text}</div><div className="risk-c"><b>Control:</b> {r.control}</div></div>
            <span className={"pill " + (r.sev === "high" ? "red" : "amber")}>{r.sev}</span>
          </div>
        ))}
      </FS>
    </>
  );
}

// ── CREW ──────────────────────────────────────────────────────────────────────
function SecCrew({ d, act }) {
  const noInd = cnt(d.crew, (c) => c.induction === "missing");
  const expL = cnt(d.crew, (c) => c.licences === "expiring");
  const stateChip = (k, v) => {
    const map = { ok: ["ok", "check-circle", "Clear"], missing: ["missing", "alert-triangle", "Missing"], expiring: ["expiring", "clock", "Expiring"], na: ["na", "circle", "N/A"] };
    const [cls, ic, lbl] = map[v] || map.na;
    return <span className={"crew-state " + cls}><Ic n={ic} s={12} /> {lbl}</span>;
  };
  return (
    <>
      <CvHead title="Crew" block sub="Who's on the job, and whether they can actually start Monday. Pre-start readiness is computed per worker from the real registers — a gap is named, never faked green." />
      {noInd > 0 && <div className="lint-r err"><Ic n="user-x" s={16} /><div><b>{noInd} {noInd === 1 ? "worker is" : "workers are"} not inducted</b><small>Blocks the pre-start gate — they can't be on site until it clears.</small></div></div>}
      {expL > 0 && <div className="lint-r warn"><Ic n="clock" s={16} /><div><b>{expL} licence expiring</b><small>Advisory — check currency before the work that needs it.</small></div></div>}
      <div className="card" style={{ marginTop: 10 }}>
        <table className="dtable">
          <thead><tr><th>Worker</th><th>Role</th><th>Induction</th><th>Licences</th><th>Pre-start</th></tr></thead>
          <tbody>
            {d.crew.map((c) => {
              const ready = c.induction === "ok";
              return (
                <tr key={c.id}>
                  <td><div className="cell-name" style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}><span className="avatar sm">{initials(c.name)}</span>{c.name}</div></td>
                  <td className="cell-sub">{c.role}</td>
                  <td>{stateChip("induction", c.induction)}</td>
                  <td>{stateChip("licences", c.licences)}</td>
                  <td>{ready ? <span className="pill green">ready</span> : <button className="btn" onClick={() => act.recordInduction(c.id)}><Ic n="check" s={12} /> Record induction</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── PHIL PREVIEW (with field lint) ────────────────────────────────────────────
function SecPhilPreview({ d }) {
  const o = d.overview;
  const visible = d.tasks.filter((t) => t.vis && (t.cert === "confirmed" || t.cert === "converted"));
  const byArea = {};
  visible.forEach((t) => { (byArea[t.area] = byArea[t.area] || []).push(t); });
  const errs = d.fieldLint.filter((l) => l.sev === "err").length;
  return (
    <>
      <CvHead title="Phil preview" phil sub="A faithful preview of what the assigned worker opens on site — derived from the confirmed, field-visible tasks, not a mock. The field lint flags anything that would confuse the crew." />
      <div className="phil-prev">
        <div className="jbx-phone">
          <div className="jph-hdr"><div className="jph-ttl">{o.shortName}</div><div className="jph-sub">{o.philLevel} · Day {o.day}/{o.days}</div></div>
          <div className="jph-body">
            {o.induction && <div className="jph-prestart"><Ic n="shield-alert" s={13} /><div><b>Induction required</b><small>{o.inductionVia}</small></div></div>}
            {Object.keys(byArea).slice(0, 3).map((area) => (
              <div key={area}>
                <div className="jph-sec">{area}</div>
                {byArea[area].slice(0, 3).map((t) => (
                  <div className="jph-task" key={t.id}>
                    <span className="jph-check" />
                    <div className="jph-tb"><div className="jph-tt">{t.name}</div><div className="jph-tm">{t.stage}{t.proof ? " · proof " + t.proof : ""}</div></div>
                  </div>
                ))}
              </div>
            ))}
            <div className="jph-proof"><Ic n="camera" s={12} /> Proof required before sign-off</div>
          </div>
        </div>
        <div className="phil-lint">
          <div className="card-hdr" style={{ borderRadius: 9, border: "1px solid var(--rule)" }}>
            <h3>Field lint</h3>
            <span className="count">{errs ? errs + " blocking" : "no blockers"}</span>
          </div>
          {d.fieldLint.map((l, i) => (
            <div className={"lint-r " + (l.sev === "err" ? "err" : l.sev === "warn" ? "warn" : "info")} key={i}>
              <Ic n={l.sev === "err" ? "alert-octagon" : l.sev === "warn" ? "alert-triangle" : "eye"} s={16} />
              <div><b>{l.msg}</b><small>{l.detail}</small></div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ── PUBLISH ─────────────────────────────────────────────────────────────────
function SecPublish({ d, model, act }) {
  const ready = model.blockers.length === 0;
  return (
    <>
      <CvHead title="Publish to the field" sub="When every blocker clears, the job becomes visible to assigned crew in Phil. Office-only until then. Warnings are advisory — they never stop a publish." />
      <div className={"pub-banner " + (ready ? "ok" : "block")}>
        <Ic n={ready ? "check-circle" : "alert-triangle"} s={20} />
        <div>{ready
          ? (d.published ? <><b>Published.</b> Assigned crew can see this job in Phil now.</> : <><b>Ready to publish.</b> All blockers clear — the crew can start.</>)
          : <><b>{model.blockers.length} {model.blockers.length === 1 ? "blocker" : "blockers"} still open.</b> Clear these before the field can see the job.</>}</div>
      </div>
      <FS title="Blockers — stop publish" right={<span className="mono dim">{model.blockers.length}</span>}>
        {model.blockers.length === 0
          ? <div className="row" style={{ color: "var(--green)" }}><Ic n="check-circle" s={15} /><span style={{ marginLeft: 8 }}>No blockers.</span></div>
          : model.blockers.map((b, i) => (
            <div className="row" key={i} onClick={() => b.go && act.go(b.go)}>
              <Ic n="alert-triangle" s={15} style={{ color: "var(--red)" }} />
              <div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}>{b.msg}</div></div>
              {b.go && <span className="mono dim">{b.go} →</span>}
            </div>
          ))}
      </FS>
      <FS title="Warnings — advisory" right={<span className="mono dim">{model.warnings.length}</span>}>
        {model.warnings.map((w, i) => (
          <div className="row" key={i} onClick={() => w.go && act.go(w.go)}>
            <Ic n="alert-triangle" s={15} style={{ color: "var(--amber)" }} />
            <div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}>{w.msg}</div></div>
            {w.go && <span className="mono dim">{w.go} →</span>}
          </div>
        ))}
        {model.warnings.length === 0 && <div className="row" style={{ color: "var(--ink-3)" }}>None.</div>}
      </FS>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 4 }}>
        <button className={"btn lg " + (ready ? "primary" : "")} disabled={!ready} onClick={() => act.publish()}>
          {d.published ? "Unpublish" : ready ? "Publish job to the field →" : `Resolve ${model.blockers.length} blocker${model.blockers.length === 1 ? "" : "s"} to publish`}
        </button>
        <span className="mono dim">readiness {model.pct}% · {model.stateLabel}</span>
      </div>
      <FS title="History">
        <div className="row"><Ic n="history" s={14} cls="dim" /><div className="row-grow"><div className="row-title" style={{ fontSize: 12.5 }}>{d.published ? "Published to the field" : "Created from quote " + (d.overview.fromQuote || "—")}</div><div className="row-meta">{d.overview.created || "14 Apr 2026"} · {d.overview.client}</div></div></div>
      </FS>
    </>
  );
}

Object.assign(window, {
  CertChip, SysTag, CvHead, FS, Fld, CERT_LABEL, isReview, taskBroken,
  BSections: {
    overview: SecOverview, scope: SecScope, areas: SecAreas, stages: SecStages,
    tasks: SecTasks, plans: SecPlans, materials: SecMaterials, gear: SecGear,
    itps: SecItps, risks: SecRisks, crew: SecCrew, philpreview: SecPhilPreview,
    publish: SecPublish,
  },
});
