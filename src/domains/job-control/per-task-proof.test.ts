import { describe, expect, it } from "vitest";
import { EvidenceLinkSchema } from "./schema";
import type { EvidenceLink, TaskRef } from "./types";
import {
  buildPhilTaskContext,
  isRequiredEvidenceMet,
  isRequiredEvidenceMetForTask,
  requiredEvidenceForTask,
} from "./task-context";
import type { WorkPackage } from "./types";
import {
  PersistedJobControlSchema,
  type PersistedJobControl,
} from "../../server/job-control/compile-producer";
import { applyEvidenceLink, type EvidenceLinkRequest } from "../../server/job-control/evidence-link";

/**
 * #502 (foundation) — per-task-instance proof scope, additive + back-compatible.
 *
 * Proves: the new task-aware met rule generalises the package rule (untagged
 * links behave EXACTLY as today), a task-scoped link satisfies only its own task
 * instance, and the writer optionally persists a task scope without changing the
 * behaviour of any existing (untagged) caller.
 */

const T1: TaskRef = { areaId: "a1", stage: "roughIn", taskId: "t1" };
const T2: TaskRef = { areaId: "a1", stage: "roughIn", taskId: "t2" };

function link(over: Partial<EvidenceLink> = {}): EvidenceLink {
  return EvidenceLinkSchema.parse({
    id: "el_x",
    jobId: "job_1",
    evidenceId: "ev_1",
    workPackageId: "wp_1",
    requiredEvidenceId: "re1",
    role: "progress",
    ...over,
  });
}

// ── The met rule ──────────────────────────────────────────────────────────────

describe("isRequiredEvidenceMetForTask — back-compat with package-level links", () => {
  it("an untagged (package-level) link satisfies EVERY task — same as isRequiredEvidenceMet", () => {
    const links = [link()]; // no taskRef → package-level
    for (const task of [T1, T2]) {
      expect(isRequiredEvidenceMetForTask(links, "wp_1", "re1", task)).toBe(true);
      // strict generalisation: identical to the package rule for today's data
      expect(isRequiredEvidenceMetForTask(links, "wp_1", "re1", task)).toBe(
        isRequiredEvidenceMet(links, "wp_1", "re1"),
      );
    }
  });

  it("matches the package rule for unmet / wrong-package / no-proof cases", () => {
    const links = [link()];
    // unmet requirement
    expect(isRequiredEvidenceMetForTask(links, "wp_1", "re2", T1)).toBe(isRequiredEvidenceMet(links, "wp_1", "re2"));
    // wrong package
    expect(isRequiredEvidenceMetForTask(links, "wp_OTHER", "re1", T1)).toBe(isRequiredEvidenceMet(links, "wp_OTHER", "re1"));
    // a link with no proof never counts
    const noProof = [link({ evidenceId: null, observationId: null })];
    expect(isRequiredEvidenceMetForTask(noProof, "wp_1", "re1", T1)).toBe(false);
    expect(isRequiredEvidenceMet(noProof, "wp_1", "re1")).toBe(false);
  });

  it("an observation-backed package-level link counts the same way", () => {
    const links = [link({ evidenceId: null, observationId: "ob_1" })];
    expect(isRequiredEvidenceMetForTask(links, "wp_1", "re1", T1)).toBe(true);
  });
});

describe("isRequiredEvidenceMetForTask — task-scoped links (#502)", () => {
  it("a task-scoped link satisfies ONLY its own task instance", () => {
    const links = [link({ taskRef: T1 })];
    expect(isRequiredEvidenceMetForTask(links, "wp_1", "re1", T1)).toBe(true);
    expect(isRequiredEvidenceMetForTask(links, "wp_1", "re1", T2)).toBe(false); // cross-task isolation
  });

  it("a package-level link still covers every task even alongside a task-scoped one", () => {
    const links = [link({ id: "el_pkg" }), link({ id: "el_t2", taskRef: T2 })];
    // package-level el_pkg covers both; el_t2 additionally (redundantly) covers T2
    expect(isRequiredEvidenceMetForTask(links, "wp_1", "re1", T1)).toBe(true);
    expect(isRequiredEvidenceMetForTask(links, "wp_1", "re1", T2)).toBe(true);
  });

  it("stage and area are part of task identity (no bare-taskId collapse)", () => {
    const links = [link({ taskRef: { areaId: "a1", stage: "roughIn", taskId: "t1" } })];
    expect(isRequiredEvidenceMetForTask(links, "wp_1", "re1", { areaId: "a1", stage: "fitOff", taskId: "t1" })).toBe(false);
    expect(isRequiredEvidenceMetForTask(links, "wp_1", "re1", { areaId: "a2", stage: "roughIn", taskId: "t1" })).toBe(false);
  });
});

