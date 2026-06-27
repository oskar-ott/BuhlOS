import { AlertOctagon, ArrowRightLeft, Camera, ClipboardCheck, Inbox, Package } from "lucide-react";
import { relativeWhen } from "@/domains/jobs/format";
import { actionLabel } from "@/domains/audit-log/format";
import type { AuditLogEntry, AuditTargetType } from "@/domains/audit-log/types";

/**
 * Shared audit-log activity row (#220). Extracted from JobActivityFeed so the
 * per-job feed and the cross-job office feed render entries identically — one
 * component, never two. `jobLabel` is shown only in the cross-job view (the
 * per-job feed already has the job in its heading).
 */
export function ActivityRow({ entry: e, jobLabel }: { entry: AuditLogEntry; jobLabel?: string | null }) {
  const Icon = iconForTargetType(e.targetType);
  return (
    <div className="flex gap-3 rounded-card border border-border bg-surface p-3">
      <div className="mt-0.5 shrink-0 rounded-card border border-border bg-surface-subtle p-1.5">
        <Icon aria-hidden="true" className="h-4 w-4 text-text-muted" />
      </div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-display font-semibold text-text">{actionLabel(e.action)}</span>
          {jobLabel ? <span className="text-xs font-medium text-brand-navy">{jobLabel}</span> : null}
          <span className="text-xs text-text-muted">
            by {e.actorName}
            {e.actorRole ? ` · ${e.actorRole}` : ""}
          </span>
          <span className="text-xs text-text-muted">· {relativeWhen(e.ts)}</span>
        </p>
        {e.summary ? (
          <p className="line-clamp-2 whitespace-pre-wrap text-sm text-text-muted">{e.summary}</p>
        ) : null}
      </div>
    </div>
  );
}

export function iconForTargetType(t: AuditTargetType) {
  switch (t) {
    case "evidence":
      return Camera;
    case "snag":
      return AlertOctagon;
    case "itp_template":
    case "itp_instance":
      return ClipboardCheck;
    case "observation":
      return ArrowRightLeft;
    case "material_request":
      return Package;
    default:
      return Inbox;
  }
}
