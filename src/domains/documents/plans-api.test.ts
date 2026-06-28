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
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const handlerPath = requireFromHere.resolve("../../../api/plans.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let pushCalls: Array<{ userId: string; payload: { title: string; body: string; url: string } }>;

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
  pushCalls = [];
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" },
      // #299 fixtures: assigned field crew (one with push, one without),
      // an assigned client (never pushed/acks) and an unassigned worker.
      {
        id: "u_elec",
        username: "sparky",
        role: "electrician",
        assignedJobIds: ["j1"],
        pushSubscriptions: [{ endpoint: "https://push.example/1", keys: { p256dh: "k", auth: "a" } }],
      },
      { id: "u_tradie", username: "mick", role: "tradie", assignedJobIds: ["j1"] },
      { id: "u_client", username: "client", role: "client", assignedJobIds: ["j1"] },
      { id: "u_out", username: "out", role: "tradie", assignedJobIds: [] },
    ],
  });
  // #196: the job carries a work tree so spec→area link validation has
  // real area ids to resolve against (findArea pattern).
  blob.set("jobs.json", {
    jobs: [
      {
        id: "j1",
        name: "Riverside",
        areaGroups: [
          {
            id: "g1",
            name: "Ground floor",
            areas: [
              { id: "area-kitchen", name: "Kitchen" },
              { id: "area-pantry", name: "Pantry" },
            ],
          },
        ],
      },
    ],
  });
  blob.set("jobs/j1/plans-index.json", {
    plans: [
      plan("pl_a", { drawingNumber: "E-101", title: "Power L1 rev A" }),
      plan("pl_b", { drawingNumber: "E-102", title: "Lighting L1" }),
      plan("pl_old", { drawingNumber: "E-101", status: "superseded", supersededBy: "pl_a", title: "Power L1 prelim" }),
      // #196: a spec row (no drawingNumber) to link to areas.
      plan("pl_spec", { drawingNumber: "", category: "spec", title: "Joinery spec" }),
    ],
  });

  for (const p of [authPath, handlerPath, auditPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: {
      getWebPush: vi.fn(() => ({})),
      sendPushToUserId: vi.fn(async (userId: string, payload: { title: string; body: string; url: string }) => {
        pushCalls.push({ userId, payload });
        return { sent: 1, pruned: 0 };
      }),
    },
  } as NodeJS.Module;
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

// ── #299: one-step revision flow + acknowledgements ───────────────────────

async function callAs(
  viewer: { id: string; role: string },
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
        cookie: `buhl_session=${auth.signSession({ userId: viewer.id, role: viewer.role, exp: Date.now() + 60_000 })}`,
      },
    },
    res,
  );
  return res;
}

const ELEC = { id: "u_elec", role: "electrician" };
const TRADIE = { id: "u_tradie", role: "tradie" };
const OUT = { id: "u_out", role: "tradie" };