// ── The writer ────────────────────────────────────────────────────────────────

function artifact(): PersistedJobControl {
  return PersistedJobControlSchema.parse({
    jobId: "job_1",
    workPackages: [
      {
        id: "wp_1",
        jobId: "job_1",
        title: "East Gym",
        scopeClauseIds: [],
        boqLineRefs: [],
        taskRefs: [
          { areaId: "a1", stage: "roughIn", taskId: "t1" },
          { areaId: "a1", stage: "roughIn", taskId: "t2" },
        ],
        order: 0,
        requiredEvidence: [{ id: "re1", label: "Circuit test", kind: "test_result" }],
      },
    ],
    claimLines: [],
    closeoutRequirements: [],
    evidenceLinks: [],
    updatedAt: "2026-06-15T00:00:00.000Z",
  });
}

const CTX = { id: "el_new", at: "2026-06-15T12:00:00.000Z" };
const baseReq: EvidenceLinkRequest = { workPackageId: "wp_1", requiredEvidenceId: "re1", evidenceId: "ev_1" };

describe("applyEvidenceLink — optional task scope (#502, back-compatible)", () => {
  it("an untagged request writes a package-level link with NO taskRef (byte-identical shape)", () => {
    const r = applyEvidenceLink(artifact(), baseReq, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.created).toBe(true);
    expect("taskRef" in r.link).toBe(false); // no field stamped when absent
  });

  it("a tagged request stamps the task scope", () => {
    const r = applyEvidenceLink(artifact(), { ...baseReq, taskRef: T1 }, CTX);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.link.taskRef).toEqual(T1);
  });

  it("idempotency includes the task scope: same proof+task is a no-op; different task is a new link", () => {
    // first task-scoped link
    const first = applyEvidenceLink(artifact(), { ...baseReq, taskRef: T1 }, CTX);
    if (!first.ok) throw new Error("setup");
    expect(first.created).toBe(true);

    // same proof, SAME task → idempotent (no new link)
    const dupe = applyEvidenceLink(first.artifact, { ...baseReq, taskRef: T1 }, { ...CTX, id: "el_dupe" });
    if (!dupe.ok) throw new Error("unreachable");
    expect(dupe.created).toBe(false);

    // same proof, DIFFERENT task → a distinct link
    const other = applyEvidenceLink(first.artifact, { ...baseReq, taskRef: T2 }, { ...CTX, id: "el_t2" });
    if (!other.ok) throw new Error("unreachable");
    expect(other.created).toBe(true);
    expect(other.artifact.evidenceLinks).toHaveLength(2);
  });

  it("a package-level link and a task-scoped link for the same proof are distinct (not collapsed)", () => {
    const pkg = applyEvidenceLink(artifact(), baseReq, CTX);
    if (!pkg.ok) throw new Error("setup");
    const scoped = applyEvidenceLink(pkg.artifact, { ...baseReq, taskRef: T1 }, { ...CTX, id: "el_scoped" });
    if (!scoped.ok) throw new Error("unreachable");
    expect(scoped.created).toBe(true);
    expect(scoped.artifact.evidenceLinks).toHaveLength(2);
  });

  it("back-compat: two identical untagged requests stay idempotent, exactly as before", () => {
    const first = applyEvidenceLink(artifact(), baseReq, CTX);
    if (!first.ok) throw new Error("setup");
    const again = applyEvidenceLink(first.artifact, baseReq, { ...CTX, id: "el_again" });
    if (!again.ok) throw new Error("unreachable");
    expect(again.created).toBe(false);
    expect(first.artifact.evidenceLinks).toHaveLength(1);
  });
});

// ── The consumer (buildPhilTaskContext now resolves met per task) ─────────────

/** One package delivering two tasks (t1, t2) in the same area, with one
 *  required-evidence item — the area/package-granular shape the compiler emits. */
const pkgTwoTasks = [
  {
    id: "wp_1",
    jobId: "job_1",
    title: "East Gym",
    scopeClauseIds: [],
    boqLineRefs: [],
    taskRefs: [
      { areaId: "a1", stage: "roughIn", taskId: "t1" },
      { areaId: "a1", stage: "roughIn", taskId: "t2" },
    ],
    order: 0,
    requiredEvidence: [{ id: "re1", label: "Circuit test", kind: "test_result" }],
  },
] as unknown as WorkPackage[];

