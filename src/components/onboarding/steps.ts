/**
 * Onboarding step taxonomy.
 *
 * Steps 1–8 are the numbered flow shown on the progress bar; "welcome" and
 * "ready" sit outside the count (entry + celebration). Skip is disallowed
 * on Welcome / Identity / Ready per the design handoff §"Skip / safe
 * defaults".
 */
export type StepId =
  | "welcome"
  | "identity"
  | "hours"
  | "gear"
  | "jobs"
  | "job-interface"
  | "site-data"
  | "permissions"
  | "ready";

export interface StepMeta {
  id: StepId;
  /** Step number shown on the progress bar; null = no bar (welcome/ready). */
  number: number | null;
  /** Whether the "Skip" affordance is available on this step. */
  skippable: boolean;
}

export const TOTAL_STEPS = 8;

export const STEPS: ReadonlyArray<StepMeta> = [
  { id: "welcome", number: null, skippable: false },
  { id: "identity", number: 2, skippable: false },
  { id: "hours", number: 3, skippable: true },
  { id: "gear", number: 4, skippable: true },
  { id: "jobs", number: 5, skippable: true },
  { id: "job-interface", number: 6, skippable: true },
  { id: "site-data", number: 7, skippable: true },
  { id: "permissions", number: 8, skippable: true },
  { id: "ready", number: null, skippable: false },
];

export function getStepMeta(id: StepId): StepMeta {
  const found = STEPS.find((s) => s.id === id);
  if (!found) throw new Error(`Unknown onboarding step: ${id}`);
  return found;
}

export function isStepId(value: string | null | undefined): value is StepId {
  return typeof value === "string" && STEPS.some((s) => s.id === value);
}

export function nextStep(id: StepId): StepId {
  const idx = STEPS.findIndex((s) => s.id === id);
  if (idx < 0 || idx >= STEPS.length - 1) return "ready";
  const next = STEPS[idx + 1];
  return next ? next.id : "ready";
}
