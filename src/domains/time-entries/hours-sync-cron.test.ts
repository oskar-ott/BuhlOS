import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/**
 * Scheduled hours drift-check (#152 trust layer): the cron route
 * (api/internal/sync-checks/hours.js) and the shared orchestrator
 * (api/_lib/hours-sync.runHoursSyncCheck).
 *
 * Covers the AC the cron must guarantee: auth failure is refused (no open path,
 * not even on preview), a successful invocation records + reports PASS, and a
 * drift is RECORDED and surfaced as a red (500) run. All I/O is injected — no
 * real Blob, Postgres or process.env mutation.
 */

const requireFromHere = createRequire(import.meta.url);

const routePath = requireFromHere.resolve("../../../api/internal/sync-checks/hours.js");
const { handleHoursSyncCheck } = requireFromHere(routePath) as {
  handleHoursSyncCheck: (req: unknown, res: unknown, deps?: Record<string, unknown>) => Promise<unknown>;
};

const corePath = requireFromHere.resolve("../../../api/_lib/hours-sync.js");
const { runHoursSyncCheck } = requireFromHere(corePath) as {
  runHoursSyncCheck: (sql: unknown, options?: { record?: boolean; deps?: Record<string, unknown> }) => Promise<Record<string, unknown>>;
};

type Res = {
  statusCode: number;
  body: unknown;
  ended: boolean;
  status: (c: number) => Res;
  json: (b: unknown) => Res;
  end: () => Res;
  setHeader: () => Res;
};
function mkRes(): Res {
  const res = {} as Res;
  res.statusCode = 0;
  res.body = undefined;
  res.ended = false;
  res.status = (c) => ((res.statusCode = c), res);
  res.json = (b) => ((res.body = b), res);
  res.end = () => ((res.ended = true), res);
  res.setHeader = () => res;
  return res;
}
const req = (method = "GET") => ({ method, headers: {} });

const PASS = { status: "pass", blobCount: 9, pgCount: 9, blobTotal: 70.8, pgTotal: 70.8, matched: 9, onlyInBlobCount: 0, onlyInPgCount: 0, mismatchedCount: 0, blobHash: "h", pgHash: "h", recorded: true, durationMs: 12, details: { hashMatch: true } };
const FAIL = { ...PASS, status: "fail", pgCount: 8, matched: 8, onlyInBlobCount: 1, blobHash: "a", pgHash: "b", details: { hashMatch: false } };

// Deps for the happy path — overridden per test.
function okDeps(over: Record<string, unknown> = {}) {
  return {
    env: { CRON_SECRET: "s3cret", SUPABASE_DB_URL: "postgres://fake" },
    cronState: () => "ok",
    flagOn: async () => true,
    db: () => ({}),
    run: async () => PASS,
    ...over,
  };
}

