import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Evidence-metadata read-cutover READINESS probe (diagnostics-only). Normalised
 * parity of Blob data.json.evidence[] vs the reconstructed PG evidence_files
 * mirror across a bounded sample. Read-only, best-effort, never throws, no flag,
 * no serving. Compares only migrated identity/classification/state fields —
 * never bytes, URLs, note bodies, labels or timestamps. Output is counts only.
 */
const requireFromHere = createRequire(import.meta.url);
const { probeEvidenceReadParity, compareEvidence, readAdminEvidence, readPhilEvidence } = requireFromHere(
  requireFromHere.resolve("../../../api/_lib/evidence-read.js"),
) as {
  probeEvidenceReadParity: (input: Record<string, unknown>) => Promise<Probe>;
  compareEvidence: (b: EvItem[], p: EvItem[]) => { matched: number; mismatched: number; missingInPg: number; missingInBlob: number };
  readAdminEvidence: (input: Record<string, unknown>) => Promise<{ data: OverlayData; diag: OverlayDiag }>;
  readPhilEvidence: (input: Record<string, unknown>) => Promise<{ data: OverlayData; diag: OverlayDiag }>;
};
type OverlayDiag = { source: "blob" | "postgres"; reason: string; parityPass: boolean | null; matched: number; mismatched: number; missingInPg: number; missingInBlob: number; fallbackUsed: boolean; error?: string | null };
type OverlayData = { dwellings: unknown; snags: unknown[]; notes: unknown[]; evidence: EvItem[] };

type Probe = {
  available: boolean; jobsTotal: number; jobsSampled: number;
  faithful: number; drifted: number; unavailable: number;
  matchedEvidence: number; mismatchedEvidence: number; missingInPg: number; missingInBlob: number;
  readyForOverlay: boolean; latencyMs: number; fallbackReason: string | null; error?: string;
};
type EvItem = Record<string, unknown> & { id: string };

