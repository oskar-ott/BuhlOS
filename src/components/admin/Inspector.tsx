import { AlertTriangle, CheckCircle2, Info, MapPin, ScrollText, X } from "lucide-react";
import type { BuilderReadiness, ReadinessIssue } from "@/domains/jobs/builder";

/**
 * The Job Builder cockpit's right pane (§4) — a real selected-row inspector.
 *
 * With nothing selected it shows the live build-readiness breakdown (every
 * blocker and warning from the real publish gate + field-lint, each jumping to
 * the section that owns the fix) and invites a selection. Click a row in the
 * canvas — a scope line or an area — and it inspects that row: its real,
 * persisted detail. It only ever shows what the job actually holds.
 */

/** A row the inspector can inspect — only persisted fields, no invented data. */
export type InspectorRow =
  | {
      entity: "area";
      id: string | null;
      title: string;
      group: string;
      spaceType: string | null;
      hasCustomTasks: boolean;
    }
  | {
      entity: "clause";
      id: string;
      title: string;
      detail: string | null;
    };

export type InspectorTarget = { kind: "readiness" } | { kind: "row"; row: InspectorRow };

interface InspectorProps {
  target: InspectorTarget;
  readiness: BuilderReadiness;
  /** Jump to the builder section that owns an issue. */
  onGoToIssue: (issue: ReadinessIssue) => void;
  /** Clear the selection, back to the readiness view. */
  onDeselect?: () => void;
}

function IssueRow({ issue, onGo }: { issue: ReadinessIssue; onGo: () => void }) {
  const blocker = issue.severity === "error";
  return (
    <li>
      <button
        type="button"
        onClick={onGo}
        className="flex w-full items-start gap-2 rounded-card border border-border bg-surface px-3 py-2 text-left text-sm transition-colors hover:bg-surface-subtle"
      >
        {blocker ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-state-danger" aria-hidden="true" />
        ) : (
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-state-warning" aria-hidden="true" />
        )}
        <span className="min-w-0">
          <span className="block text-text">{issue.message}</span>
          <span className="mt-0.5 block font-mono text-[10px] uppercase tracking-wider text-text-muted">
            {blocker ? "Blocker" : "Warning"} · {issue.source === "field" ? "field-lint" : "publish"}
          </span>
        </span>
      </button>
    </li>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
      <span className="min-w-0 truncate text-right text-sm text-text">{value}</span>
    </div>
  );
}

function RowInspector({ row, onDeselect }: { row: InspectorRow; onDeselect?: () => void }) {
  return (
    <div data-testid="cockpit-inspector" className="rounded-card border border-border bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          {row.entity === "clause" ? (
            <ScrollText className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
          ) : (
            <MapPin className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
          )}
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            {row.entity === "clause" ? "Scope line" : "Area"}
          </span>
        </div>
        {onDeselect ? (
          <button
            type="button"
            onClick={onDeselect}
            aria-label="Close inspector"
            className="rounded-card p-1 text-text-muted transition-colors hover:bg-surface-subtle hover:text-text"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <p className="mt-1 font-display text-sm font-semibold text-text">{row.title}</p>

      {row.entity === "clause" ? (
        row.detail ? <p className="mt-1 text-xs text-text-muted">{row.detail}</p> : null
      ) : (
        <div className="mt-3 border-t border-border pt-2">
          <DetailRow label="Group" value={row.group || "—"} />
          <DetailRow label="Space type" value={row.spaceType ?? "—"} />
          <DetailRow label="Tasks" value={row.hasCustomTasks ? "Custom override" : "Inherits default"} />
          <p className="mt-2 text-xs text-text-muted">
            An area is a structural facet — it carries no certainty of its own.
          </p>
        </div>
      )}
    </div>
  );
}

export function Inspector({ target, readiness, onGoToIssue, onDeselect }: InspectorProps) {
  if (target.kind === "row") {
    return <RowInspector row={target.row} onDeselect={onDeselect} />;
  }

  const { blockers, warnings } = readiness;
  const clear = blockers.length === 0 && warnings.length === 0;

  return (
    <div data-testid="cockpit-inspector" className="rounded-card border border-border bg-surface p-3">
      <p className="font-display text-sm font-semibold text-text">Build readiness</p>
      <p className="mt-0.5 text-xs text-text-muted">
        What stands between this job and the field — each jumps to where it&rsquo;s fixed. Select a
        scope line or area to inspect it here.
      </p>

      {clear ? (
        <div className="mt-3 flex items-center gap-2 rounded-card border border-state-success/30 bg-state-success/10 px-3 py-2 text-sm text-state-success">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          Ready to publish — no blockers or warnings.
        </div>
      ) : (
        <ul className="mt-3 space-y-2">
          {blockers.map((issue) => (
            <IssueRow key={`b:${issue.code}`} issue={issue} onGo={() => onGoToIssue(issue)} />
          ))}
          {warnings.map((issue) => (
            <IssueRow key={`w:${issue.code}`} issue={issue} onGo={() => onGoToIssue(issue)} />
          ))}
        </ul>
      )}
    </div>
  );
}