const metFor = (taskId: string, links: EvidenceLink[]): boolean => {
  const ctx = buildPhilTaskContext({
    workPackages: pkgTwoTasks,
    task: { areaId: "a1", stage: "roughIn", taskId },
    evidenceLinks: links,
  });
  return ctx.requiredEvidence[0]!.met;
};

describe("buildPhilTaskContext — resolves met per task (#502 consumer)", () => {
  it("PARITY: a package-level link marks the requirement met for EVERY task (today's behaviour)", () => {
    const links = [link({ taskRef: undefined })]; // package-level
    expect(metFor("t1", links)).toBe(true);
    expect(metFor("t2", links)).toBe(true);
  });

  it("PARITY: no proof link → not met for any task (honest empty)", () => {
    expect(metFor("t1", [])).toBe(false);
    expect(metFor("t2", [])).toBe(false);
  });

  it("a task-scoped link marks the requirement met ONLY for that task instance", () => {
    const links = [link({ taskRef: T1 })];
    expect(metFor("t1", links)).toBe(true); // the captured task
    expect(metFor("t2", links)).toBe(false); // its sibling in the same package is NOT cross-satisfied
  });

  it("a package-level requirement is still shared by all tasks (a task-scoped LINK doesn't change which ITEMS show)", () => {
    const ctx = buildPhilTaskContext({
      workPackages: pkgTwoTasks,
      task: { areaId: "a1", stage: "roughIn", taskId: "t2" },
      evidenceLinks: [link({ taskRef: T1 })],
    });
    // re1 has no taskRef → package-level → t2 still SEES it (just not met for t2)
    expect(ctx.requiredEvidence.map((e) => e.id)).toEqual(["re1"]);
    expect(ctx.requiredEvidence[0]!.met).toBe(false);
  });
});

// ── Per-task AUTHORING (the items themselves can be task-scoped) ───────────────

const pkgMixed = [
  {
    id: "wp_1",
    jobId: "job_1",
    title: "East",
    scopeClauseIds: [],
    boqLineRefs: [],
    taskRefs: [
      { areaId: "a1", stage: "roughIn", taskId: "t1" },
      { areaId: "a1", stage: "roughIn", taskId: "t2" },
    ],
    order: 0,
    requiredEvidence: [
      { id: "re1", label: "Board photo", kind: "photo" }, // package-level (no taskRef)
      { id: "re_t2", label: "T2 test", kind: "test_result", taskRef: { areaId: "a1", stage: "roughIn", taskId: "t2" } }, // scoped to t2
    ],
  },
] as unknown as WorkPackage[];

describe("requiredEvidenceForTask — per-task authoring (#506 keystone consumer)", () => {
  const itemsFor = (wp: WorkPackage, taskId: string, stage: "roughIn" | "fitOff" = "roughIn") =>
    requiredEvidenceForTask(wp, { areaId: "a1", stage, taskId }).map((e) => e.id).sort();

  it("PARITY: a package with no task-scoped requirement returns the whole list (today's behaviour)", () => {
    expect(itemsFor(pkgTwoTasks[0]!, "t1")).toEqual(["re1"]);
    expect(itemsFor(pkgTwoTasks[0]!, "t2")).toEqual(["re1"]);
  });

  it("a task-scoped requirement appears ONLY on its task; package-level appears on all", () => {
    expect(itemsFor(pkgMixed[0]!, "t1")).toEqual(["re1"]); // package-level only
    expect(itemsFor(pkgMixed[0]!, "t2")).toEqual(["re1", "re_t2"]); // package-level + its own
  });

  it("stage/area are part of the requirement scope (no bare-taskId collapse)", () => {
    // re_t2 is scoped to a1/roughIn/t2 — the same taskId in another stage must not see it
    expect(itemsFor(pkgMixed[0]!, "t2", "fitOff")).toEqual(["re1"]);
  });
});

describe("buildPhilTaskContext — surfaces per-task authored items (#506)", () => {
  it("t2 sees its extra requirement; t1 does not", () => {
    const ctxT1 = buildPhilTaskContext({ workPackages: pkgMixed, task: { areaId: "a1", stage: "roughIn", taskId: "t1" } });
    const ctxT2 = buildPhilTaskContext({ workPackages: pkgMixed, task: { areaId: "a1", stage: "roughIn", taskId: "t2" } });
    expect(ctxT1.requiredEvidence.map((e) => e.id)).toEqual(["re1"]);
    expect(ctxT2.requiredEvidence.map((e) => e.id).sort()).toEqual(["re1", "re_t2"]);
  });
});