// Same key shape on both sides (reconstructFromPg maps PG → the Blob shape).
// note / photoUrl / capturedAt are present but EXCLUDED from parity by design.
function ev(id: string, over: Partial<EvItem> = {}): EvItem {
  return {
    id, kind: "photo", areaId: "a1", stage: "roughIn", taskId: null,
    status: "submitted", source: "phil",
    note: "a benign note", photoUrl: "https://blob.example/x.jpg", capturedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const tenantSql = () => (first: unknown) => {
  if (!Array.isArray(first)) return first;
  const q = (first as string[]).join(" ");
  if (q.includes("from public.tenants")) return Promise.resolve([{ id: "T" }]);
  return Promise.resolve([]);
};
function readBlobFor(jobIds: string[], evByJob: Record<string, EvItem[]>) {
  return async (key: string, fallback?: unknown) => {
    if (key === "jobs.json") return { jobs: jobIds.map((id) => ({ id })) };
    const m = /^jobs\/(.+)\/data\.json$/.exec(key);
    if (m && m[1]) return { dwellings: {}, snags: [], notes: [], evidence: evByJob[m[1]] ?? [] };
    return fallback;
  };
}
// Injected reconstruction (stands in for loadJobStructureFromPg) — the proven
// inverse projection is exercised separately; here we control PG evidence directly.
function loadStructureFor(jobIds: string[], evByJob: Record<string, EvItem[]>) {
  return async () => ({
    jobs: { jobs: jobIds.map((id) => ({ id })) },
    jobData: Object.fromEntries(jobIds.map((id) => [id, { evidence: evByJob[id] ?? [] }])),
  });
}

const OLD = process.env.SUPABASE_DB_URL;
afterEach(() => { if (OLD === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = OLD; });

describe("probeEvidenceReadParity (evidence readiness)", () => {
  it("no SUPABASE env → not available, nothing sampled", async () => {
    delete process.env.SUPABASE_DB_URL;
    const r = await probeEvidenceReadParity({
      getDb: () => { throw new Error("must not connect"); },
      loadStructure: () => { throw new Error("must not load"); },
      readBlob: readBlobFor(["j1"], { j1: [ev("e1")] }),
    });
    expect(r.available).toBe(false);
    expect(r.jobsSampled).toBe(0);
    expect(r.fallbackReason).toBe("no supabase env");
  });

  it("evidence-faithful job (PG == Blob on migrated fields) → faithful, ready", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const blob = { j1: [ev("e1"), ev("e2", { kind: "note", note: "blob body" })] };
    // PG side: identical migrated fields, but DIFFERENT note/url/timestamp → still faithful.
    const pg = { j1: [ev("e1", { photoUrl: "https://pg/diff.jpg", capturedAt: "2099-12-31T00:00:00Z" }), ev("e2", { kind: "note", note: "pg body" })] };
    const r = await probeEvidenceReadParity({
      getDb: tenantSql, loadStructure: loadStructureFor(["j1"], pg), readBlob: readBlobFor(["j1"], blob),
    });
    expect(r.available).toBe(true);
    expect(r.jobsTotal).toBe(1);
    expect(r.jobsSampled).toBe(1);
    expect(r.faithful).toBe(1);
    expect(r.drifted).toBe(0);
    expect(r.matchedEvidence).toBe(2);
    expect(r.mismatchedEvidence).toBe(0);
    expect(r.readyForOverlay).toBe(true);
  });

  it("migrated-field drift (status differs) → drifted, mismatch counted, not ready", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await probeEvidenceReadParity({
      getDb: tenantSql,
      loadStructure: loadStructureFor(["j1"], { j1: [ev("e1", { status: "rejected" })] }),
      readBlob: readBlobFor(["j1"], { j1: [ev("e1", { status: "submitted" })] }),
    });
    expect(r.drifted).toBe(1);
    expect(r.faithful).toBe(0);
    expect(r.mismatchedEvidence).toBe(1);
    expect(r.readyForOverlay).toBe(false);
  });

  it("evidence missing in PG (Blob has it) → drifted, missingInPg", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await probeEvidenceReadParity({
      getDb: tenantSql,
      loadStructure: loadStructureFor(["j1"], { j1: [] }),
      readBlob: readBlobFor(["j1"], { j1: [ev("e1")] }),
    });
    expect(r.drifted).toBe(1);
    expect(r.missingInPg).toBe(1);
    expect(r.readyForOverlay).toBe(false);
  });

  it("orphan evidence in PG (missing in Blob) → drifted, missingInBlob", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await probeEvidenceReadParity({
      getDb: tenantSql,
      loadStructure: loadStructureFor(["j1"], { j1: [ev("e1"), ev("ghost")] }),
      readBlob: readBlobFor(["j1"], { j1: [ev("e1")] }),
    });
    expect(r.drifted).toBe(1);
    expect(r.missingInBlob).toBe(1);
    expect(r.matchedEvidence).toBe(1);
  });

  it("job not in the PG reconstruction → unavailable (not a drift)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await probeEvidenceReadParity({
      getDb: tenantSql,
      loadStructure: loadStructureFor([], {}), // PG has no jobs
      readBlob: readBlobFor(["j1"], { j1: [ev("e1")] }),
    });
    expect(r.unavailable).toBe(1);
    expect(r.drifted).toBe(0);
    expect(r.faithful).toBe(0);
    expect(r.readyForOverlay).toBe(false);
  });

  it("best-effort: PG reconstruction throws → error fallback, never throws", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await probeEvidenceReadParity({
      getDb: tenantSql,
      loadStructure: () => { throw new Error("pooler down"); },
      readBlob: readBlobFor(["j1"], { j1: [ev("e1")] }),
    });
    expect(r.available).toBe(true);
    expect(r.fallbackReason).toBe("error");
    expect(r.error).toBe("pooler down");
    expect(r.jobsSampled).toBe(0);
  });

  it("bounds the sample and reports truncation (no silent cap)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const ids = ["j1", "j2", "j3"];
    const r = await probeEvidenceReadParity({
      sampleLimit: 1, getDb: tenantSql,
      loadStructure: loadStructureFor(ids, { j1: [ev("e1")] }),
      readBlob: readBlobFor(ids, { j1: [ev("e1")] }),
    });
    expect(r.jobsTotal).toBe(3);
    expect(r.jobsSampled).toBe(1);
  });

  it("never leaks raw evidence payload — output is counts/booleans/short strings only", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const secretNote = "PRIVATE-NOTE-do-not-leak";
    const secretUrl = "https://blob.example/secret-signed-url";
    const r = await probeEvidenceReadParity({
      getDb: tenantSql,
      loadStructure: loadStructureFor(["j1"], { j1: [ev("e1", { note: secretNote, photoUrl: secretUrl })] }),
      readBlob: readBlobFor(["j1"], { j1: [ev("e1", { note: secretNote, photoUrl: secretUrl })] }),
    });
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(secretNote);
    expect(serialized).not.toContain(secretUrl);
    expect(serialized).not.toContain("e1"); // no evidence ids in the output
    for (const v of Object.values(r)) {
      expect(["number", "boolean"].includes(typeof v) || v === null || typeof v === "string").toBe(true);
    }
  });
});

