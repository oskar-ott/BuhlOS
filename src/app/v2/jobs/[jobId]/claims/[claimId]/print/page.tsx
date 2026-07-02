import { notFound, redirect } from "next/navigation";
import { cookies } from "next/headers";
import { SESSION_COOKIE, decodeSessionCookie } from "@/lib/auth/session";
import { canAccessSurface } from "@/lib/auth/permissions";
import { blobClaimsDeps, readClaimsView } from "@/server/progress-claims/store";
import {
  certifiedVarianceCents,
  formatBpPct,
  formatCentsAud,
  withComputedValues,
} from "@/domains/progress-claims/math";
import { isFlagEnabled } from "../../../../../../../../api/_lib/feature-flags.js";

export const dynamic = "force-dynamic";

interface PageParams {
  params: Promise<{ jobId: string; claimId: string }>;
}

/**
 * /v2/jobs/[jobId]/claims/[claimId]/print — the claim summary PRINT VIEW
 * (#372 AC5): a clean, print-CSS document the office prints to PDF (the
 * pre-#243 quotes print precedent — no new PDF pipeline). Renders the stored
 * claim snapshot: lines with contract value / prev % / this % / values,
 * evidence counts, attached variation sections, totals and status references.
 * A draft prints with a DRAFT watermark line; nothing ever claims the file
 * was "uploaded" anywhere.
 */
