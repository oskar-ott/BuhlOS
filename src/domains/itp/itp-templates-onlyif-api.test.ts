import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #293 — save-time whitelist for conditional ("only-if") points against
 * the REAL api/itp-templates.js handler.
 *
 * The writer is FAIL-CLOSED: it persists `onlyIf` ONLY when shaped
 * exactly `{ scopeType: <valid scope or array of valid scopes> }`, and
 * drops unknown keys / garbage so a typo never reaches storage. Without
 * this whitelist the writer would strip the whole field and the feature
 * would be dead end-to-end.
 *
 * Same in-memory blob + signed-session harness as
 * job-itps-submit-api.test.ts.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/itp-templates.js");

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

async function createTemplate(
  userId: string,
  role: string,
  points: Array<Record<string, unknown>>,
): Promise<Res> {
  const res = createRes();
  await handler(
    {
      method: "POST",
      query: {},
      headers: {
        cookie: `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`,
      },
      body: { name: "Cond template", points },
    },
    res,
  );
  return res;
}

function storedPoint(body: unknown): Record<string, unknown> {
  const tpl = (body as { template: { points: Array<Record<string, unknown>> } })
    .template;
  const p = tpl.points[0];
  if (!p) throw new Error("expected a stored point");
  return p;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "office", passwordHash: "$2a$10$x" },
    ],
  });
  blob.set("itp-templates.json", { templates: [] });

  for (const p of [authPath, handlerPath]) delete requireFromHere.cache[p];
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

  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api/itp-templates validatePoint — onlyIf whitelist (#293)", () => {
  it("persists a well-shaped scalar scopeType", async () => {
    const res = await createTemplate("u_admin", "office", [
      { label: "MSB door label", type: "photo", onlyIf: { scopeType: "switchboard" } },
    ]);
    expect(res.statusCode).toBe(201);
    expect(storedPoint(res.body).onlyIf).toEqual({ scopeType: "switchboard" });
  });

  it("persists a well-shaped array scopeType (dedupes, keeps array form)", async () => {
    const res = await createTemplate("u_admin", "office", [
      {
        label: "x",
        type: "signoff",
        onlyIf: { scopeType: ["switchboard", "level", "switchboard"] },
      },
    ]);
    expect(res.statusCode).toBe(201);
    expect(storedPoint(res.body).onlyIf).toEqual({
      scopeType: ["switchboard", "level"],
    });
  });

  it("drops an unknown condition key entirely (garbage never persists)", async () => {
    const res = await createTemplate("u_admin", "office", [
      { label: "x", type: "signoff", onlyIf: { jobAttribute: "two-phase" } },
    ]);
    expect(res.statusCode).toBe(201);
    expect(storedPoint(res.body).onlyIf).toBeUndefined();
  });

  it("drops a typo'd / invalid scope value", async () => {
    const res = await createTemplate("u_admin", "office", [
      { label: "x", type: "signoff", onlyIf: { scopeType: "switcboard" } },
    ]);
    expect(res.statusCode).toBe(201);
    expect(storedPoint(res.body).onlyIf).toBeUndefined();
  });

  it("keeps only the valid entries from a mixed array, drops junk", async () => {
    const res = await createTemplate("u_admin", "office", [
      {
        label: "x",
        type: "signoff",
        onlyIf: { scopeType: ["area", "nonsense", 7, null] },
      },
    ]);
    expect(res.statusCode).toBe(201);
    expect(storedPoint(res.body).onlyIf).toEqual({ scopeType: ["area"] });
  });

  it("drops onlyIf when it is not an object", async () => {
    const res = await createTemplate("u_admin", "office", [
      { label: "x", type: "signoff", onlyIf: "switchboard" },
    ]);
    expect(res.statusCode).toBe(201);
    expect(storedPoint(res.body).onlyIf).toBeUndefined();
  });

  it("leaves a plain legacy point byte-identical (no onlyIf key)", async () => {
    const res = await createTemplate("u_admin", "office", [
      { label: "x", type: "signoff" },
    ]);
    expect(res.statusCode).toBe(201);
    expect(
      Object.prototype.hasOwnProperty.call(storedPoint(res.body), "onlyIf"),
    ).toBe(false);
  });
});
