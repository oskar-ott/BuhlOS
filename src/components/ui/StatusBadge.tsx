import { Pill } from "./Pill";

/**
 * Visible state marker for the rebuild's status taxonomy.
 * `live` = the feature is wired to real data; `v1` = first real version
 * shipped (kept for honest signalling per non-negotiable §4).
 *
 * Anything else (e.g. `coming`, `draft`) renders neutral.
 */

export type FeatureStatus = "live" | "v1" | "coming" | "draft";

const TONE_BY_STATUS = {
  live: "success",
  v1: "info",
  coming: "neutral",
  draft: "warning",
} as const;

const LABEL_BY_STATUS: Record<FeatureStatus, string> = {
  live: "Live",
  v1: "v1",
  coming: "Coming",
  draft: "Draft",
};

export function StatusBadge({ status }: { status: FeatureStatus }) {
  return <Pill tone={TONE_BY_STATUS[status]}>{LABEL_BY_STATUS[status]}</Pill>;
}
