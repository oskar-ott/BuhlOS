import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Structure sync-check engine (J1 trust layer): does Blob still equal Postgres
 * for jobs + site_area_groups + site_areas? Pure report — per-section business-key
 * matching, per-side sha256 dataset hash, PASS/FAIL + drift buckets
 * (only_in_blob / only_in_pg / mismatched / unmappable). Modelled on
 * api/_lib/hours-sync-report.js.
 */

type SectionDetail = {
  blobCount: number; pgCount: number; matched: number;
  onlyInBlobCount: number; onlyInPgCount: number; mismatchedCount: number;
  blobHash: string; pgHash: string; hashMatch: boolean;
  onlyInBlob: string[]; onlyInPg: string[];
  mismatched: Array<{ key: string; blob: Record<string, unknown>; pg: Record<string, unknown> }>;
};

const requireFromHere = createRequire(import.meta.url);
const p = requireFromHere.resolve("../../../api/_lib/structure-sync-report.js");
const { buildStructureSyncReport } = requireFromHere(p) as {
  buildStructureSyncReport: (input: { blob: Record<string, unknown>; pg: Record<string, unknown> }) => {
    status: string;
    blobCount: number; pgCount: number; blobDeleted: number; pgDeleted: number;
    matched: number; onlyInBlobCount: number; onlyInPgCount: number;
    mismatchedCount: number; unmappableCount: number;
    blobHash: string; pgHash: string;
    details: { hashMatch: boolean; sections: Record<string, SectionDetail>; unmappable: string[] };
  };
};

const job = (key: string, over: Record<string, unknown> = {}) => ({ key, name: `Job ${key}`, status: "active", deleted: false, ...over });
const group = (key: string, over: Record<string, unknown> = {}) => ({ key, job_legacy_id: "j1", name: "G", sort_order: 0, deleted: false, ...over });
const area = (key: string, over: Record<string, unknown> = {}) => ({ key, job_legacy_id: "j1", group_legacy_id: '["j1","g1"]', name: "A", space_type: null, sort_order: 0, deleted: false, ...over });

function side(jobs: unknown[], groups: unknown[], areas: unknown[], unmappable: string[] = []) {
  return { jobs, groups, areas, unmappable };
}

