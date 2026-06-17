import { effectiveTasks } from "./format";
import { readTaskState, type JobTaskState, type TaskState } from "./taskState";
import type { Job, JobStage } from "./types";

/**
 * Canonical task index (#480) — a READ-ONLY derived model that materialises one
 * task instance per `(areaId, stage, taskId)` coordinate.
 *
 * Why this exists
 * ---------------
 * BuhlOS stores tasks as flat templates that live at the job level
 * (`Job.roughInTasks` / `fitOffTasks`) and are inherited by every area unless
 * the area overrides them. The real, state-bearing unit of work lives at
 * `dwellings[areaId][stage].tasks[taskId]` (progress.ts #198). So a bare
 * `taskId` is only a TEMPLATE id — the same id is materialised independently in
 * every inheriting area, and is NOT globally unique as a work instance.
 *
 * The task-model audit confirmed the real instance identity is the tuple
 * `(areaId, stage, taskId)`. This module turns that tuple into a stable,
 * deterministic canonical id so future work can treat tasks as job-level nodes
 * WITHOUT migrating storage.
 *
 * What this is NOT (deliberately, for #480)
 * -----------------------------------------
 *   - It changes NO storage, NO API, NO UI. Nothing consumes it yet.
 *   - It derives state ONLY from the existing stored three-state value
 *     (`not_started | in_progress | complete`) via the shared `readTaskState`
 *     — it never invents `ready` / `blocked` / `needs_review` / `signed_off`.
 *   - `system` is a CONSERVATIVE read-only classification of the task text
 *     (#481) — explicit electrical-system terms only, else `general`. It adds no
 *     storage and no authoring field; free text is never treated as reliable
 *     structured data.
 *   - `areaRefs` is always `[areaId]`. Multi-area tasks are future work.
 *
 * Parity guarantee
 * ----------------
 * The materialisation walks the structure exactly as the canonical progress
 * definition does (non-archived groups → non-archived areas → both stages →
 * `effectiveTasks`, override-wins, archived templates excluded). So the index
 * length equals `jobTaskProgress(...).total` and the count of `complete`
 * canonical tasks equals `.complete` for the same job + state — proven in the
 * tests. Field and office can never disagree.
 *
 * Cross-ref:
 *   src/domains/jobs/format.ts#effectiveTasks — the plan resolver this mirrors
 *   src/domains/jobs/progress.ts — the canonical count definition (#198)
 *   src/domains/jobs/taskState.ts — JobTaskState + readTaskState (state source)
 *   src/domains/job-control/compile.ts#deriveWorkPackageId — the id pattern
 *   docs/architecture/task-index.md
 */

/** The two stages a task can sit in — aliased to the jobs domain so the two can
 *  never drift apart. */
export type CanonicalTaskStage = JobStage;

/** The stored runtime state — aliased to the jobs domain's TaskState so this
 *  index never introduces a second, divergent state vocabulary. */
export type CanonicalTaskState = TaskState;

/**
 * Electrical work-system classification (#481). Derived CONSERVATIVELY from the
 * task text by `classifyCanonicalTaskSystem`; `general` whenever the text isn't
 * an explicit, unambiguous match. This is a read-model aid only — there is no
 * structured authoring field for it yet, and free text is not treated as
 * reliable structured data (P7: never invent certainty).
 */
export type CanonicalTaskSystem =
  | "power"
  | "data"
  | "lighting"
  | "emergency_lighting"
  | "fire"
  | "security"
  | "access_control"
  | "audio_visual"
  | "mechanical_controls"
  | "general";

/** The existing-storage coordinate a canonical task was materialised from. Kept
 *  on every task so callers can map a canonical id back to `(areaId, stage,
 *  taskId)` — i.e. back to `dwellings`, evidence, and job-control `TaskRef`. */
export interface CanonicalTaskSource {
  areaId: string;
  stage: CanonicalTaskStage;
  taskId: string;
}

/** One materialised task instance. */
export interface CanonicalTask {
  /** Stable, deterministic id derived from `jobId + areaId + stage + taskId`
   *  — never from the task name, never random. Unique per area, so an inherited
   *  template yields a DISTINCT id in each area (the bare-taskId hazard). */
  id: string;
  jobId: string;

  /** The originating template id (`task.id`). Shared across areas that inherit
   *  the same job-level template — preserved separately from `id` on purpose. */
  templateId: string;
  /** The template name (`task.name`). Display only; never identity. */
  title: string;