describe("route: auth — no open path", () => {
  it("denied → 401, work never starts", async () => {
    const run = vi.fn();
    const res = mkRes();
    await handleHoursSyncCheck(req(), res, okDeps({ cronState: () => "denied", run }));
    expect(res.statusCode).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it("unconfigured (prod, no secret) → 503", async () => {
    const res = mkRes();
    await handleHoursSyncCheck(req(), res, okDeps({ cronState: () => "unconfigured" }));
    expect(res.statusCode).toBe(503);
  });

  it("preview-permissive (cronState ok but no CRON_SECRET) is STILL refused → 503", async () => {
    const run = vi.fn();
    const res = mkRes();
    await handleHoursSyncCheck(req(), res, okDeps({ cronState: () => "ok", env: { SUPABASE_DB_URL: "postgres://fake" }, run }));
    expect(res.statusCode).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects non-GET/POST methods → 405", async () => {
    const res = mkRes();
    await handleHoursSyncCheck(req("DELETE"), res, okDeps());
    expect(res.statusCode).toBe(405);
  });
});

describe("route: gating — skip cleanly, stay green", () => {
  it("no SUPABASE_DB_URL → 200 skipped, no db/run touch", async () => {
    const run = vi.fn();
    const db = vi.fn();
    const res = mkRes();
    await handleHoursSyncCheck(req(), res, okDeps({ env: { CRON_SECRET: "s3cret" }, run, db }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, skipped: true, reason: "supabase not configured" });
    expect(db).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("dual-write flag off → 200 skipped, no db/run touch", async () => {
    const run = vi.fn();
    const db = vi.fn();
    const res = mkRes();
    await handleHoursSyncCheck(req(), res, okDeps({ flagOn: async () => false, run, db }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, skipped: true, reason: "dual-write disabled" });
    expect(db).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});

describe("route: outcomes", () => {
  it("successful invocation (pass) → 200, recorded, status pass", async () => {
    const res = mkRes();
    await handleHoursSyncCheck(req(), res, okDeps({ run: async () => PASS }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, recorded: true, status: "pass", mismatched: 0, hashMatch: true });
  });

  it("drift recorded → 500 (red run) with recorded:true and status fail", async () => {
    const res = mkRes();
    await handleHoursSyncCheck(req(), res, okDeps({ run: async () => FAIL }));
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ ok: false, recorded: true, status: "fail", onlyInBlob: 1, hashMatch: false });
    expect((res.body as { note?: string }).note).toContain("/sync-status");
  });

  it("a run error → 500 with error, nothing claimed recorded", async () => {
    const res = mkRes();
    await handleHoursSyncCheck(req(), res, okDeps({ run: async () => { throw new Error("pooler down"); } }));
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: "pooler down" });
    expect((res.body as { recorded?: boolean }).recorded).toBeUndefined();
  });
});

describe("orchestrator: runHoursSyncCheck — recording", () => {
  // Fake tagged-template sql that only answers the tenant lookup (record + loads
  // are injected, so the real sql is never used for them).
  const sqlTenant = (rows: Array<{ id: string }>) => () => Promise.resolve(rows);
  let clock = 1000;
  const now = () => (clock += 100);
  const coreDeps = (over: Record<string, unknown> = {}) => ({
    loadBlob: async () => [],
    loadPg: async () => [],
    buildReport: () => ({ status: "pass", blobCount: 0, pgCount: 0 }),
    normalise: (_u: string, _d: string, e: unknown) => e,
    now,
    ...over,
  });

  it("resolves tenant, builds, and records when record:true", async () => {
    const recordCheck = vi.fn((_sql: unknown, _tenantId: string, _report: unknown, _ms: number) => Promise.resolve());
    const report = await runHoursSyncCheck(sqlTenant([{ id: "t1" }]), {
      record: true,
      deps: coreDeps({ recordCheck }),
    });
    expect(recordCheck).toHaveBeenCalledOnce();
    expect(recordCheck.mock.calls[0]?.[1]).toBe("t1"); // tenantId threaded through
    expect(report.recorded).toBe(true);
    expect(typeof report.durationMs).toBe("number");
  });

  it("does NOT record when record:false (dry-run)", async () => {
    const recordCheck = vi.fn(async () => undefined);
    const report = await runHoursSyncCheck(sqlTenant([{ id: "t1" }]), {
      record: false,
      deps: coreDeps({ recordCheck }),
    });
    expect(recordCheck).not.toHaveBeenCalled();
    expect(report.recorded).toBeUndefined();
  });

  it("records a FAIL report too — failure recording is the whole point", async () => {
    const recordCheck = vi.fn(async () => undefined);
    const report = await runHoursSyncCheck(sqlTenant([{ id: "t1" }]), {
      record: true,
      deps: coreDeps({ recordCheck, buildReport: () => ({ status: "fail", onlyInBlobCount: 1 }) }),
    });
    expect(recordCheck).toHaveBeenCalledOnce();
    expect(report.status).toBe("fail");
    expect(report.recorded).toBe(true);
  });

  it("throws a clear error when the tenant is missing", async () => {
    await expect(
      runHoursSyncCheck(sqlTenant([]), { record: true, deps: coreDeps() })
    ).rejects.toThrow(/tenant/);
  });
});
