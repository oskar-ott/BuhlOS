import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import type { ScopeClassification } from "@/domains/job-control/reconciliation";
import type { ScopeReconciliationView } from "@/server/job-control/reconciliation-read";

/**
 * Boss-facing scope-vs-quote reconciliation review (#366). Pure presenter —
 * props in, JSX out — so it render-tests without a browser. It SHOWS the
 * confirmed reconciliation produced by the authoring flow on the job-control
 * page; it computes nothing and writes nothing (the engine derives findings, the
 * UI renders them — the issue's "the UI renders findings, never computes them").
 *
 * Site/office language for the ten classifications and the RAG status so a
 * reviewer reads "Excluded — but carries an obligation" instead of an enum.
 */

const CLASSIFICATION_LABELS: Record<ScopeClassification, string> = {
  priced: "Priced",
  general_allowance: "General allowance",
  excluded: "Excluded",
  by_others: "By others",
  reuse_existing: "Reuse existing",
  pc_provisional: "PC / provisional",
  variation_trigger: "Variation trigger",
  closeout: "Closeout obligation",
  admin_only: "Admin only",
  unclear: "Not yet classified",
};

const RAG_LABEL: Record<"red" | "amber" | "green", string> = {
  red: "Conflicts to resolve",
  amber: "Needs attention",
  green: "Reconciled",
};

const RAG_CLASS: Record<"red" | "amber" | "green", string> = {
  red: "bg-red-100 text-red-900",
  amber: "bg-amber-100 text-amber-900",
  green: "bg-emerald-100 text-emerald-900",
};

function RagBadge({ rag }: { rag: "red" | "amber" | "green" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ${RAG_CLASS[rag]}`}
      role="status"
    >
      {RAG_LABEL[rag]}
    </span>
  );
}

export function ScopeReconciliationStatus({ view }: { view: ScopeReconciliationView }) {
  if (view.status === "missing") {
    return (
      <Card>
        <CardTitle>No reconciliation yet</CardTitle>
        <CardDescription className="mt-2">
          The scope hasn&rsquo;t been reconciled against the quote for this job. Open{" "}
          <strong>Job control</strong> to classify each scope clause before work starts — every
          clause is forced into a classification so nothing becomes silent field work.
        </CardDescription>
      </Card>
    );
  }

  if (view.status === "unreadable") {
    return (
      <Card className="border-amber-200 bg-amber-50" role="alert">
        <CardTitle>Couldn&rsquo;t read the reconciliation</CardTitle>
        <CardDescription className="text-amber-900">
          The saved reconciliation for this job didn&rsquo;t parse. Re-confirm it from Job control.
        </CardDescription>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <RagBadge rag={view.rag} />
        <span className="text-sm text-slate-600">
          {view.counts.classified}/{view.counts.clauses} clauses classified
          {view.counts.unclassified > 0 ? ` · ${view.counts.unclassified} not yet classified` : ""}
        </span>
        {view.counts.redFindings > 0 ? (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-900">
            {view.counts.redFindings} red
          </span>
        ) : null}
        {view.counts.amberFindings > 0 ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
            {view.counts.amberFindings} amber
          </span>
        ) : null}
      </div>

      <p className="text-xs text-slate-500">
        {view.confirmedBy ? `Confirmed by ${view.confirmedBy}` : "Confirmed"}
        {view.confirmedAt ? ` · ${String(view.confirmedAt).slice(0, 10)}` : ""}
        {view.quoteId ? ` · quote ${view.quoteId}` : " · no quote linked yet"}
      </p>

      {view.findings.length > 0 ? (
        <Card>
          <CardTitle>Open findings</CardTitle>
          <ul className="mt-2 space-y-2">
            {view.findings.map((f) => (
              <li key={f.key} className="flex items-start gap-2 text-sm">
                <span
                  className={`mt-0.5 inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-semibold ${
                    f.severity === "red" ? "bg-red-100 text-red-900" : "bg-amber-100 text-amber-900"
                  }`}
                >
                  {f.severity}
                </span>
                <span className="text-slate-800">{f.message}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Card>
          <CardDescription>
            No open findings — every clause is classified and every conflict resolved.
          </CardDescription>
        </Card>
      )}

      <Card>
        <CardTitle>Scope clauses</CardTitle>
        <ul className="mt-2 divide-y divide-slate-200">
          {view.clauses.map((c) => (
            <li key={c.clauseId} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <span className="font-mono text-xs text-slate-500">{c.clauseId}</span>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  c.classification === "unclear"
                    ? "bg-amber-100 text-amber-900"
                    : "bg-slate-100 text-slate-700"
                }`}
              >
                {CLASSIFICATION_LABELS[c.classification]}
              </span>
              {c.boqLineCount > 0 ? (
                <span className="text-xs text-slate-500">{c.boqLineCount} priced lines</span>
              ) : null}
              {c.deliveredByCount > 0 ? (
                <span className="text-xs text-slate-500">{c.deliveredByCount} tasks</span>
              ) : null}
              {c.requiredEvidenceCount > 0 ? (
                <span className="text-xs text-slate-500">{c.requiredEvidenceCount} proof</span>
              ) : null}
              {c.warningText ? (
                <span className="w-full text-xs text-amber-800">⚠ {c.warningText}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
