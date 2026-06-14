import type { Job, JobArea, JobTaskTemplate } from "../jobs/types";
import { effectiveTasks } from "../jobs/format";
import {
  WARNING_CLASSIFICATIONS,
  type ScopeClassification,
  type ScopeReconciliation,
} from "./reconciliation";
import { boqLineRefKey, taskRefKey } from "./spine";
import type {
  BoqLineRef,
  GoverningDocRef,
  RequiredEvidence,
  TaskRef,
  WorkPackage,
  WorkPackageWarning,
} from "./types";

/**
 * Compile reconciled scope into work packages with provenance (#367). Pure —
 * reconciled scope (#366) + the job's existing structure → work packages that
 * each name the scope clauses they deliver, the BOQ lines that fund them, the
 * EXISTING tasks that do the work (by coordinate), the proof required and the
 * site warnings.
 *
 * Constitutional rules this engine obeys:
 *   - NEVER mints a task. It maps reconciled scope onto tasks that already
 *     exist in the structure; a clause with no delivering task is a NAMED GAP,
 *     never a fabricated task.
 *   - NEVER owns task state (state stays in `dwellings`, progress.ts #198).
 *   - Id-stable: a package's id derives deterministically from its area, so
 *     re-compiling shows deltas, never duplicates — no Math.random, no by-name
 *     fusing (the #190 hazard the legacy convert handler fell into).
 *   - Excluded / by-others / admin-only / closeout classes never generate field
 *     tasks; by-others / reuse-existing / variation-trigger contribute a WARNING.
 *
 * The API that reads `scope.json` + structure, returns a draft diff, and
 * applies a confirmed diff in one batched write is a follow-up (depends on
 * #366's store). This slice is the engine + tests.
 */

export type JobStructure = Pick<Job, "id" | "areaGroups" | "roughInTasks" | "fitOffTasks">;

/** Classes that deliver field work (contribute tasks + BOQ lines to a package). */
const FIELD_CLASSES: ReadonlyArray<ScopeClassification> = [
  "priced",
  "general_allowance",
  "pc_provisional",
];

export type CompileGapKind =
  | "unclassified_clause" // still `unclear` — cannot compile
  | "no_delivering_task" // a field clause with no confirmed delivering task
  | "task_not_found" // a deliveredBy coordinate isn't in the live structure
  | "warning_without_area" // a warning clause with no area to attach to
  | "no_field_class_has_tasks"; // excluded/closeout/admin clause carrying tasks

export interface CompileGap {
  kind: CompileGapKind;
  clauseId?: string;
  ref?: TaskRef;
  message: string;
}

export interface CompileResult {
  workPackages: WorkPackage[];
  gaps: CompileGap[];
}

/** Stable FNV-1a hash → a deterministic, collision-resistant package id. No
 *  randomness, no time — same (job, area) always yields the same `wp_…`. */