export default async function ClaimPrintPage({ params }: PageParams) {
  const { jobId, claimId } = await params;

  const cookieStore = await cookies();
  const session = decodeSessionCookie(cookieStore.get(SESSION_COOKIE)?.value);
  if (!session?.role) {
    redirect(`/v2/login?next=${encodeURIComponent(`/v2/jobs/${jobId}/claims`)}`);
  }
  if (!canAccessSurface(session.role, "admin")) redirect("/v2/login");
  if (!(await isFlagEnabled("progress_claims", session))) notFound();

  const view = await readClaimsView(blobClaimsDeps(), jobId, new Date().toISOString());
  if (!view.ok) notFound();
  const claim = view.claims.find((c) => c.id === claimId);
  if (!claim) notFound();

  const lines = [...claim.lines].sort((a, b) => a.order - b.order).map(withComputedValues);
  const variance = certifiedVarianceCents(claim);
  const grandToDate = claim.totals.toDateValueCents + claim.totals.attachmentsValueCents;

  return (
    <main className="mx-auto max-w-3xl bg-white p-8 text-sm text-neutral-900 print:p-0">
      <div className="mb-4 flex items-start justify-between print:hidden">
        <p className="text-xs text-neutral-500">
          Use your browser&rsquo;s Print to save as PDF. Figures are for keying into Payapps —
          this document is not an upload.
        </p>
      </div>

      <header className="border-b-2 border-neutral-900 pb-3">
        <h1 className="text-xl font-bold">
          Progress claim {claim.number}
          {claim.status === "draft" ? " — DRAFT (not submitted)" : ""}
        </h1>
        <p className="mt-1 text-neutral-600">
          {view.jobName ?? jobId}
          {claim.periodLabel ? ` · ${claim.periodLabel}` : ""}
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-neutral-700 sm:grid-cols-4">
          <div>
            <dt className="font-semibold uppercase tracking-wide">Status</dt>
            <dd>{claim.status}</dd>
          </div>
          {claim.submittedAt ? (
            <div>
              <dt className="font-semibold uppercase tracking-wide">Submitted</dt>
              <dd>
                {new Date(claim.submittedAt).toLocaleDateString("en-AU")}
                {claim.submittedBy ? ` by ${claim.submittedBy}` : ""}
              </dd>
            </div>
          ) : null}
          {claim.certifiedValueCents != null ? (
            <div>
              <dt className="font-semibold uppercase tracking-wide">Certified</dt>
              <dd>
                {formatCentsAud(claim.certifiedValueCents)}
                {claim.certifiedRef ? ` (${claim.certifiedRef})` : ""}
                {variance != null && variance !== 0
                  ? ` · variance ${variance > 0 ? "+" : ""}${formatCentsAud(variance)}`
                  : ""}
              </dd>
            </div>
          ) : null}
          {claim.paidAt ? (
            <div>
              <dt className="font-semibold uppercase tracking-wide">Paid</dt>
              <dd>
                {new Date(claim.paidAt).toLocaleDateString("en-AU")}
                {claim.paidRef ? ` (${claim.paidRef})` : ""}
              </dd>
            </div>
          ) : null}
        </dl>
      </header>

      <table className="mt-4 w-full border-collapse text-xs">
        <thead>
          <tr className="border-b border-neutral-400 text-left uppercase tracking-wide text-neutral-600">
            <th className="py-1 pr-2">Ref</th>
            <th className="py-1 pr-2">Description</th>
            <th className="py-1 pr-2 text-right">Contract</th>
            <th className="py-1 pr-2 text-right">Prev %</th>
            <th className="py-1 pr-2 text-right">This %</th>
            <th className="py-1 pr-2 text-right">This value</th>
            <th className="py-1 pr-2 text-right">To date %</th>
            <th className="py-1 pr-2 text-right">To date value</th>
            <th className="py-1 text-right">Evidence</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.id} className="border-b border-neutral-200 align-top">
              <td className="py-1 pr-2 font-mono">{line.lineRef}</td>
              <td className="py-1 pr-2">
                {line.description}
                {line.sectionLabel ? (
                  <span className="block text-neutral-500">{line.sectionLabel}</span>
                ) : null}
                {line.contractValueCents == null ? (
                  <span className="block font-semibold text-amber-700">UNPRICED — excluded from totals</span>
                ) : null}
                {line.toDatePctBp > 10_000 ? (
                  <span className="block font-semibold text-rose-700">
                    OVER 100% {line.overClaimOverride ? "(office override)" : ""}
                  </span>
                ) : null}
              </td>
              <td className="py-1 pr-2 text-right tabular-nums">{formatCentsAud(line.contractValueCents)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{formatBpPct(line.previousPctBp)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{formatBpPct(line.thisPctBp)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{formatCentsAud(line.thisValueCents)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{formatBpPct(line.toDatePctBp)}</td>
              <td className="py-1 pr-2 text-right tabular-nums">{formatCentsAud(line.toDateValueCents)}</td>
              <td className="py-1 text-right">
                {line.evidenceRefs.length === 0 ? "none" : line.evidenceRefs.length}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {claim.attachments.length > 0 ? (
        <section className="mt-4">
          <h2 className="text-sm font-bold">Attached sections (by link)</h2>
          <table className="mt-1 w-full border-collapse text-xs">
            <tbody>
              {claim.attachments.map((a) => (
                <tr key={`${a.kind}:${a.id}`} className="border-b border-neutral-200">
                  <td className="py-1 pr-2 font-mono uppercase">{a.kind}</td>
                  <td className="py-1 pr-2">
                    {a.ref ? `${a.ref} — ` : ""}
                    {a.label}
                  </td>
                  <td className="py-1 text-right tabular-nums">
                    {a.valueCents == null ? "support only (no priced value)" : formatCentsAud(a.valueCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="mt-4 border-t-2 border-neutral-900 pt-2">
        <dl className="ml-auto grid max-w-sm grid-cols-2 gap-y-1 text-sm">
          <dt className="text-neutral-600">Contract value (priced lines)</dt>
          <dd className="text-right tabular-nums">{formatCentsAud(claim.totals.contractValueCents)}</dd>
          <dt className="text-neutral-600">Previously claimed</dt>
          <dd className="text-right tabular-nums">{formatCentsAud(claim.totals.previousValueCents)}</dd>
          <dt className="text-neutral-600">This claim — contract lines</dt>
          <dd className="text-right tabular-nums">{formatCentsAud(claim.totals.thisLinesValueCents)}</dd>
          <dt className="text-neutral-600">This claim — attached sections</dt>
          <dd className="text-right tabular-nums">{formatCentsAud(claim.totals.attachmentsValueCents)}</dd>
          <dt className="font-bold">This claim total (ex GST)</dt>
          <dd className="text-right font-bold tabular-nums">
            {formatCentsAud(claim.totals.thisClaimValueCents)}
          </dd>
          <dt className="text-neutral-600">Claimed to date (incl. this claim)</dt>
          <dd className="text-right tabular-nums">{formatCentsAud(grandToDate)}</dd>
        </dl>
        {claim.totals.unpricedLineCount > 0 ? (
          <p className="mt-2 text-xs text-amber-700">
            {claim.totals.unpricedLineCount} unpriced line
            {claim.totals.unpricedLineCount === 1 ? " is" : "s are"} excluded from these totals.
          </p>
        ) : null}
        {claim.evidenceManifest ? (
          <p className="mt-2 text-xs text-neutral-500">
            Evidence manifest frozen {new Date(claim.evidenceManifest.generatedAt).toLocaleString("en-AU")} —{" "}
            {claim.evidenceManifest.entries.reduce((s, e) => s + e.refs.length, 0)} linked record(s) across{" "}
            {claim.evidenceManifest.entries.filter((e) => e.refs.length > 0).length} line(s).
          </p>
        ) : null}
      </section>
    </main>
  );
}