describe("compareEvidence (normalised parity)", () => {
  it("ignores note body, photo URL and timestamps; compares migrated fields only", () => {
    const blob = [ev("e1", { note: "blob", photoUrl: "https://b/1", capturedAt: "2026-01-01T00:00:00Z" })];
    const pg = [ev("e1", { note: "pg", photoUrl: "https://p/9", capturedAt: "2099-01-01T00:00:00Z" })];
    expect(compareEvidence(blob, pg)).toEqual({ matched: 1, mismatched: 0, missingInPg: 0, missingInBlob: 0 });
  });

  it("flags a real migrated-field difference (taskId)", () => {
    expect(compareEvidence([ev("e1", { taskId: "t1" })], [ev("e1", { taskId: "t2" })]))
      .toEqual({ matched: 0, mismatched: 1, missingInPg: 0, missingInBlob: 0 });
  });

  it("treats undefined vs null / empty-string as equal (norm)", () => {
    expect(compareEvidence([ev("e1", { taskId: undefined })], [ev("e1", { taskId: null })]))
      .toEqual({ matched: 1, mismatched: 0, missingInPg: 0, missingInBlob: 0 });
  });
});

describe("readAdminEvidence (dark admin evidence overlay)", () => {
  // Raw PG evidence row shape (what reconstructFromPg consumes).
  const pgRow = (over: Record<string, unknown> = {}) => ({
    legacy_id: "e1", job_legacy: "j1", area_legacy: null, task_legacy_template_id: null,
    kind: "photo", blob_url: "https://pg.example/x.jpg", note: "PG-NOTE", stage: "roughIn",
    status: "submitted", source: "phil", ...over,
  });
  // Blob data with one evidence item (same migrated fields; different note/url).
  const blobData = (evOver: Partial<EvItem> = {}) => ({
    dwellings: {}, snags: [], notes: [],
    evidence: [{ id: "e1", kind: "photo", areaId: null, stage: "roughIn", taskId: null, status: "submitted", source: "phil", note: "BLOB-NOTE", photoUrl: "https://blob.example/x.jpg", ...evOver }],
  });
  function evSql(evRows: Array<Record<string, unknown>>) {
    return () => (first: unknown) => {
      if (!Array.isArray(first)) return first;
      const q = (first as string[]).join(" ");
      if (q.includes("from public.tenants")) return Promise.resolve([{ id: "T" }]);
      if (q.includes("select id from public.jobs")) return Promise.resolve([{ id: "job-uuid" }]);
      if (q.includes("from public.evidence_files")) return Promise.resolve(evRows);
      return Promise.resolve([]);
    };
  }
  const throwDb = () => { throw new Error("getDb must not be called"); };

  it("flag off → Blob, db untouched", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await readAdminEvidence({ jobId: "j1", data: blobData(), getDb: throwDb, isFlagOn: async () => false });
    expect(r.diag.source).toBe("blob");
    expect(r.diag.reason).toBe("flag off");
  });

  it("no SUPABASE env → Blob, db/flag untouched", async () => {
    delete process.env.SUPABASE_DB_URL;
    const r = await readAdminEvidence({ jobId: "j1", data: blobData(), getDb: throwDb, isFlagOn: async () => { throw new Error("flag must not be read"); } });
    expect(r.diag.source).toBe("blob");
    expect(r.diag.reason).toBe("no supabase env");
  });

  it("parity PASS → served from Postgres; excluded fields stay Blob (output == Blob)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await readAdminEvidence({ jobId: "j1", data: blobData(), isFlagOn: async () => true, getDb: evSql([pgRow()]) });
    expect(r.diag.source).toBe("postgres");
    expect(r.diag.parityPass).toBe(true);
    expect(r.diag.matched).toBe(1);
    // migrated field served from PG (== Blob); EXCLUDED fields remain Blob (not PG).
    expect(r.data.evidence[0]!.status).toBe("submitted");
    expect(r.data.evidence[0]!.note).toBe("BLOB-NOTE");
    expect(r.data.evidence[0]!.photoUrl).toBe("https://blob.example/x.jpg");
  });

  it("parity FAIL (status drift) → Blob fallback, never serves PG", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await readAdminEvidence({ jobId: "j1", data: blobData(), isFlagOn: async () => true, getDb: evSql([pgRow({ status: "rejected" })]) });
    expect(r.diag.source).toBe("blob");
    expect(r.diag.parityPass).toBe(false);
    expect(r.diag.mismatched).toBe(1);
    expect(r.diag.fallbackUsed).toBe(true);
    expect(r.data.evidence[0]!.status).toBe("submitted"); // unchanged Blob
  });

  it("best-effort: PG error → Blob fallback, never throws", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await readAdminEvidence({ jobId: "j1", data: blobData(), isFlagOn: async () => true, getDb: () => { throw new Error("pooler down"); } });
    expect(r.diag.source).toBe("blob");
    expect(r.diag.reason).toBe("error");
    expect(r.diag.fallbackUsed).toBe(true);
  });

  it("wrapper pins the admin flag — caller cannot spoof the audience", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const seen: string[] = [];
    const r = await readAdminEvidence({
      jobId: "j1", data: blobData(),
      flagKey: "supabase_read_phil_tasks", // attempt to spoof — must be ignored
      isFlagOn: async (k: string) => { seen.push(k); return false; },
      getDb: throwDb,
    });
    expect(seen).toEqual(["supabase_read_admin_evidence"]); // pinned, not the spoofed key
    expect(r.diag.source).toBe("blob");
  });

  it("diag leaks no evidence payload — counts/booleans/short strings only", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await readAdminEvidence({ jobId: "j1", data: blobData(), isFlagOn: async () => true, getDb: evSql([pgRow({ note: "SECRET", blob_url: "https://secret/url" })]) });
    const d = JSON.stringify(r.diag);
    expect(d).not.toContain("SECRET");
    expect(d).not.toContain("https://");
    expect(d).not.toContain("e1");
  });

  it("wrapper pins the phil flag — caller cannot spoof the audience", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const seen: string[] = [];
    const r = await readPhilEvidence({
      jobId: "j1", data: blobData(),
      flagKey: "supabase_read_admin_evidence", // attempt to spoof — must be ignored
      isFlagOn: async (k: string) => { seen.push(k); return false; },
      getDb: throwDb,
    });
    expect(seen).toEqual(["supabase_read_phil_evidence"]); // pinned, not the spoofed key
    expect(r.diag.source).toBe("blob");
    expect(r.diag.reason).toBe("flag off");
  });

  it("readPhilEvidence reuses the same engine — parity PASS serves PG, FAIL → Blob", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const pass = await readPhilEvidence({ jobId: "j1", data: blobData(), isFlagOn: async () => true, getDb: evSql([pgRow()]) });
    expect(pass.diag.source).toBe("postgres");
    expect(pass.diag.parityPass).toBe(true);
    const fail = await readPhilEvidence({ jobId: "j1", data: blobData(), isFlagOn: async () => true, getDb: evSql([pgRow({ status: "rejected" })]) });
    expect(fail.diag.source).toBe("blob");
    expect(fail.diag.fallbackUsed).toBe(true);
  });
});
