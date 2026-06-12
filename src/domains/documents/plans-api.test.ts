import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #194 — drawings register hardening against the REAL api/plans.js:
 *   (a) make-current maintains supersedes/supersededBy both ways
 *   (b) editing a drawingNumber onto an existing current number can't
 *       leave two currents
 *   (c) POST with an explicit `supersedes` while a same-number current
 *       exists can't either
 * plus the closed discipline set (PATCH 400s junk; POST coerces junk to
 * '' so legacy callers can't break) and the new audit verbs landing in
 * the job history store.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const handlerPath = requireFromHere.resolve("../../../api/plans.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader() {
      return this;
    },
    end() {
      return this;
    },
  };
}

async function call(
  method: string,
  query: Record<string, string>,
  body?: unknown,
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method,
      query,
      body,
      headers: {
        cookie: `buhl_session=${auth.signSession({ userId: "u_admin", role: "office", exp: Date.now() + 60_000 })}`,
      },
    },
    res,
  );
  return res;
}

function plan(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    jobId: "j1",
    fileName: `${id}.pdf`,
    status: "current",
    drawingNumber: "",
    supersedes: "",
    supersededBy: "",
    ...extra,
  };
}

const PNG_DATA_URL = "data:application/pdf;base64,JVBERi0=";

function plansInStore(): Array<Record<string, unknown>> {
  return (blob.get("jobs/j1/plans-index.json") as { plans: Array<Record<string, unknown>> }).plans;
}

function auditActions(): string[] {
  const out: string[] = [];
  for (const [key, value] of blob.entries()) {
    if (!key.startsWith("audit/")) continue;
    for (const e of ((value as { entries?: Array<{ action: string }> }).entries ?? [])) {
      out.push(e.action);
    }
  }
  return out;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [{ id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" }],
  });
  blob.set("jobs.json", { jobs: [{ id: "j1", name: "Riverside" }] });
  blob.set("jobs/j1/plans-index.json", {
    plans: [
      plan("pl_a", { drawingNumber: "E-101", title: "Power L1 rev A" }),
      plan("pl_b", { drawingNumber: "E-102", title: "Lighting L1" }),
      plan("pl_old", { drawingNumber: "E-101", status: "superseded", supersededBy: "pl_a", title: "Power L1 prelim" }),
    ],
  });

  for (const p of [authPath, handlerPath, auditPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: {
      list: vi.fn(async () => ({ blobs: [] })),
      put: vi.fn(async (path: string) => ({ url: `memory://${path}` })),
    },
  } as NodeJS.Module;

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("plans hardening (#194)", () => {
  it("(a) make-current re-points lineage both ways", async () => {
    const res = await call("PATCH", { jobId: "j1", id: "pl_old" }, { status: "current" });
    expect(res.statusCode).toBe(200);
    const plans = plansInStore();
    const old = plans.find((p) => p.id === "pl_old")!;
    const a = plans.find((p) => p.id === "pl_a")!;
    expect(old.status).toBe("current");
    expect(old.supersededBy).toBe(""); // nothing supersedes it any more
    expect(a.status).toBe("superseded");
    expect(a.supersededBy).toBe("pl_old"); // pointer maintained, not just status
    // exactly one current on E-101
    expect(plans.filter((p) => p.drawingNumber === "E-101" && p.status === "current")).toHaveLength(1);
    expect(auditActions()).toContain("document.made_current");
    expect(auditActions()).toContain("document.superseded");
  });

  it("(b) editing a drawingNumber onto an existing current number demotes the other", async () => {
    const res = await call("PATCH", { jobId: "j1", id: "pl_b" }, { drawingNumber: "E-101" });
    expect(res.statusCode).toBe(200);
    const plans = plansInStore();
    expect(plans.filter((p) => p.drawingNumber === "E-101" && p.status === "current")).toHaveLength(1);
    const a = plans.find((p) => p.id === "pl_a")!;
    expect(a.status).toBe("superseded");
    expect(a.supersededBy).toBe("pl_b");
  });

  it("(c) POST with explicit supersedes can't leave two currents on one number", async () => {
    const res = await call(
      "POST",
      { jobId: "j1" },
      {
        dataUrl: PNG_DATA_URL,
        fileName: "rev-b.pdf",
        drawingNumber: "E-101",
        supersedes: "pl_b", // points at a DIFFERENT number's row on purpose
        discipline: "electrical",
      },
    );
    expect(res.statusCode).toBe(201);
    const plans = plansInStore();
    expect(plans.filter((p) => p.drawingNumber === "E-101" && p.status === "current")).toHaveLength(1);
    const uploaded = (res.body as { plan: { id: string; discipline: string } }).plan;
    expect(uploaded.discipline).toBe("electrical");
    const a = plans.find((p) => p.id === "pl_a")!;
    expect(a.status).toBe("superseded");
    expect(a.supersededBy).toBe(uploaded.id);
    expect(auditActions()).toContain("document.uploaded");
  });

  it("discipline: PATCH rejects junk, accepts the closed set, POST coerces junk to ''", async () => {
    const bad = await call("PATCH", { jobId: "j1", id: "pl_a" }, { discipline: "plumbing-ish" });
    expect(bad.statusCode).toBe(400);
    const ok = await call("PATCH", { jobId: "j1", id: "pl_a" }, { discipline: "electrical" });
    expect(ok.statusCode).toBe(200);
    expect((ok.body as { plan: { discipline: string } }).plan.discipline).toBe("electrical");

    const posted = await call(
      "POST",
      { jobId: "j1" },
      { dataUrl: PNG_DATA_URL, fileName: "x.pdf", discipline: "nonsense" },
    );
    expect((posted.body as { plan: { discipline: string } }).plan.discipline).toBe("");
  });
});