describe("one-step revision flow (#299)", () => {
  it("revisesPlanId inherits identity, supersedes the predecessor and stores the summary", async () => {
    const res = await call("POST", { jobId: "j1" }, {
      dataUrl: PNG_DATA_URL,
      fileName: "rev-b.pdf",
      revision: "B",
      revisesPlanId: "pl_a",
      changeSummary: "Unit 4 power changed",
    });
    expect(res.statusCode).toBe(201);
    const created = (res.body as { plan: Record<string, unknown> }).plan;
    // Inherited from pl_a — the admin typed none of these.
    expect(created.drawingNumber).toBe("E-101");
    expect(created.title).toBe("Power L1 rev A");
    expect(created.revision).toBe("B");
    expect(created.changeSummary).toBe("Unit 4 power changed");
    expect(created.supersedes).toBe("pl_a");
    const prev = plansInStore().find((p) => p.id === "pl_a")!;
    expect(prev.status).toBe("superseded");
    expect(prev.supersededBy).toBe(created.id);
    // Exactly one current on the number; audit verbs landed.
    expect(
      plansInStore().filter((p) => p.drawingNumber === "E-101" && p.status === "current"),
    ).toHaveLength(1);
    expect(auditActions()).toContain("document.uploaded");
    expect(auditActions()).toContain("document.superseded");
  });

  it("a bad revisesPlanId is a hard 400 — explicit intent never degrades", async () => {
    const res = await call("POST", { jobId: "j1" }, {
      dataUrl: PNG_DATA_URL,
      revisesPlanId: "pl_ghost",
    });
    expect(res.statusCode).toBe(400);
  });

  it("a real revision pushes assigned field workers (with subs) only — PII-free deep link", async () => {
    const res = await call("POST", { jobId: "j1" }, {
      dataUrl: PNG_DATA_URL,
      revision: "B",
      revisesPlanId: "pl_a",
      changeSummary: "Kitchen circuit added",
    });
    expect((res.body as { notified: number }).notified).toBe(1);
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0]!.userId).toBe("u_elec"); // mick has no subscription
    expect(pushCalls[0]!.payload.title).toContain("E-101");
    expect(pushCalls[0]!.payload.title).toContain("Rev B");
    expect(pushCalls[0]!.payload.body).toContain("Kitchen circuit added");
    expect(pushCalls[0]!.payload.url).toBe("/phil/jobs/j1/plans");
  });

  it("first upload of a drawing supersedes nothing and notifies nobody", async () => {
    const res = await call("POST", { jobId: "j1" }, {
      dataUrl: PNG_DATA_URL,
      drawingNumber: "E-999",
      title: "Brand new sheet",
      revision: "A",
    });
    expect(res.statusCode).toBe(201);
    expect((res.body as { notified: number }).notified).toBe(0);
    expect(pushCalls).toHaveLength(0);
  });
});

describe("revision acknowledgements (#299)", () => {
  it("assigned worker acks self-only; double-tap idempotent; audited", async () => {
    const first = await callAs(ELEC, "POST", { jobId: "j1", action: "ack" }, { planId: "pl_a" });
    expect(first.statusCode).toBe(201);
    const ack = (first.body as { ack: Record<string, unknown> }).ack;
    expect(ack).toMatchObject({ planId: "pl_a", userId: "u_elec", userName: "sparky" });
    const again = await callAs(ELEC, "POST", { jobId: "j1", action: "ack" }, { planId: "pl_a" });
    expect(again.statusCode).toBe(200);
    expect((again.body as { already?: boolean }).already).toBe(true);
    const store = blob.get("jobs/j1/plan-acks.json") as { acks: unknown[] };
    expect(store.acks).toHaveLength(1);
    expect(auditActions()).toContain("document.acknowledged");
  });

  it("unassigned workers 403; unknown plan 404", async () => {
    const out = await callAs(OUT, "POST", { jobId: "j1", action: "ack" }, { planId: "pl_a" });
    expect(out.statusCode).toBe(403);
    const ghost = await callAs(ELEC, "POST", { jobId: "j1", action: "ack" }, { planId: "pl_ghost" });
    expect(ghost.statusCode).toBe(404);
  });

  it("rollup: admin sees acked/outstanding from CURRENT field crew; field caller 403s", async () => {
    await callAs(ELEC, "POST", { jobId: "j1", action: "ack" }, { planId: "pl_a" });
    const rollup = await call("GET", { jobId: "j1", action: "acks", planId: "pl_a" });
    expect(rollup.statusCode).toBe(200);
    const body = rollup.body as {
      acked: Array<{ userId: string }>;
      outstanding: Array<{ userId: string }>;
    };
    expect(body.acked.map((a) => a.userId)).toEqual(["u_elec"]);
    // mick outstanding; the assigned CLIENT is not audience; u_out unassigned.
    expect(body.outstanding.map((o) => o.userId)).toEqual(["u_tradie"]);
    const field = await callAs(ELEC, "GET", { jobId: "j1", action: "acks", planId: "pl_a" });
    expect(field.statusCode).toBe(403);
  });

  it("my-acks returns only the viewer's planIds", async () => {
    await callAs(ELEC, "POST", { jobId: "j1", action: "ack" }, { planId: "pl_a" });
    await callAs(TRADIE, "POST", { jobId: "j1", action: "ack" }, { planId: "pl_b" });
    const mine = await callAs(ELEC, "GET", { jobId: "j1", action: "my-acks" });
    expect(mine.statusCode).toBe(200);
    expect((mine.body as { planIds: string[] }).planIds).toEqual(["pl_a"]);
  });
});

