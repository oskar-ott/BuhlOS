import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  FileText,
  Map as MapIcon,
  Package,
} from "lucide-react";
import { PhilNotice } from "./ui/PhilNotice";
import {
  classifyTaskWarnings,
  type PhilTaskContext,
  type TaskContextEvidenceReq,
} from "@/domains/job-control/task-context";
import type { GoverningDocRef, WorkPackageMaterial } from "@/domains/job-control/types";

/**
 * Phil — task scope context (#368).
 *
 * Renders the office-compiled provenance for a SINGLE task, inline inside the
 * existing task row (no new job-screen section — anti-creep / P10 / the
 * narrowed #132 rule): the scope note, the governing drawing/spec, the
 * materials, the proof the office needs, and the site warnings — so a worker
 * knows "what, where, what governs it, what proof, what can trip me up" without
 * ringing the office.
 *
 * Honesty rules it inherits from the model and must not break:
 *   - HIDDEN-WHEN-EMPTY. An empty context renders NOTHING — the task looks
 *     exactly as it does today (zero regression). We deliberately do NOT show a
 *     per-task "no context yet" note: every un-compiled task would carry it,
 *     which is clutter, not information (P10). Each sub-section is likewise
 *     hidden when its data is absent.
 *   - PROOF IS MODEL-DRIVEN. A required-evidence row is ticked ONLY when the
 *     model says `met` (a real EvidenceLink names it) — never inferred from a
 *     photo count (P7). This component never recomputes that.
 *
 * Pure: renders from a `PhilTaskContext` the model already built; no state, no
 * data inspection — server-renders and unit-tests with `renderToString`.
 */

const EVIDENCE_KIND_LABEL: Record<TaskContextEvidenceReq["kind"], string> = {
  photo: "Photo",
  test_result: "Test result",
  as_built: "As-built",
  certificate: "Certificate",
};

export function PhilTaskScopeContext({
  context,
  jobId,
}: {
  context: PhilTaskContext;
  /** This task's job — needed to build the link to the Phil plans viewer for a
   *  governing drawing/spec. When omitted, each governing doc renders as plain
   *  text (today's behavior — zero regression). */
  jobId?: string;
}) {
  // Zero-regression guarantee: nothing compiled for this task → render nothing.
  if (context.isEmpty) return null;

  const { variationTriggers, byOthers, reuseExisting } = classifyTaskWarnings(context.warnings);
  const hasWarning = context.warnings.length > 0;

  return (
    <details className="group mt-1 rounded-card border border-border bg-surface-subtle">
      <summary className="flex min-h-[44px] cursor-pointer select-none list-none items-center gap-2 px-3 py-2 text-sm font-medium text-text [&::-webkit-details-marker]:hidden">
        {hasWarning ? (
          <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 text-state-warning" />
        ) : (
          <FileText aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        )}
        <span className="flex-1">Task context</span>
        <span className="text-xs text-text-muted group-open:hidden">Show</span>
        <span className="hidden text-xs text-text-muted group-open:inline">Hide</span>
      </summary>

      <div className="space-y-3 px-3 pb-3 pt-1">
        {/* Warnings lead — a variation trigger is the most urgent thing a
            worker can see here ("stop before you do unpaid extras"). */}
        {variationTriggers.map((w) => (
          <PhilNotice key={w.id} tone="danger" title="Stop — flag a variation first" role="alert">
            <p>{w.text}</p>
          </PhilNotice>
        ))}
        {byOthers.map((w) => (
          <PhilNotice key={w.id} tone="warning" title="By others">
            <p>{w.text}</p>
          </PhilNotice>
        ))}
        {reuseExisting.map((w) => (
          <PhilNotice key={w.id} tone="info" title="Reuse existing — verify first">
            <p>{w.text}</p>
          </PhilNotice>
        ))}

        {/* Scope note — the plain-English "what this is". */}
        {context.scopeNote ? <p className="text-sm text-text">{context.scopeNote}</p> : null}

        {/* Governing drawing / spec. With the job in hand, the named sheet is a
            tappable link into the Phil plans viewer (where the worker opens the
            drawing); without it, it stays plain text — never a dead link. */}
        {context.governingDocs.length > 0 ? (
          <Section icon={MapIcon} title="Drawing / spec">
            <ul className="space-y-1">
              {context.governingDocs.map((d) => (
                <li key={d.documentId} className="text-sm text-text">
                  {jobId ? (
                    <a
                      href={plansHref(jobId)}
                      className="inline-flex min-h-[44px] items-center gap-1.5 text-brand-navy underline decoration-accent-yellow decoration-2 underline-offset-2 focus:outline-none focus:ring-2 focus:ring-brand-navy"
                    >
                      <MapIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
                      <span>{docLabel(d)}</span>
                    </a>
                  ) : (
                    docLabel(d)
                  )}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* Materials. */}
        {context.materials.length > 0 ? (
          <Section icon={Package} title="Materials">
            <ul className="space-y-1">
              {context.materials.map((m, i) => (
                <li key={`${m.label}-${i}`} className="text-sm text-text">
                  {materialLabel(m)}
                </li>
              ))}
            </ul>
          </Section>
        ) : null}

        {/* Proof the office needs. `met` comes straight from the model — a real
            EvidenceLink, never a photo count. */}
        {context.requiredEvidence.length > 0 ? (
          <Section icon={CheckCircle2} title="Proof needed">
            <ul className="space-y-1.5">
              {context.requiredEvidence.map((e) => (
                <li key={e.id} className="flex items-start gap-2 text-sm">
                  {e.met ? (
                    <CheckCircle2
                      aria-hidden="true"
                      className="mt-0.5 h-4 w-4 shrink-0 text-state-success"
                    />
                  ) : (
                    <Circle
                      aria-hidden="true"
                      className="mt-0.5 h-4 w-4 shrink-0 text-text-muted/50"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className={e.met ? "text-text-muted line-through" : "text-text"}>
                      {e.label}
                    </span>
                    <span className="text-text-muted">
                      {" "}
                      · {EVIDENCE_KIND_LABEL[e.kind]}
                      {e.met ? " · done" : ""}
                    </span>
                    {e.note ? (
                      <span className="mt-0.5 block text-xs text-text-muted">{e.note}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
      </div>
    </details>
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof Package;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="flex items-center gap-1.5 font-display text-[12px] uppercase tracking-wider text-text-muted">
        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        {title}
      </p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** A governing-doc reference shows its compiled label, or a plain fallback —
 *  never a raw id (worker language, P11). With a job in hand the label becomes
 *  a tappable link into the Phil plans viewer (see plansHref). */
function docLabel(d: GoverningDocRef): string {
  return d.label?.trim() || "Referenced drawing / spec";
}

/** Where a named drawing/spec opens for the worker: the Phil plans viewer for
 *  this job. The viewer has no per-document/per-page deep link (it selects the
 *  first current drawing and the worker pages to the named sheet), so we link
 *  to the index honestly — never a fabricated `?doc=`/`?page=` the viewer can't
 *  honour (P7). Mirrors PhilJobDetail's "Open plan viewer" target. */
function plansHref(jobId: string): string {
  return `/phil/jobs/${encodeURIComponent(jobId)}/plans`;
}

/** "12 × 20A DGPO" style line from the real compiled fields; quantity/unit are
 *  optional, so fall back to the label alone — never invent a number (P7). */
function materialLabel(m: WorkPackageMaterial): string {
  const qty = typeof m.qty === "number" ? `${m.qty}${m.unit ? ` ${m.unit}` : ""} · ` : "";
  return `${qty}${m.label}`;
}
