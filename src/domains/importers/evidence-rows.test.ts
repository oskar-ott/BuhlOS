import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * J4 evidence + evidence-link row builder (pure). Re-keys legacy coordinates onto
 * the canonical task identity via the shared proof-projection, classifies proof
 * granularity honestly (task/area/job), and fails closed on any unresolvable or
 * out-of-CHECK record. Binaries stay in Blob (only blob_url/photo_blob_id refs).
 */

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../scripts/importers/lib/evidence-rows.js");
const mod = requireFromHere(p) as {
  buildEvidenceRows: (sources: unknown, ctx: unknown) => {
    evidenceRows: Array<Record<string, unknown>>;
    quarantine: Array<{ table: string; id: string; reason: string }>;
    byGranularity: { task: number; area: number; job: number };
  };
  buildEvidenceLinkRows: (tenantId: string, ev: Array<{ id: string; task_id: string | null }>) => Array<Record<string, unknown>>;
  EVIDENCE_INSERT_COLS: string[];
  EVIDENCE_MUTABLE_COLS: string[];
};
const { buildEvidenceRows, buildEvidenceLinkRows, EVIDENCE_INSERT_COLS, EVIDENCE_MUTABLE_COLS } = mod;

const legacyIdPath = requireFromHere.resolve("../../../scripts/importers/lib/structure-legacy-id.js");
const { compositeLegacyId } = requireFromHere(legacyIdPath) as { compositeLegacyId: (j: string, l: string) => string };

const AL1 = compositeLegacyId("j1", "a1");
function ctx() {
  return {
    tenantId: "T",
    jobMap: new Map([["j1", "job-uuid"]]),
    areaMap: new Map([[AL1, "area-uuid"]]),
    taskMap: new Map([[`${AL1}|roughIn|t1`, "task-uuid"]]),
    userMap: new Map([["u1", "user-uuid"]]),
  };
}
function src(evidence: unknown[]) {
  return { jobs: { jobs: [{ id: "j1" }] }, jobData: { j1: { evidence } } };
}
const base = { status: "submitted", source: "phil", capturedAt: "2026-01-01T00:00:00.000Z" };
const note = (over: Record<string, unknown> = {}) => ({ id: "n", kind: "note", note: "hi", ...base, ...over });
const photo = (over: Record<string, unknown> = {}) => ({ id: "p", kind: "photo", photoId: "pid", photoUrl: "https://blob/x.jpg", ...base, ...over });

describe("buildEvidenceRows — re-keying + granularity", () => {
  it("job-level note: no area/task, granularity job, no link", () => {
    const { evidenceRows, quarantine, byGranularity } = buildEvidenceRows(src([note({ id: "ev1" })]), ctx());
    expect(quarantine).toHaveLength(0);
    expect(evidenceRows[0]).toMatchObject({ legacy_id: "ev1", kind: "note", note: "hi", site_area_id: null, task_id: null, job_id: "job-uuid" });
    expect(byGranularity).toEqual({ task: 0, area: 0, job: 1 });
    expect(buildEvidenceLinkRows("T", evidenceRows.map((r) => ({ id: "EF", task_id: r.task_id as string | null })))).toHaveLength(0);
  });

  it("area-level photo: site_area_id resolved, task_id null, captured_by resolved, granularity area", () => {
    const { evidenceRows, byGranularity } = buildEvidenceRows(src([photo({ id: "ev2", areaId: "a1", status: "reviewed", source: "admin", capturedById: "u1", capturedByName: "Tom" })]), ctx());
    expect(evidenceRows[0]).toMatchObject({ legacy_id: "ev2", site_area_id: "area-uuid", task_id: null, captured_by: "user-uuid", captured_by_label: "Tom", blob_url: "https://blob/x.jpg" });
    expect(byGranularity.area).toBe(1);
  });

  it("task-level photo: full coordinate resolves to task_id; granularity task; link created", () => {
    const { evidenceRows, byGranularity } = buildEvidenceRows(src([photo({ id: "ev3", areaId: "a1", stage: "roughIn", taskId: "t1" })]), ctx());
    expect(evidenceRows[0]).toMatchObject({ task_id: "task-uuid", site_area_id: "area-uuid", stage: "roughIn" });
    expect(byGranularity.task).toBe(1);
    const links = buildEvidenceLinkRows("T", [{ id: "EF3", task_id: "task-uuid" }]);
    expect(links[0]).toEqual({ tenant_id: "T", evidence_file_id: "EF3", linked_entity_type: "task", linked_entity_id: "task-uuid", link_role: "proof" });
  });

  it("QUARANTINES a taskId with an incomplete coordinate (no stage) — never guessed onto a task", () => {
    const { quarantine, evidenceRows } = buildEvidenceRows(src([note({ id: "ev4", areaId: "a1", taskId: "t1" })]), ctx());
    expect(evidenceRows).toHaveLength(0);
    expect(quarantine[0]!.reason).toMatch(/without a full/);
  });

  it("QUARANTINES an unresolvable areaId and an unresolvable taskId (no wrong-task attach)", () => {
    const badArea = buildEvidenceRows(src([note({ id: "ev5", areaId: "ghost" })]), ctx());
    expect(badArea.quarantine[0]!.reason).toMatch(/does not resolve to a site_area/);
    const badTask = buildEvidenceRows(src([photo({ id: "ev6", areaId: "a1", stage: "fitOff", taskId: "nope" })]), ctx());
    expect(badTask.quarantine[0]!.reason).toMatch(/does not resolve to a task/);
  });

  it("QUARANTINES out-of-CHECK kind/status/source and broken photo/note payloads + duplicates", () => {
    expect(buildEvidenceRows(src([note({ id: "a", status: "weird" })]), ctx()).quarantine[0]!.reason).toMatch(/status/);
    expect(buildEvidenceRows(src([note({ id: "b", source: "client" })]), ctx()).quarantine[0]!.reason).toMatch(/source/);
    expect(buildEvidenceRows(src([{ id: "c", kind: "photo", ...base }]), ctx()).quarantine[0]!.reason).toMatch(/no photoUrl/);
    expect(buildEvidenceRows(src([{ id: "d", kind: "note", note: "  ", ...base }]), ctx()).quarantine[0]!.reason).toMatch(/no note text/);
    const dup = buildEvidenceRows(src([note({ id: "x" }), note({ id: "x" })]), ctx());
    expect(dup.evidenceRows).toHaveLength(1);
    expect(dup.quarantine[0]!.reason).toMatch(/duplicate/);
  });

  it("keeps the evidence insert/mutable column lists in lock-step; binaries never stored", () => {
    const { evidenceRows } = buildEvidenceRows(src([note({ id: "ev1" })]), ctx());
    expect(new Set(EVIDENCE_INSERT_COLS)).toEqual(new Set(Object.keys(evidenceRows[0]!)));
    expect(EVIDENCE_MUTABLE_COLS).not.toContain("legacy_id");
    expect(EVIDENCE_MUTABLE_COLS).not.toContain("created_at");
    expect(EVIDENCE_MUTABLE_COLS).toContain("status"); // review state can change on re-import
    // metadata only — no binary/byte column anywhere
    for (const c of EVIDENCE_INSERT_COLS) expect(c).not.toMatch(/bytes|binary|data_base64/);
  });
});
