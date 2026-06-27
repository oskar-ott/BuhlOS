import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Evidence-metadata dual-write mirror (api/_lib/evidence-mirror.js). Best-effort,
 * Blob-authoritative, OFF the request path. Triple-gated (env + flag + write
 * guard); reuses the importer's writeEvidence so it can't diverge. Quarantine is
 * reported, not thrown; a generic failure degrades to {ran:false, reason:'error'}.
 */
const requireFromHere = createRequire(import.meta.url);
const { mirrorEvidenceIfEnabled, mirrorEvidence } = requireFromHere(requireFromHere.resolve("../../../api/_lib/evidence-mirror.js")) as {
  mirrorEvidenceIfEnabled: (deps?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  mirrorEvidence: (deps?: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
const { QuarantineError } = requireFromHere(requireFromHere.resolve("../../../scripts/importers/lib/evidence-writer.js")) as {
  QuarantineError: new (q: unknown[]) => Error;
};

const readBlob = async (key: string, fb: unknown) => (key === "jobs.json" ? { jobs: [] } : fb);
const okWrite = async () => ({ evidence: { inserted: 4, updated: 0, unchanged: 0, total: 4 }, links: { inserted: 1, candidates: 1 }, after: { evidence_files: 4, evidence_links: 1 }, tenantId: "t1" });
function baseDeps(over: Record<string, unknown> = {}) {
  return { isFlagOn: async () => true, getDb: () => ({}), readBlob, writeEvidence: okWrite, ...over };
}

const OLD = process.env.SUPABASE_DB_URL;
afterEach(() => { if (OLD === undefined) delete process.env.SUPABASE_DB_URL; else process.env.SUPABASE_DB_URL = OLD; });

describe("mirrorEvidenceIfEnabled — gating", () => {
  it("no SUPABASE env → skipped, db/flag untouched", async () => {
    delete process.env.SUPABASE_DB_URL;
    const getDb = vi.fn();
    const r = await mirrorEvidenceIfEnabled(baseDeps({ getDb }));
    expect(r).toMatchObject({ ran: false, reason: "no supabase env" });
    expect(getDb).not.toHaveBeenCalled();
  });

  it("flag off → skipped, db untouched", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const getDb = vi.fn();
    const r = await mirrorEvidenceIfEnabled(baseDeps({ isFlagOn: async () => false, getDb }));
    expect(r).toMatchObject({ ran: false, reason: "flag off" });
    expect(getDb).not.toHaveBeenCalled();
  });
});

describe("mirrorEvidenceIfEnabled — run", () => {
  it("success → ran with the writer's tally", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await mirrorEvidenceIfEnabled(baseDeps());
    expect(r).toMatchObject({ ran: true, evidenceInserted: 4, evidenceUpdated: 0, linksInserted: 1 });
    expect(typeof r.latencyMs).toBe("number");
  });

  it("quarantine → reported, nothing written, never crashes", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const write = async () => { throw new QuarantineError([{ id: "ev1", reason: "unresolvable area" }]); };
    const r = await mirrorEvidenceIfEnabled(baseDeps({ writeEvidence: write }));
    expect(r).toMatchObject({ ran: true, quarantined: 1, wrote: false });
  });

  it("a generic write failure propagates (the wrapper turns it into reason:error)", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const write = async () => { throw new Error("pooler down"); };
    await expect(mirrorEvidenceIfEnabled(baseDeps({ writeEvidence: write }))).rejects.toThrow(/pooler down/);
  });
});

describe("mirrorEvidence — best-effort wrapper", () => {
  it("never throws — a failure becomes { ran:false, reason:'error' }", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const write = async () => { throw new Error("pooler down"); };
    const r = await mirrorEvidence(baseDeps({ writeEvidence: write }));
    expect(r).toMatchObject({ ran: false, reason: "error" });
    expect(r.error).toContain("pooler down");
  });

  it("passes a clean run through", async () => {
    process.env.SUPABASE_DB_URL = "postgres://fake";
    const r = await mirrorEvidence(baseDeps());
    expect(r).toMatchObject({ ran: true, evidenceInserted: 4 });
  });
});