  /** The area this instance belongs to. */
  areaId: string;
  /** Areas this task relates to. Always `[areaId]` for #480 (single-area). */
  areaRefs: string[];

  stage: CanonicalTaskStage;
  /** Read from the stored task state; missing reads as `not_started`. */
  state: CanonicalTaskState;

  system: CanonicalTaskSystem;

  /** The existing-storage coordinate (back-compat / round-trip key). */
  source: CanonicalTaskSource;
}

const STAGES: ReadonlyArray<CanonicalTaskStage> = ["roughIn", "fitOff"];

/**
 * FNV-1a (32-bit) → 8 hex chars. Deterministic, no randomness, no time — the
 * SAME pattern as `deriveWorkPackageId` in job-control/compile.ts, re-implemented
 * here so the jobs domain carries no dependency on the job-control domain.
 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * The canonical id for a task coordinate. Deterministic and stable: the same
 * tuple always yields the same `ct_…` id, and a different area/stage/job yields
 * a different id. NEVER derived from the task name.
 */
export function deriveCanonicalTaskId(input: {
  jobId: string;
  areaId: string;
  stage: CanonicalTaskStage;
  taskId: string;
}): string {
  return `ct_${fnv1a(`${input.jobId}::${input.areaId}::${input.stage}::${input.taskId}`)}`;
}

/**
 * A stable string key for the existing-storage coordinate — for grouping /
 * lookup against `dwellings`, evidence, or job-control `TaskRef`. Pure.
 */
export function canonicalTaskSourceKey(input: {
  areaId: string;
  stage: CanonicalTaskStage;
  taskId: string;
}): string {
  return `${input.areaId}::${input.stage}::${input.taskId}`;
}

/**
 * True when a canonical task was materialised from the given coordinate. Pure
 * convenience over `canonicalTaskSourceKey`. NOT wired into job-control yet
 * (that mapping is #483).
 */
export function canonicalTaskMatchesSource(
  task: CanonicalTask,
  source: { areaId: string; stage: CanonicalTaskStage; taskId: string },
): boolean {
  return canonicalTaskSourceKey(task.source) === canonicalTaskSourceKey(source);
}

// ── Task system classification (#481) ────────────────────────────────────────
// Conservative, ordered, explicit-term classification of a task's TEXT into one
// electrical work system. Free text is not reliable structured data, so the bar
// is "an unambiguous term is present"; anything else is `general` (P7 — never
// invent certainty).
//
// Two matching modes against the normalised text (lowercased, punctuation →
// single spaces, e.g. "Fit-off A/V" → "fit off a v"):
//   - phrase(t): whole-word / whole-phrase match (space-padded) — used for short
//                or ambiguous tokens so "bracket" ≠ "rack", "metadata" ≠ "data",
//                "swap" ≠ "wap", "available" ≠ "av", "plan" ≠ "lan".
//   - loose(t):  substring match — used only for safe stems, e.g. "light" (so
//                "downlight"/"lighting" match) and "switchboard".
//
// ORDER MATTERS and is the main false-positive guard: more specific systems are
// tested first so a shared token can't be stolen by a broader one —
//   emergency_lighting → access_control → data → lighting → fire → security →
//   audio_visual → mechanical_controls → power → general
// e.g. "lighting circuit" → lighting (not power); "data outlet" → data (not
// power); "emergency light" → emergency_lighting (not lighting); "card reader"
// → access_control (not security).
//
// Deliberately NOT matched (too ambiguous → left `general`): bare "switch" /
// "switching", bare "sensor", bare "fire" (fire-rated / fire collar = passive
// fire, not electrical), bare "alarm", bare "cable", bare "mechanical".

function normaliseTaskText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

interface SystemRule {
  system: CanonicalTaskSystem;
  /** Whole-word / whole-phrase terms (matched space-padded). */
  phrases?: ReadonlyArray<string>;
  /** Substring stems — only safe, unambiguous stems. */
  loose?: ReadonlyArray<string>;
}

