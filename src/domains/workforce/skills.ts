import { z } from "zod";

/**
 * Skills matrix (#335) — pure schema + composition, no I/O, no React.
 *
 * "Who can do what" across the crew: a catalogue of skills, per-worker
 * competency entries at three levels, and the matrix + queries the office reads
 * (find everyone who can do X, coverage per skill). Pure and decoupled — it
 * takes a worker list in (the caller passes ACTIVE workers; this module doesn't
 * reach into the user domain), so it has zero shared-file contact.
 *
 * Storage (deferred): a kind-discriminated workforce store entry or a dedicated
 * skills blob, the api/skills.js endpoint and the matrix UI are follow-ups that
 * consume this foundation.
 */

export const SKILL_LEVELS = ["can-do", "experienced", "can-supervise"] as const;
export const SkillLevelSchema = z.enum(SKILL_LEVELS);
export type SkillLevel = z.infer<typeof SkillLevelSchema>;

const LEVEL_RANK: Record<SkillLevel, number> = {
  "can-do": 1,
  experienced: 2,
  "can-supervise": 3,
};

export const SkillSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    archived: z.boolean().optional(),
  })
  .passthrough();
export type Skill = z.infer<typeof SkillSchema>;

export const WorkerSkillSchema = z
  .object({
    workerId: z.string(),
    skillId: z.string(),
    level: SkillLevelSchema,
    note: z.string().nullable().optional(),
  })
  .passthrough();
export type WorkerSkill = z.infer<typeof WorkerSkillSchema>;

export interface MatrixWorker {
  id: string;
  name?: string | null;
}

/** True when `have` meets or exceeds `min` in the level ordering. */
export function meetsLevel(have: SkillLevel, min: SkillLevel): boolean {
  return LEVEL_RANK[have] >= LEVEL_RANK[min];
}

/** The highest level a worker holds for a skill (null if none). A worker may
 *  have multiple entries for one skill; the strongest wins. */
export function workerSkillLevel(
  entries: ReadonlyArray<WorkerSkill>,
  workerId: string,
  skillId: string,
): SkillLevel | null {
  let best: SkillLevel | null = null;
  for (const e of entries) {
    if (e.workerId !== workerId || e.skillId !== skillId) continue;
    if (best === null || LEVEL_RANK[e.level] > LEVEL_RANK[best]) best = e.level;
  }
  return best;
}

/** Worker ids that hold `skillId` at >= `minLevel` (default "can-do"), each once,
 *  ordered by level (strongest first) then workerId for determinism. */
export function workersWithSkill(
  entries: ReadonlyArray<WorkerSkill>,
  skillId: string,
  minLevel: SkillLevel = "can-do",
): string[] {
  const best = new Map<string, SkillLevel>();
  for (const e of entries) {
    if (e.skillId !== skillId || !meetsLevel(e.level, minLevel)) continue;
    const cur = best.get(e.workerId);
    if (cur === undefined || LEVEL_RANK[e.level] > LEVEL_RANK[cur]) best.set(e.workerId, e.level);
  }
  return [...best.entries()]
    .sort((a, b) => LEVEL_RANK[b[1]] - LEVEL_RANK[a[1]] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([workerId]) => workerId);
}

export interface SkillCoverage {
  skillId: string;
  total: number;
  byLevel: Record<SkillLevel, number>;
}

/** How many workers hold a skill, split by their highest level. */
export function skillCoverage(entries: ReadonlyArray<WorkerSkill>, skillId: string): SkillCoverage {
  const byLevel: Record<SkillLevel, number> = { "can-do": 0, experienced: 0, "can-supervise": 0 };
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.skillId !== skillId || seen.has(e.workerId)) continue;
    const level = workerSkillLevel(entries, e.workerId, skillId);
    if (level) {
      byLevel[level] += 1;
      seen.add(e.workerId);
    }
  }
  return { skillId, total: seen.size, byLevel };
}

export interface SkillMatrixRow {
  worker: MatrixWorker;
  /** skillId → the worker's highest level, or null. */
  cells: Record<string, SkillLevel | null>;
  /** How many of the matrix's skills this worker holds (any level). */
  skillCount: number;
}

export interface SkillsMatrix {
  /** The non-archived skills shown as columns (input order). */
  skills: Skill[];
  rows: SkillMatrixRow[];
}

/** Build the matrix over the given workers × (non-archived) skills. Pure. */
export function buildSkillsMatrix(input: {
  skills: ReadonlyArray<Skill>;
  workers: ReadonlyArray<MatrixWorker>;
  entries: ReadonlyArray<WorkerSkill>;
}): SkillsMatrix {
  const skills = input.skills.filter((s) => s.archived !== true);
  const rows: SkillMatrixRow[] = input.workers.map((worker) => {
    const cells: Record<string, SkillLevel | null> = {};
    let skillCount = 0;
    for (const s of skills) {
      const level = workerSkillLevel(input.entries, worker.id, s.id);
      cells[s.id] = level;
      if (level) skillCount += 1;
    }
    return { worker, cells, skillCount };
  });
  return { skills, rows };
}

/** First case-insensitive duplicate skill LABEL among non-archived skills, or
 *  null. Guards the catalogue against "Test & Tag" vs "test & tag". */
export function findDuplicateSkillLabel(skills: ReadonlyArray<Skill>): string | null {
  const seen = new Set<string>();
  for (const s of skills) {
    if (s.archived === true) continue;
    const key = s.label.trim().toLowerCase();
    if (key && seen.has(key)) return s.label;
    seen.add(key);
  }
  return null;
}
