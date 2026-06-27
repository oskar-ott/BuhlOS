import { Layers, MapPin, ListChecks } from "lucide-react";
import { Pill } from "@/components/ui/Pill";
import type { ResolvedTargetParts } from "@/domains/evidence/target-label";

/**
 * Compact context chips for an evidence capture's stage / area / task (#260).
 *
 * Turns the area/stage/task context already on every evidence row into
 * first-class chips instead of one joined body string. A DERIVED projection —
 * no new storage. When the capture has no context at all the parent renders
 * its own "Unattached" pill (the queue/drawer differ in copy), so this
 * component renders nothing for an empty `parts`.
 *
 * Honesty (P7): an unresolvable id (`resolved: false`) renders the raw id with
 * an "(unknown)" hint — never a guessed name, never a blank.
 */
export function EvidenceContextChips({ parts }: { parts: ResolvedTargetParts }) {
  const hasAny = Boolean(parts.stage || parts.area || parts.task);
  if (!hasAny) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {parts.stage ? (
        <Pill tone="neutral">
          <Layers aria-hidden="true" className="h-3 w-3" />
          {parts.stage.label}
        </Pill>
      ) : null}
      {parts.area ? (
        <Pill tone="neutral">
          <MapPin aria-hidden="true" className="h-3 w-3" />
          {parts.area.label}
          {!parts.area.resolved ? (
            <span className="text-text-muted">(unknown)</span>
          ) : null}
        </Pill>
      ) : null}
      {parts.task ? (
        <Pill tone="neutral">
          <ListChecks aria-hidden="true" className="h-3 w-3" />
          {parts.task.label}
          {!parts.task.resolved ? (
            <span className="text-text-muted">(unknown)</span>
          ) : null}
        </Pill>
      ) : null}
    </span>
  );
}