const SYSTEM_RULES: ReadonlyArray<SystemRule> = [
  {
    system: "emergency_lighting",
    loose: ["emergency light", "exit light", "egress light"],
  },
  {
    system: "access_control",
    phrases: [
      "card reader",
      "card access",
      "swipe",
      "door strike",
      "electric strike",
      "mag lock",
      "maglock",
      "rex",
      "request to exit",
    ],
    loose: ["access control"],
  },
  {
    system: "data",
    phrases: [
      "data",
      "comms",
      "rack",
      "patch",
      "wap",
      "network",
      "ethernet",
      "cat5",
      "cat6",
      "cat6a",
      "rj45",
      "lan",
      "fibre",
      "fiber",
    ],
    loose: ["structured cabling", "patch panel"],
  },
  {
    system: "lighting",
    phrases: [
      "dali",
      "luminaire",
      "luminaires",
      "batten",
      "lux",
      "photocell",
      "light switch",
    ],
    loose: ["light", "occupancy sensor", "daylight sensor", "pe cell"],
  },
  {
    system: "fire",
    phrases: ["fip", "ewis"],
    loose: [
      "fire alarm",
      "fire detection",
      "fire detector",
      "fire indicator",
      "smoke detector",
      "smoke detection",
      "smoke alarm",
      "heat detector",
      "thermal detector",
    ],
  },
  {
    system: "security",
    phrases: ["cctv", "security", "intruder", "surveillance", "nvr", "pir", "duress"],
    loose: ["security alarm", "intruder alarm", "alarm panel", "motion detector"],
  },
  {
    system: "audio_visual",
    phrases: [
      "av",
      "audio",
      "audiovisual",
      "projector",
      "speaker",
      "speakers",
      "display",
      "displays",
      "hdmi",
      "vga",
      "amplifier",
    ],
    loose: ["audio visual", "pa system", "public address", "sound system", "tv outlet", "tv point"],
  },
  {
    system: "mechanical_controls",
    phrases: ["bms", "ahu", "vsd", "vav", "fcu"],
    loose: [
      "mechanical control",
      "mechanical services",
      "mechanical interface",
      "building management",
      "hvac control",
      "plant control",
    ],
  },
  {
    system: "power",
    phrases: [
      "power",
      "gpo",
      "circuit",
      "mains",
      "submain",
      "isolator",
      "socket",
      "outlet",
      "rcd",
      "rcbo",
      "mcb",
      "busbar",
      "db",
    ],
    loose: [
      "switchboard",
      "distribution board",
      "sub board",
      "subboard",
      "power point",
      "powerpoint",
      "consumer mains",
    ],
  },
];

/**
 * Classify a task's text into an electrical work system. Pure and conservative:
 * returns `general` unless an explicit, unambiguous term matches (see
 * SYSTEM_RULES + the ordering rationale above). Reads `description` too for
 * forward-compatibility, though task templates carry no description today.
 */
export function classifyCanonicalTaskSystem(input: {
  title: string;
  description?: string | null;
}): CanonicalTaskSystem {
  const text = normaliseTaskText(`${input.title} ${input.description ?? ""}`);
  if (!text) return "general";
  const padded = ` ${text} `;
  const hasPhrase = (t: string) => padded.includes(` ${t} `);
  const hasLoose = (t: string) => text.includes(t);

  for (const rule of SYSTEM_RULES) {
    if (rule.phrases?.some(hasPhrase)) return rule.system;
    if (rule.loose?.some(hasLoose)) return rule.system;
  }
  return "general";
}

/**
 * Build the canonical task index for a job. Pure and read-only.
 *
 * Walks non-archived groups → non-archived areas → both stages → `effectiveTasks`
 * (override-wins, archived templates excluded), emitting one `CanonicalTask` per
 * effective task. State comes from `taskState` via `readTaskState` (missing ⇒
 * `not_started`). Passing no state yields every task as `not_started`.
 */
export function buildCanonicalTaskIndex(args: {
  job: Job;
  taskState?: JobTaskState | null;
}): CanonicalTask[] {
  const { job } = args;
  const taskState = args.taskState ?? {};
  const jobId = job.id;
  const out: CanonicalTask[] = [];

  for (const group of job.areaGroups ?? []) {
    if (!group || group.archived) continue;
    for (const area of group.areas ?? []) {
      if (!area || area.archived) continue;
      for (const stage of STAGES) {
        for (const template of effectiveTasks(job, area, stage)) {
          const source: CanonicalTaskSource = {
            areaId: area.id,
            stage,
            taskId: template.id,
          };
          out.push({
            id: deriveCanonicalTaskId({ jobId, areaId: area.id, stage, taskId: template.id }),
            jobId,
            templateId: template.id,
            title: template.name,
            areaId: area.id,
            areaRefs: [area.id],
            stage,
            state: readTaskState(taskState, area.id, stage, template.id),
            system: classifyCanonicalTaskSystem({ title: template.name }),
            source,
          });
        }
      }
    }
  }

  return out;
}