export function deriveWorkPackageId(jobId: string, areaId: string): string {
  const input = `${jobId}::${areaId}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `wp_${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** Flatten the structure's live (non-archived) areas with their group order. */
function liveAreas(structure: JobStructure): Map<string, { area: JobArea; order: number }> {
  const out = new Map<string, { area: JobArea; order: number }>();
  let order = 0;
  for (const group of structure.areaGroups ?? []) {
    if (group.archived) continue;
    for (const area of group.areas ?? []) {
      if (area.archived) continue;
      out.set(area.id, { area, order: order++ });
    }
  }
  return out;
}

/** Resolve a task coordinate against the live structure exactly as Phil does
 *  (override-wins, archived-excluded). Null when it points at nothing real. */
export function resolveTaskRef(structure: JobStructure, ref: TaskRef): JobTaskTemplate | null {
  const areas = liveAreas(structure);
  const found = areas.get(ref.areaId);
  if (!found) return null;
  const tasks = effectiveTasks(structure, found.area, ref.stage);
  return tasks.find((t) => t.id === ref.taskId) ?? null;
}

interface AreaAccumulator {
  areaId: string;
  scopeClauseIds: Set<string>;
  boqLineRefs: Map<string, BoqLineRef>;
  taskRefs: Map<string, TaskRef>;
  requiredEvidence: Map<string, RequiredEvidence>;
  warnings: WorkPackageWarning[];
  docIds: Set<string>;
}

function accFor(map: Map<string, AreaAccumulator>, areaId: string): AreaAccumulator {
  let acc = map.get(areaId);
  if (!acc) {
    acc = {
      areaId,
      scopeClauseIds: new Set(),
      boqLineRefs: new Map(),
      taskRefs: new Map(),
      requiredEvidence: new Map(),
      warnings: [],
      docIds: new Set(),
    };
    map.set(areaId, acc);
  }
  return acc;
}

/**
 * THE compile engine. Reconciled scope + structure → packages + named gaps.
 * Packages are area-grouped; ids are area-derived and stable.
 */
export function compileWorkPackages(
  rec: ScopeReconciliation,
  structure: JobStructure,
): CompileResult {
  const areas = liveAreas(structure);
  const accumulators = new Map<string, AreaAccumulator>();
  const gaps: CompileGap[] = [];

  for (const cc of rec.clauseClassifications) {
    const cls = cc.classification;

    if (cls === "unclear") {
      gaps.push({
        kind: "unclassified_clause",
        clauseId: cc.clauseId,
        message: `Clause ${cc.clauseId} is unclassified — classify it before compiling`,
      });
      continue;
    }

    const isField = FIELD_CLASSES.includes(cls);
    const isWarning = WARNING_CLASSIFICATIONS.includes(cls);

    if (isField) {
      if (cc.deliveredBy.length === 0) {
        gaps.push({
          kind: "no_delivering_task",
          clauseId: cc.clauseId,
          message: `Clause ${cc.clauseId} is priced but has no delivering task`,
        });
        continue;
      }
      for (const ref of cc.deliveredBy) {
        if (!resolveTaskRef(structure, ref)) {
          gaps.push({
            kind: "task_not_found",
            clauseId: cc.clauseId,
            ref,
            message: `Clause ${cc.clauseId} points at task ${taskRefKey(ref)} which is not in the structure`,
          });
          continue;
        }
        const acc = accFor(accumulators, ref.areaId);
        acc.scopeClauseIds.add(cc.clauseId);
        acc.taskRefs.set(taskRefKey(ref), ref);
        for (const b of cc.boqLineRefs) acc.boqLineRefs.set(boqLineRefKey(b), b);
        for (const e of cc.requiredEvidence) acc.requiredEvidence.set(e.id, e);
        for (const d of cc.documentIds) acc.docIds.add(d);
      }
      continue;
    }

    if (isWarning) {
      if (!cc.warningText) continue; // no authored warning → nothing to surface
      const warningAreas = uniqueAreaIds(cc.deliveredBy);
      if (warningAreas.length === 0) {
        gaps.push({
          kind: "warning_without_area",
          clauseId: cc.clauseId,
          message: `Warning clause ${cc.clauseId} has no area to attach to`,
        });
        continue;
      }
      for (const areaId of warningAreas) {
        const acc = accFor(accumulators, areaId);
        acc.warnings.push({
          id: `warn_${cc.clauseId}`,
          kind: cls as WorkPackageWarning["kind"],
          text: cc.warningText,
          scopeClauseId: cc.clauseId,
        });
      }
      continue;
    }

    // Remaining: excluded / admin_only / closeout — never generate field tasks.
    if (cc.deliveredBy.length > 0) {
      gaps.push({
        kind: "no_field_class_has_tasks",
        clauseId: cc.clauseId,
        message: `Clause ${cc.clauseId} is ${cls} but has delivering tasks assigned`,
      });
    }
    // closeout obligations feed the closeout matrix (#374), not work packages.
  }

  const workPackages: WorkPackage[] = [...accumulators.values()]
    .map((acc) => {
      const meta = areas.get(acc.areaId);
      const pkg: WorkPackage = {
        id: deriveWorkPackageId(structure.id, acc.areaId),
        jobId: structure.id,
        title: meta?.area.name ?? acc.areaId,
        scopeClauseIds: [...acc.scopeClauseIds].sort(),
        boqLineRefs: [...acc.boqLineRefs.values()],
        taskRefs: [...acc.taskRefs.values()],
        order: meta?.order ?? 0,
      };
      if (acc.requiredEvidence.size > 0) pkg.requiredEvidence = [...acc.requiredEvidence.values()];
      if (acc.warnings.length > 0) pkg.warnings = acc.warnings;
      if (acc.docIds.size > 0) {
        pkg.governingDocRefs = [...acc.docIds].sort().map((documentId): GoverningDocRef => ({ documentId }));
      }
      return pkg;
    })
    .sort((a, b) => a.order - b.order);

  return { workPackages, gaps };
}

function uniqueAreaIds(refs: ReadonlyArray<TaskRef>): string[] {
  return [...new Set(refs.map((r) => r.areaId))];
}

// ── Diff (delta-only re-compile) ─────────────────────────────────────────────

export interface CompileDiff {
  addedPackages: WorkPackage[];
  updatedPackages: Array<{ id: string; before: WorkPackage; after: WorkPackage }>;
  removedPackages: WorkPackage[];
  gaps: CompileGap[];
}

/** Compare a previous compile to the next one by id. Unchanged packages produce
 *  no delta — the id-stable derivation guarantees re-running identical input is
 *  a no-op (the #190 by-name-fusing guard). */
export function diffCompile(previous: CompileResult | null, next: CompileResult): CompileDiff {
  const prev = new Map((previous?.workPackages ?? []).map((p) => [p.id, p]));
  const nextById = new Map(next.workPackages.map((p) => [p.id, p]));

  const addedPackages: WorkPackage[] = [];
  const updatedPackages: CompileDiff["updatedPackages"] = [];
  for (const pkg of next.workPackages) {
    const before = prev.get(pkg.id);
    if (!before) addedPackages.push(pkg);
    else if (!samePackage(before, pkg)) updatedPackages.push({ id: pkg.id, before, after: pkg });
  }
  const removedPackages = [...prev.values()].filter((p) => !nextById.has(p.id));

  return { addedPackages, updatedPackages, removedPackages, gaps: next.gaps };
}

function samePackage(a: WorkPackage, b: WorkPackage): boolean {
  return stable(a) === stable(b);
}

/** Deterministic structural string for change detection (keys sorted). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${k}:${stable(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
