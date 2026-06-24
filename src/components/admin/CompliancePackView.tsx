import type { CompliancePack, PackInstanceSection } from "@/domains/itp/compliance-pack";

/**
 * Printable compliance pack (#286) — a print-first document the office hits
 * Cmd/Ctrl+P → "Save as PDF" and sends to the builder. Rendered full-page (no
 * AdminShell).
 *
 * House style matches the circuit-schedule document (SchedulePreview): the
 * bühl electrical letterhead with the real ABN/licence, a metadata grid, a
 * register table, per-inspection checkpoint tables and a footer. Brand accents
 * (navy #0d1b34 / yellow #f5d020) are forced through Save-as-PDF with
 * print-color-adjust:exact. Honesty rules are unchanged and load-bearing:
 *   - pending / in-progress instances carry the "not a completed record" banner;
 *   - witnessed-but-unsigned reads "awaiting sign-off";
 *   - a point with no result reads "Not recorded", never blank;
 *   - archived instances are excluded AND counted;
 *   - signedOffBy renders as stored — never re-resolved.
 *
 * v1 render-tech (recorded in the issue): server-rendered print-view + browser
 * print-to-PDF — zero new dependencies, no serverless time/memory risk from
 * embedding 50+ photos.
 */

const COMPANY = {
  name: "bühl electrical",
  abn: "ABN 61 204 887 113",
  licence: "Lic. PGE 198447 · Sydney NSW",
};

