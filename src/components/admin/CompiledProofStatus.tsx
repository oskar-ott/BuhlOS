import { CheckCircle2, Circle } from "lucide-react";
import { Card, CardDescription, CardTitle } from "@/components/ui/Card";
import type { ProofStatusResult } from "@/server/job-control/status";
import { proofStatusHeadline, summariseProofStatus } from "./jobControlStatusClient";

/**
 * Read-only "Compiled proof status" — the office audit of the field proof loop:
 * what proof was compiled for Phil, what's still needed, what's been captured,
 * and which evidence satisfied which requirement.
 *
 * Pure presentational: it renders from the server-derived `ProofStatusResult`
 * (no state, no fetch, no hooks) — server-renders and unit-tests with
 * `renderToString`. It NEVER recomputes met (the server already did, via the
 * shared rule). Raw ids / source hashes live only in the Developer details
 * foldout; the primary UI uses titles, labels, and plain Needed/Met badges.
 */

const KIND_LABEL: Record<string, string> = {
  photo: "Photo",
  test_result: "Test result",
  as_built: "As-built",
  certificate: "Certificate",
};

export function CompiledProofStatus({ status }: { status: ProofStatusResult }) {
  // Load error (Blob read failed) — distinct from "no artifact".
  if (!status.ok) {
    return (
      <div className="mx-auto mt-4 max-w-3xl">
        <Card role="alert">
          <CardTitle>Compiled proof status</CardTitle>
          <CardDescription className="mt-2">Could not load compiled proof status.</CardDescription>
        </Card>
      </div>
    );
  }

  if (status.status !== "compiled") {
    return (
      <div className="mx-auto mt-4 max-w-3xl">
        <Card>
          <CardTitle>Compiled proof status</CardTitle>
          <CardDescription className="mt-2">{proofStatusHeadline(status)}</CardDescription>
        </Card>
      </div>
    );
  }

  const summary = summariseProofStatus(status);

  return (
    <div className="mx-auto mt-4 max-w-3xl space-y-4">
      <Card>
        <CardTitle>Compiled proof status</CardTitle>
        <CardDescription className="mt-1">{proofStatusHeadline(status)}</CardDescription>
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-text-muted">
          <li>Work packages: {summary.workPackageCount}</li>
          <li>Required proofs: {summary.requiredProofTotal}</li>
          <li className="text-state-success">Met: {summary.metCount}</li>
          <li className={summary.neededCount > 0 ? "text-state-warning" : ""}>
            Needed: {summary.neededCount}
          </li>
        </ul>
      </Card>

      {status.requiredProofTotal === 0 ? (
        <Card>
          <CardDescription>
            Compiled for Phil, but no required proof items are present.
          </CardDescription>
        </Card>
      ) : (
        status.workPackages
          .filter((wp) => wp.requiredEvidence.length > 0)
          .map((wp) => (
            <Card key={wp.id}>
              <CardTitle className="text-base">{wp.title}</CardTitle>
              <ul className="mt-3 space-y-3">
                {wp.requiredEvidence.map((req) => (
                  <li key={req.id} className="flex items-start gap-2">
                    {req.status === "met" ? (
                      <CheckCircle2
                        aria-hidden="true"
                        className="mt-0.5 h-4 w-4 shrink-0 text-state-success"
                      />
                    ) : (
                      <Circle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-muted/50" />
                    )}
                    <span className="min-w-0 flex-1 text-sm">
                      <span className="font-medium text-text">
                        {req.status === "met" ? "Met" : "Needed"}
                      </span>{" "}
                      <span className="text-text">{req.label}</span>
                      <span className="text-text-muted">
                        {" "}
                        · {KIND_LABEL[req.kind] ?? req.kind}
                      </span>
                      {req.note ? (
                        <span className="mt-0.5 block text-xs text-text-muted">{req.note}</span>
                      ) : null}
                      {req.status === "met" ? (
                        <span className="mt-0.5 block text-xs text-text-muted">
                          {req.evidenceLinks.map((el, i) => (
                            <span key={i} className="block">
                              Evidence captured
                              {el.linkedAt ? ` · ${el.linkedAt}` : ""}
                              {el.linkedBy ? ` · by ${el.linkedBy}` : ""}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          ))
      )}

      <Card>
        <CardDescription className="text-xs">
          Compiled{status.confirmedAt ? ` ${status.confirmedAt}` : ""}
          {status.confirmedBy ? ` by ${status.confirmedBy}` : ""} · linked evidence{" "}
          {status.evidenceLinkCount}
          {status.gapCount > 0 ? ` · ${status.gapCount} compile gap(s)` : ""}
        </CardDescription>
      </Card>

      {/* Developer foldout — raw ids + compile fingerprints only here. */}
      <details className="rounded-card border border-border bg-surface-subtle px-3 py-2 text-xs text-text-muted">
        <summary className="cursor-pointer select-none">Developer details</summary>
        <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all">
          {JSON.stringify(
            {
              revision: status.revision,
              sourceHash: status.sourceHash,
              sourceReconciliationHash: status.sourceReconciliationHash,
              sourceStructureHash: status.sourceStructureHash,
              workPackages: status.workPackages.map((wp) => ({
                id: wp.id,
                scopeClauseIds: wp.scopeClauseIds,
                requiredEvidence: wp.requiredEvidence.map((r) => ({
                  id: r.id,
                  status: r.status,
                  evidenceLinks: r.evidenceLinks,
                })),
              })),
            },
            null,
            2,
          )}
        </pre>
      </details>
    </div>
  );
}