// ── #196: spec → work-tree area/stage linkage on the PATCH path ────────────

describe("spec area/stage linkage (#196)", () => {
  function specRow() {
    return plansInStore().find((p) => p.id === "pl_spec")!;
  }

  it("PATCH accepts valid areaIds + stage, denormalises the area names", async () => {
    const res = await call(
      "PATCH",
      { jobId: "j1", id: "pl_spec" },
      { areaIds: ["area-kitchen", "area-pantry"], stage: "fitOff" },
    );
    expect(res.statusCode).toBe(200);
    const spec = specRow();
    expect(spec.areaIds).toEqual(["area-kitchen", "area-pantry"]);
    expect(spec.stage).toBe("fitOff");
    // denormalised names captured at link time
    expect(spec.areaLinks).toEqual([
      { areaId: "area-kitchen", areaName: "Kitchen" },
      { areaId: "area-pantry", areaName: "Pantry" },
    ]);
  });

  it("rejects an unknown areaId with 400 (no dangling link ever persisted)", async () => {
    const res = await call(
      "PATCH",
      { jobId: "j1", id: "pl_spec" },
      { areaIds: ["area-kitchen", "area-ghost"] },
    );
    expect(res.statusCode).toBe(400);
    // nothing was written — the spec stays unlinked
    expect(specRow().areaIds).toBeUndefined();
  });

  it("rejects a bad stage with 400", async () => {
    const res = await call(
      "PATCH",
      { jobId: "j1", id: "pl_spec" },
      { areaIds: ["area-kitchen"], stage: "commissioning" },
    );
    expect(res.statusCode).toBe(400);
  });

  it("areaIds: [] clears the link; stage '' clears the stage", async () => {
    await call(
      "PATCH",
      { jobId: "j1", id: "pl_spec" },
      { areaIds: ["area-kitchen"], stage: "roughIn" },
    );
    expect(specRow().areaIds).toEqual(["area-kitchen"]);
    const res = await call(
      "PATCH",
      { jobId: "j1", id: "pl_spec" },
      { areaIds: [], stage: "" },
    );
    expect(res.statusCode).toBe(200);
    expect(specRow().areaIds).toEqual([]);
    expect(specRow().areaLinks).toEqual([]);
    expect(specRow().stage).toBe("");
  });

  it("retires linkedAreaGroups — the field is ignored, not written", async () => {
    const res = await call(
      "PATCH",
      { jobId: "j1", id: "pl_spec" },
      { linkedAreaGroups: ["g1"], areaIds: ["area-kitchen"] },
    );
    expect(res.statusCode).toBe(200);
    // the new vocabulary is written…
    expect(specRow().areaIds).toEqual(["area-kitchen"]);
    // …and the retired one is NOT (no two vocabularies for "what this governs")
    expect(specRow().linkedAreaGroups).toBeUndefined();
  });

  it("a superseding upload does NOT inherit the predecessor's areaIds", async () => {
    // Link the spec, then upload a new revision via revisesPlanId.
    await call(
      "PATCH",
      { jobId: "j1", id: "pl_spec" },
      { areaIds: ["area-kitchen"], stage: "fitOff" },
    );
    const res = await call("POST", { jobId: "j1" }, {
      dataUrl: PNG_DATA_URL,
      fileName: "joinery-rev-b.pdf",
      revisesPlanId: "pl_spec",
    });
    expect(res.statusCode).toBe(201);
    const created = (res.body as { plan: Record<string, unknown> }).plan;
    // identity fields inherit (category), but the area link does NOT —
    // re-linking is a deliberate admin act on the new revision.
    expect(created.category).toBe("spec");
    expect(created.areaIds).toBeUndefined();
    expect(created.stage).toBeUndefined();
  });
});