export function CompliancePackView({ pack }: { pack: CompliancePack }) {
  const signedOff = pack.instances.filter((i) => i.signOff).length;
  const total = pack.instances.length;
  const statusSummary =
    total === 0
      ? "No inspections attached"
      : `${signedOff}/${total} signed off`;

  return (
    <div className="itp-pack">
      <PackStyles />
      <article className="sheet">
        {/* Letterhead */}
        <header className="masthead">
          <div className="mh-left">
            <div className="wordmark">{COMPANY.name}</div>
            <div className="eyebrow">Inspection &amp; Test Plan</div>
            <h1 className="doc-title">Compliance Pack</h1>
            <div className="doc-sub">
              {pack.jobName}
              {pack.jobRef ? ` · Ref ${pack.jobRef}` : ""}
            </div>
          </div>
          <div className="mh-right">
            <div className="co-name">{COMPANY.name}</div>
            <div className="co-line">{COMPANY.abn}</div>
            <div className="co-line">{COMPANY.licence}</div>
            <div className="co-line">{formatStamp(pack.generatedAt)}</div>
          </div>
        </header>
        <div className="brand-rule" aria-hidden="true" />

        {/* Document metadata */}
        <dl className="meta">
          <div>
            <dt>Project</dt>
            <dd>{pack.jobName}</dd>
          </div>
          <div>
            <dt>Job no.</dt>
            <dd>{pack.jobId}</dd>
          </div>
          <div>
            <dt>Reference</dt>
            <dd>{pack.jobRef || "—"}</dd>
          </div>
          <div>
            <dt>Site address</dt>
            <dd>{pack.siteAddress || "—"}</dd>
          </div>
          <div>
            <dt>Inspections</dt>
            <dd>
              {total} {total === 1 ? "ITP" : "ITPs"}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{statusSummary}</dd>
          </div>
          <div>
            <dt>Generated</dt>
            <dd>{formatStamp(pack.generatedAt)}</dd>
          </div>
          <div>
            <dt>Prepared in</dt>
            <dd>BuhlOS</dd>
          </div>
        </dl>

        {pack.instances.length === 0 ? (
          <p className="empty">
            No ITP instances on this job yet. This pack is intentionally empty —
            attach inspection plans from the job&rsquo;s ITP queue and re-export.
          </p>
        ) : (
          <>
            {/* Register */}
            <section className="block">
              <h2 className="block-h">Inspection register</h2>
              <table className="reg">
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Inspection</th>
                    <th>Scope</th>
                    <th>Status</th>
                    <th className="num">Progress</th>
                    <th>Signed off</th>
                  </tr>
                </thead>
                <tbody>
                  {pack.summary.map((row, i) => (
                    <tr key={row.id}>
                      <td className="num">{i + 1}</td>
                      <td className="strong">{row.templateName}</td>
                      <td>{row.scopeLine}</td>
                      <td>
                        <StatusBadge label={row.statusLabel} />
                      </td>
                      <td className="num mono">
                        {row.progress.done}/{row.progress.total}
                      </td>
                      <td>
                        {row.signedOffBy
                          ? `${row.signedOffBy} · ${formatStamp(row.signedOffAt)}`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="fineprint">{pack.overridesNote}</p>
              {pack.archivedCount > 0 ? (
                <p className="fineprint">
                  {`${pack.archivedCount} archived ${
                    pack.archivedCount === 1 ? "instance" : "instances"
                  } not included.`}
                </p>
              ) : null}
            </section>

            {pack.instances.map((section, i) => (
              <InstanceSection key={section.id} section={section} index={i} total={total} />
            ))}
          </>
        )}

        <footer className="docfoot">
          <span>
            Inspection &amp; Test Plan compiled in BuhlOS — records reproduced from
            field captures; verify on site against AS/NZS 3000. Archived instances
            excluded.
          </span>
          <span className="mono">
            {pack.jobId} · Generated {formatStamp(pack.generatedAt)}
          </span>
        </footer>
      </article>
    </div>
  );
}

function InstanceSection({
  section,
  index,
  total,
}: {
  section: PackInstanceSection;
  index: number;
  total: number;
}) {
  return (
    <section className="itp" data-testid="pack-instance">
      <header className="itp-head">
        <div className="itp-head-main">
          <div className="itp-no">
            Inspection {index + 1} of {total}
          </div>
          <h2 className="itp-name">{section.templateName}</h2>
          <div className="itp-meta">
            {section.scopeLine} · {section.progress.done}/{section.progress.total} checks
            {section.createdAt ? ` · attached ${formatStamp(section.createdAt)}` : ""}
          </div>
        </div>
        <StatusBadge label={section.statusLabel} large />
      </header>

      {section.inProgress ? (
        <p className="banner banner-warn">In progress — not a completed record</p>
      ) : null}
      {section.awaitingSignOff ? (
        <p className="banner banner-info">Witnessed — awaiting sign-off</p>
      ) : null}
      {section.evidenceCoverage ? (
        <p className="evnote">
          {section.evidenceCoverage.photographed} of {section.evidenceCoverage.required}{" "}
          evidence-required points photographed
        </p>
      ) : null}

      {section.points.length === 0 ? (
        <p className="evnote">This ITP has no points.</p>
      ) : (
        <table className="checks">
          <thead>
            <tr>
              <th>Checkpoint</th>
              <th>Result</th>
              <th>Verdict</th>
              <th>Recorded by</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {section.points.map((p) => (
              <CheckRow key={p.id} p={p} />
            ))}
          </tbody>
        </table>
      )}

      {section.signOff ? (
        <div className="signoff" data-testid="pack-signoff">
          <span className="signoff-tick" aria-hidden="true">
            ✓
          </span>
          <div>
            <p className="signoff-title">
              Signed off by {section.signOff.signedOffBy} ·{" "}
              {formatStamp(section.signOff.signedOffAt)}
            </p>
            {section.signOff.overrideJustification ? (
              <p className="signoff-override">
                <span className="strong">Independence override:</span>{" "}
                {section.signOff.overrideJustification}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function CheckRow({ p }: { p: PackInstanceSection["points"][number] }) {
  const hasExtra = Boolean(p.note || p.photoUrl);
  const resultText = p.recorded
    ? p.valueLabel ?? (p.photoUrl ? "Photo recorded" : "Recorded")
    : "Not recorded";
  return (
    <>
      <tr className={p.recorded ? "check" : "check check-missing"} data-testid="pack-point">
        <td className="ck-label">
          {p.label}
          {p.required ? <span className="req"> *</span> : ""}
        </td>
        <td className="ck-result">{resultText}</td>
        <td className="ck-verdict">
          {p.passFail ? <Verdict value={p.passFail} /> : "—"}
        </td>
        <td className="ck-by">{p.recorded ? p.byUsername ?? "Unknown" : "—"}</td>
        <td className="ck-when mono">{p.recorded ? formatStamp(p.at) : "—"}</td>
      </tr>
      {hasExtra ? (
        <tr className="check-extra">
          <td colSpan={5}>
            {p.note ? <p className="ck-note">“{p.note}”</p> : null}
            {p.photoUrl ? (
              // Print document: a plain <img> keeps the pack self-contained and
              // the optimizer away from evidence URLs.
              // eslint-disable-next-line @next/next/no-img-element
              <img className="ck-photo" src={p.photoUrl} alt={`Evidence — ${p.label}`} />
            ) : null}
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Verdict({ value }: { value: "pass" | "fail" }) {
  return (
    <span className={value === "pass" ? "verdict verdict-pass" : "verdict verdict-fail"}>
      {value === "pass" ? "Pass" : "Fail"}
    </span>
  );
}

function StatusBadge({ label, large }: { label: string; large?: boolean }) {
  const tone = badgeTone(label);
  return (
    <span className={`badge badge-${tone}${large ? " badge-lg" : ""}`}>{label}</span>
  );
}

function badgeTone(label: string): "ok" | "wait" | "go" | "idle" {
  const l = label.toLowerCase();
  if (l.includes("signed")) return "ok";
  if (l.includes("witness")) return "wait";
  if (l.includes("progress")) return "go";
  return "idle";
}

function formatStamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Scoped print stylesheet for the pack. Server-rendered <style> (this is a
 * server component) so the document is self-contained; everything is namespaced
 * under .itp-pack. print-color-adjust:exact keeps the brand accents in
 * Save-as-PDF, and @page sets the printed margins.
 */
function PackStyles() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
.itp-pack{
  --ink:#0d1b34; --ink-2:#33415c; --muted:#76819a; --rule:#d8dde6; --rule-2:#eaedf2;
  --navy:#0d1b34; --yellow:#f5d020; --pass:#1c7c47; --fail:#b42318;
  background:#eef1f5; padding:32px 16px; color:var(--ink);
  font-family:"Inter",-apple-system,BlinkMacSystemFont,sans-serif; font-size:13px; line-height:1.55;
  -webkit-print-color-adjust:exact; print-color-adjust:exact;
}
.itp-pack *{box-sizing:border-box;}
.itp-pack .sheet{max-width:820px; margin:0 auto; background:#fff; padding:44px 48px 36px;
  border:1px solid var(--rule); box-shadow:0 10px 40px rgba(13,27,52,.12);}
.itp-pack .mono{font-family:"JetBrains Mono",ui-monospace,monospace;}
.itp-pack .strong{font-family:"Inter Tight",sans-serif; font-weight:700;}

/* Masthead */
.itp-pack .masthead{display:flex; align-items:flex-start; justify-content:space-between; gap:28px;}
.itp-pack .mh-left{min-width:0;}
.itp-pack .wordmark{font-family:"Inter Tight",sans-serif; font-weight:800; font-size:19px;
  letter-spacing:-.02em; color:var(--navy); margin-bottom:10px;}
.itp-pack .eyebrow{font-family:"JetBrains Mono",monospace; font-size:9px; font-weight:600;
  letter-spacing:.18em; text-transform:uppercase; color:var(--muted); margin-bottom:5px;}
.itp-pack .doc-title{font-family:"Inter Tight",sans-serif; font-weight:800; font-size:26px;
  line-height:1.1; letter-spacing:-.025em; color:var(--navy); margin:0 0 5px;}
.itp-pack .doc-sub{font-family:"Inter Tight",sans-serif; font-weight:600; font-size:14px;
  color:var(--ink-2); letter-spacing:-.01em;}
.itp-pack .mh-right{text-align:right; flex-shrink:0;}
.itp-pack .co-name{font-family:"Inter Tight",sans-serif; font-weight:700; font-size:14px; color:var(--navy);}
.itp-pack .co-line{font-family:"JetBrains Mono",monospace; font-size:9px; color:var(--muted);
  letter-spacing:.04em; line-height:1.9;}
.itp-pack .brand-rule{height:3px; margin:14px 0 0; background:var(--navy); position:relative;}
.itp-pack .brand-rule::before{content:""; position:absolute; left:0; top:0; width:64px; height:3px; background:var(--yellow);}

/* Meta grid */
.itp-pack .meta{display:grid; grid-template-columns:repeat(4,1fr); gap:0; margin:20px 0 0;
  border:1px solid var(--rule); border-bottom:0;}
.itp-pack .meta>div{padding:9px 13px; border-bottom:1px solid var(--rule); border-left:1px solid var(--rule);}
.itp-pack .meta>div:nth-child(4n+1){border-left:0;}
.itp-pack .meta dt{font-family:"JetBrains Mono",monospace; font-size:8px; font-weight:600;
  letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin-bottom:4px;}
.itp-pack .meta dd{margin:0; font-family:"Inter Tight",sans-serif; font-weight:700; font-size:13px;
  color:var(--ink); overflow-wrap:anywhere;}

/* Section blocks */
.itp-pack .block{margin-top:28px;}
.itp-pack .block-h{font-family:"JetBrains Mono",monospace; font-size:10px; font-weight:600;
  letter-spacing:.16em; text-transform:uppercase; color:var(--muted); margin:0 0 8px;}
.itp-pack .empty{margin-top:28px; font-size:13px; color:var(--ink-2);}

/* Register table */
.itp-pack table{width:100%; border-collapse:collapse;}
.itp-pack .reg{font-size:12px;}
.itp-pack .reg thead th{font-family:"JetBrains Mono",monospace; font-size:8.5px; font-weight:600;
  letter-spacing:.1em; text-transform:uppercase; color:var(--muted); text-align:left;
  padding:0 10px 7px 0; border-bottom:1.5px solid var(--navy);}
.itp-pack .reg tbody td{padding:8px 10px 8px 0; border-bottom:1px solid var(--rule-2); vertical-align:top;}
.itp-pack .reg tbody tr:last-child td{border-bottom:0;}
.itp-pack .num{text-align:right; padding-right:0; white-space:nowrap;}
.itp-pack .reg .num{width:1%;}
.itp-pack .fineprint{margin:8px 0 0; font-size:10px; color:var(--muted); line-height:1.5;}

/* Per-inspection */
.itp-pack .itp{margin-top:30px;}
.itp-pack .itp-head{display:flex; align-items:flex-start; justify-content:space-between; gap:18px;
  border-bottom:1.5px solid var(--navy); padding-bottom:10px;}
.itp-pack .itp-no{font-family:"JetBrains Mono",monospace; font-size:8.5px; font-weight:600;
  letter-spacing:.14em; text-transform:uppercase; color:var(--muted); margin-bottom:4px;}
.itp-pack .itp-name{font-family:"Inter Tight",sans-serif; font-weight:800; font-size:18px;
  letter-spacing:-.02em; color:var(--navy); margin:0 0 4px; line-height:1.15;}
.itp-pack .itp-meta{font-family:"JetBrains Mono",monospace; font-size:9.5px; color:var(--muted); letter-spacing:.03em;}

/* Banners */
.itp-pack .banner{margin:12px 0 0; padding:7px 12px; font-family:"Inter Tight",sans-serif;
  font-weight:700; font-size:11px; letter-spacing:.04em; text-transform:uppercase;}
.itp-pack .banner-warn{background:#fff7e0; border-left:3px solid var(--yellow); color:#7a5b00;}
.itp-pack .banner-info{background:#eef2fb; border-left:3px solid var(--navy); color:var(--navy);}
.itp-pack .evnote{margin:10px 0 0; font-size:11px; color:var(--ink-2);}

/* Checkpoint table */
.itp-pack .checks{margin-top:14px; font-size:12px;}
.itp-pack .checks thead th{font-family:"JetBrains Mono",monospace; font-size:8px; font-weight:600;
  letter-spacing:.1em; text-transform:uppercase; color:var(--muted); text-align:left;
  padding:0 10px 6px 0; border-bottom:1px solid var(--rule);}
.itp-pack .checks tbody td{padding:8px 10px 8px 0; border-bottom:1px solid var(--rule-2); vertical-align:top;}
.itp-pack .ck-label{font-family:"Inter Tight",sans-serif; font-weight:700; color:var(--ink); width:38%;}
.itp-pack .req{color:var(--fail); font-weight:700;}
.itp-pack .ck-result{font-family:"Inter Tight",sans-serif; font-weight:700;}
.itp-pack .ck-by{color:var(--ink-2);}
.itp-pack .ck-when{font-size:10px; color:var(--muted); white-space:nowrap;}
.itp-pack .check-missing td{color:var(--muted);}
.itp-pack .check-missing .ck-label{color:var(--muted); font-weight:600;}
.itp-pack .check-extra td{padding:0 0 10px;}
.itp-pack .ck-note{margin:2px 0 0; font-style:italic; font-size:11px; color:var(--ink-2);}
.itp-pack .ck-photo{margin:8px 0 0; max-height:280px; max-width:60%; border:1px solid var(--rule);
  border-radius:3px; display:block;}

/* Verdicts + badges */
.itp-pack .verdict{display:inline-block; font-family:"Inter Tight",sans-serif; font-weight:800;
  font-size:10px; letter-spacing:.06em; text-transform:uppercase; padding:1px 7px; border-radius:3px;}
.itp-pack .verdict-pass{background:#e7f4ec; color:var(--pass);}
.itp-pack .verdict-fail{background:#fbeae8; color:var(--fail);}
.itp-pack .badge{display:inline-block; font-family:"Inter Tight",sans-serif; font-weight:700;
  font-size:10px; letter-spacing:.04em; padding:2px 8px; border-radius:999px; border:1px solid;}
.itp-pack .badge-lg{font-size:11px; padding:3px 11px;}
.itp-pack .badge-ok{background:#e7f4ec; color:var(--pass); border-color:#bfe1cd;}
.itp-pack .badge-wait{background:#eef2fb; color:var(--navy); border-color:#c5d0ea;}
.itp-pack .badge-go{background:#fff7e0; color:#7a5b00; border-color:#ecd99a;}
.itp-pack .badge-idle{background:#f1f3f7; color:var(--muted); border-color:var(--rule);}

/* Sign-off */
.itp-pack .signoff{display:flex; gap:11px; margin-top:16px; padding:12px 14px;
  background:#f7faf8; border:1px solid #bfe1cd; border-left:3px solid var(--pass); border-radius:3px;}
.itp-pack .signoff-tick{flex-shrink:0; width:22px; height:22px; border-radius:50%; background:var(--pass);
  color:#fff; font-size:13px; font-weight:700; display:flex; align-items:center; justify-content:center; line-height:1;}
.itp-pack .signoff-title{margin:0; font-family:"Inter Tight",sans-serif; font-weight:700; font-size:13px; color:var(--ink);}
.itp-pack .signoff-override{margin:3px 0 0; font-size:11px; color:var(--ink-2);}

/* Footer */
.itp-pack .docfoot{margin-top:30px; border-top:1px solid var(--rule); padding-top:11px;
  font-family:"JetBrains Mono",monospace; font-size:8.5px; color:var(--muted); letter-spacing:.03em;
  display:flex; justify-content:space-between; gap:18px;}

@media print{
  .itp-pack{background:#fff !important; padding:0 !important;}
  .itp-pack .sheet{max-width:none !important; margin:0 !important; padding:0 !important;
    border:0 !important; box-shadow:none !important;}
  .itp-pack .itp{break-before:page;}
  .itp-pack .itp:first-of-type{break-before:auto;}
  .itp-pack .check, .itp-pack .checks tr, .itp-pack .signoff, .itp-pack .reg tr{break-inside:avoid;}
}
@page{margin:14mm;}
`,
      }}
    />
  );
}
