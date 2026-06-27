import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Evidence-mirror cron route (api/internal/mirror-evidence.js). Machine-only
 * (CRON_SECRET), gates cleanly (skip → 200), best-effort (mirror never throws).
 * Mirrors the J9 mirror-tasks cron route.
 */
const requireFromHere = createRequire(import.meta.url);
const handle = requireFromHere(requireFromHere.resolve("../../../api/internal/mirror-evidence.js")) as
  (req: unknown, res: ReturnType<typeof createRes>, deps?: Record<string, unknown>) => Promise<unknown>;

function createRes() {
  return {
    statusCode: 200, body: null as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader() { return this; }, end() { return this; },
  };
}
const req = (method = "GET") => ({ method, headers: {}, query: {} });

describe("handleMirrorEvidence — cron route", () => {
  it("denied auth → 401", async () => {
    const res = createRes();
    await handle(req(), res, { cronState: () => "denied", env: { CRON_SECRET: "x" }, run: async () => ({ ran: true }) });
    expect(res.statusCode).toBe(401);
  });

  it("CRON_SECRET unconfigured → 503", async () => {
    const res = createRes();
    await handle(req(), res, { cronState: () => "unconfigured", env: {}, run: async () => ({ ran: true }) });
    expect(res.statusCode).toBe(503);
  });

  it("gated skip (ran:false) → 200 skipped", async () => {
    const res = createRes();
    await handle(req(), res, { cronState: () => "ok", env: { CRON_SECRET: "x" }, run: async () => ({ ran: false, reason: "flag off" }) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, skipped: true, reason: "flag off" });
  });

  it("success → 200 with the mirror summary", async () => {
    const res = createRes();
    await handle(req(), res, { cronState: () => "ok", env: { CRON_SECRET: "x" }, run: async () => ({ ran: true, evidenceInserted: 4, evidenceUpdated: 0, linksInserted: 1 }) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ran: true, evidenceInserted: 4, linksInserted: 1 });
  });

  it("best-effort error → 500", async () => {
    const res = createRes();
    await handle(req(), res, { cronState: () => "ok", env: { CRON_SECRET: "x" }, run: async () => ({ ran: false, reason: "error", error: "boom" }) });
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ ok: false, error: "boom" });
  });

  it("non-GET/POST → 405", async () => {
    const res = createRes();
    await handle(req("DELETE"), res, { cronState: () => "ok", env: { CRON_SECRET: "x" }, run: async () => ({ ran: true }) });
    expect(res.statusCode).toBe(405);
  });
});