describe("buildStructureSyncReport", () => {
  it("PASS when blob and pg are identical (hashes match, every section clean)", () => {
    const blob = side([job("j1")], [group('["j1","g1"]')], [area('["j1","a1"]')]);
    const pg = side([job("j1")], [group('["j1","g1"]')], [area('["j1","a1"]')]);
    const r = buildStructureSyncReport({ blob, pg });
    expect(r.status).toBe("pass");
    expect(r.blobCount).toBe(3);
    expect(r.pgCount).toBe(3);
    expect(r.matched).toBe(3);
    expect(r.onlyInBlobCount + r.onlyInPgCount + r.mismatchedCount + r.unmappableCount).toBe(0);
    expect(r.details.hashMatch).toBe(true);
    expect(r.blobHash).toBe(r.pgHash);
  });

  it("PASS is order-independent (dataset hash sorts)", () => {
    const blob = side([job("j1"), job("j2")], [], []);
    const pg = side([job("j2"), job("j1")], [], []);
    const r = buildStructureSyncReport({ blob, pg });
    expect(r.status).toBe("pass");
    expect(r.blobHash).toBe(r.pgHash);
  });

  it("FAIL on only_in_blob (a row never imported)", () => {
    const blob = side([job("j1"), job("j2")], [], []);
    const pg = side([job("j1")], [], []);
    const r = buildStructureSyncReport({ blob, pg });
    expect(r.status).toBe("fail");
    expect(r.onlyInBlobCount).toBe(1);
    expect(r.details.sections.jobs!.onlyInBlob).toContain("j2");
    expect(r.details.hashMatch).toBe(false);
  });

  it("FAIL on only_in_pg (an orphan PG row)", () => {
    const blob = side([job("j1")], [], []);
    const pg = side([job("j1"), job("ghost")], [], []);
    const r = buildStructureSyncReport({ blob, pg });
    expect(r.status).toBe("fail");
    expect(r.onlyInPgCount).toBe(1);
    expect(r.details.sections.jobs!.onlyInPg).toContain("ghost");
  });

  it("FAIL on mismatched (same key, different field) and reports both sides", () => {
    const blob = side([], [], [area('["j1","a1"]', { name: "Kitchen" })]);
    const pg = side([], [], [area('["j1","a1"]', { name: "Kitchenette" })]);
    const r = buildStructureSyncReport({ blob, pg });
    expect(r.status).toBe("fail");
    expect(r.mismatchedCount).toBe(1);
    const m = r.details.sections.areas!.mismatched[0]!;
    expect(m.key).toBe('["j1","a1"]');
    expect(m.blob.name).toBe("Kitchen");
    expect(m.pg.name).toBe("Kitchenette");
  });

  it("a differing archive STATE is a mismatch (deleted flag is compared)", () => {
    const blob = side([], [group('["j1","g1"]', { deleted: true })], []);
    const pg = side([], [group('["j1","g1"]', { deleted: false })], []);
    const r = buildStructureSyncReport({ blob, pg });
    expect(r.status).toBe("fail");
    expect(r.mismatchedCount).toBe(1);
  });

  it("FAIL on unmappable blob entities (status fails even with no key drift)", () => {
    const blob = side([job("j1")], [], [], ['site_areas:["j1","bad"] (collision)']);
    const pg = side([job("j1")], [], []);
    const r = buildStructureSyncReport({ blob, pg });
    expect(r.status).toBe("fail");
    expect(r.unmappableCount).toBe(1);
    expect(r.details.unmappable[0]).toContain("collision");
  });

  it("counts deleted/archived on each side", () => {
    const blob = side([], [group('["j1","g1"]', { deleted: true })], [area('["j1","a1"]', { deleted: true })]);
    const pg = side([], [group('["j1","g1"]', { deleted: true })], [area('["j1","a1"]', { deleted: true })]);
    const r = buildStructureSyncReport({ blob, pg });
    expect(r.status).toBe("pass");
    expect(r.blobDeleted).toBe(2);
    expect(r.pgDeleted).toBe(2);
  });
});

const tpl = (key: string, over: Record<string, unknown> = {}) => ({
  key, job_legacy_id: "j1", site_area_legacy_id: null, stage: "roughIn",
  legacy_id: "t1", name: "T", sort_order: 0, deleted: false, ...over,
});
function sideT(templates: unknown[]) {
  return { jobs: [], groups: [], areas: [], templates, unmappable: [] };
}

describe("buildStructureSyncReport — templates section (J2)", () => {
  it("PASS when templates match; templates count into totals + hash", () => {
    const k = '["j1",null,"roughIn","t1"]';
    const r = buildStructureSyncReport({ blob: sideT([tpl(k)]), pg: sideT([tpl(k)]) });
    expect(r.status).toBe("pass");
    expect(r.blobCount).toBe(1);
    expect(r.details.sections.templates!.matched).toBe(1);
    expect(r.blobHash).toBe(r.pgHash);
  });

  it("FAIL only_in_blob (a template never imported)", () => {
    const r = buildStructureSyncReport({ blob: sideT([tpl("k1"), tpl("k2")]), pg: sideT([tpl("k1")]) });
    expect(r.status).toBe("fail");
    expect(r.details.sections.templates!.onlyInBlob).toContain("k2");
  });

  it("FAIL mismatched when a written field (name) diverges", () => {
    const r = buildStructureSyncReport({ blob: sideT([tpl("k1", { name: "Rough" })]), pg: sideT([tpl("k1", { name: "Rough-in" })]) });
    expect(r.status).toBe("fail");
    expect(r.details.sections.templates!.mismatchedCount).toBe(1);
  });

  it("a differing archive STATE on a template is a mismatch", () => {
    const r = buildStructureSyncReport({ blob: sideT([tpl("k1", { deleted: true })]), pg: sideT([tpl("k1", { deleted: false })]) });
    expect(r.status).toBe("fail");
    expect(r.details.sections.templates!.mismatchedCount).toBe(1);
  });
});
