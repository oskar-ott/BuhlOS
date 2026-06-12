import type { CompliancePack, PackInstanceSection } from "@/domains/itp/compliance-pack";

/**
 * Printable compliance pack (#286) — deliberately plain, print-first HTML.
 * The route renders this full-page (no AdminShell); the office hits
 * Cmd/Ctrl+P → "Save as PDF" and sends it. Page breaks between instances;
 * job + generation stamp on the cover; IN PROGRESS watermarking; photos by
 * public blob URL with a named gap when one fails to load.
 *
 * v1 render-tech decision (recorded in the issue): server-rendered
 * print-view + browser print-to-PDF — zero new dependencies, no serverless
 * time/memory risk from embedding 50+ photos. A true server-side PDF with
 * an async artifact is the follow-up if builders reject printed packs.
 */

export function CompliancePackView({ pack }: { pack: CompliancePack }) {
  return (
    <div className="mx-auto max-w-3xl bg-white px-8 py-10 text-[13px] leading-relaxed text-neutral-900 print:max-w-none print:px-0 print:py-0">
      {/* Cover / header */}
      <header className="border-b-4 border-neutral-900 pb-4">
        <h1 className="text-2xl font-bold">ITP compliance pack</h1>
        <p className="mt-1 text-base">
          {pack.jobName}
          {pack.jobRef ? ` · Ref ${pack.jobRef}` : ""}
        </p>
        <p className="mt-1 text-xs text-neutral-600">
          Generated {formatStamp(pack.generatedAt)} · {pack.instances.length}{" "}
          {pack.instances.length === 1 ? "ITP" : "ITPs"}
          {pack.archivedCount > 0
            ? ` · ${pack.archivedCount} archived ${pack.archivedCount === 1 ? "instance" : "instances"} not included`
            : ""}
        </p>
      </header>

      {pack.instances.length === 0 ? (
        <p className="mt-8 text-sm">
          No ITP instances on this job yet. This pack is intentionally empty —
          attach inspection plans from the job&rsquo;s ITP queue and re-export.
        </p>
      ) : (
        <>
          {/* Summary table */}
          <section className="mt-6">
            <h2 className="text-sm font-bold uppercase tracking-wide">Summary</h2>
            <table className="mt-2 w-full border-collapse text-xs">
              <thead>
                <tr className="border-b-2 border-neutral-800 text-left">
                  <th className="py-1 pr-2">ITP</th>
                  <th className="py-1 pr-2">Scope</th>
                  <th className="py-1 pr-2">Status</th>
                  <th className="py-1 pr-2">Progress</th>
                  <th className="py-1">Signed off</th>
                </tr>
              </thead>
              <tbody>
                {pack.summary.map((row) => (
                  <tr key={row.id} className="border-b border-neutral-300 align-top">
                    <td className="py-1 pr-2 font-medium">{row.templateName}</td>
                    <td className="py-1 pr-2">{row.scopeLine}</td>
                    <td className="py-1 pr-2">{row.statusLabel}</td>
                    <td className="py-1 pr-2">
                      {row.progress.done}/{row.progress.total}
                    </td>
                    <td className="py-1">
                      {row.signedOffBy
                        ? `${row.signedOffBy} · ${formatStamp(row.signedOffAt)}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[10px] text-neutral-500">{pack.overridesNote}</p>
          </section>

          {/* Per-instance sections */}
          {pack.instances.map((section) => (
            <InstanceSection key={section.id} section={section} />
          ))}
        </>
      )}
    </div>
  );
}

function InstanceSection({ section }: { section: PackInstanceSection }) {
  return (
    <section
      className="mt-8 break-before-page"
      data-testid="pack-instance"
    >
      <header className="border-b-2 border-neutral-800 pb-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-lg font-bold">{section.templateName}</h2>
          <span className="text-xs text-neutral-600">
            {section.progress.done}/{section.progress.total} points
          </span>
        </div>
        <p className="text-xs text-neutral-600">
          {section.scopeLine} · Instance {section.id}
          {section.createdAt ? ` · attached ${formatStamp(section.createdAt)}` : ""}
        </p>
        {section.inProgress ? (
          <p className="mt-1 inline-block border-2 border-neutral-900 px-2 py-0.5 text-xs font-bold uppercase tracking-widest">
            In progress — not a completed record
          </p>
        ) : null}
        {section.awaitingSignOff ? (
          <p className="mt-1 inline-block border border-neutral-700 px-2 py-0.5 text-xs font-semibold uppercase tracking-widest">
            Witnessed — awaiting sign-off
          </p>
        ) : null}
        {section.evidenceCoverage ? (
          <p className="mt-1 text-xs text-neutral-600">
            {section.evidenceCoverage.photographed} of {section.evidenceCoverage.required}{" "}
            evidence-required points photographed
          </p>
        ) : null}
      </header>

      <ul className="mt-3 space-y-3">
        {section.points.length === 0 ? (
          <li className="text-xs text-neutral-600">This ITP has no points.</li>
        ) : (
          section.points.map((p) => (
            <li key={p.id} className="border-b border-neutral-200 pb-2" data-testid="pack-point">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-medium">
                  {p.label}
                  {p.required ? " *" : ""}
                </p>
                {p.passFail ? (
                  <span className="text-xs font-bold uppercase">
                    {p.passFail === "pass" ? "Pass" : "FAIL"}
                  </span>
                ) : null}
              </div>
              {p.recorded ? (
                <>
                  <p className="text-xs text-neutral-700">
                    {p.valueLabel ? `${p.valueLabel} · ` : ""}
                    {p.byUsername ?? "Unknown"} · {formatStamp(p.at)}
                  </p>
                  {p.note ? <p className="mt-0.5 text-xs italic">“{p.note}”</p> : null}
                  {p.photoUrl ? (
                    /* Print document: a plain <img> keeps the pack
                       self-contained and the optimizer away from evidence
                       URLs. */
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.photoUrl}
                      alt={`Evidence — ${p.label}`}
                      className="mt-1 max-h-72 rounded border border-neutral-300"
                    />
                  ) : null}
                </>
              ) : (
                <p className="text-xs font-medium text-neutral-500">Not recorded</p>
              )}
            </li>
          ))
        )}
      </ul>

      {section.signOff ? (
        <div className="mt-3 border-2 border-neutral-800 p-3" data-testid="pack-signoff">
          <p className="text-sm font-bold">
            Signed off by {section.signOff.signedOffBy} ·{" "}
            {formatStamp(section.signOff.signedOffAt)}
          </p>
          {section.signOff.overrideJustification ? (
            <p className="mt-1 text-xs">
              <span className="font-semibold">Independence override:</span>{" "}
              {section.signOff.overrideJustification}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function formatStamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
