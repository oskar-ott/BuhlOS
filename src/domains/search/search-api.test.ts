import { createRequire } from "node:module";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  process.env.FLAG_SNAGS = "1";
});
afterAll(() => {
  delete process.env.FLAG_SNAGS;
});

/**
 * #188 — api/search.js against the real handler. The UI ships over this
 * endpoint unchanged in ranking; the one promise this pins is the visibility
 * SCOPING (the line-74 tier fix the audit flagged): a boss/office-tier
 * account — NOT the literal 'admin' role — must get full-company results,
 * not the empty leading-hand branch. Plus LH assigned-scoping, the user
 * deep-link, non-staff 403, and the q<2 empty contract.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/search.js");

type Handler = (req: Record<string, unknown>, res: ReturnType<typeof createRes>) => Promise<unknown>;

let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: Handler;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
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

async function search(role: string, userId: string, q: string) {
  const res = createRes();
  await handler(
    {
      method: "GET",
      query: { q },
      headers: {
        cookie: `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`,
      },
    },
    res
  );
  return res;
}

function results(res: ReturnType<typeof createRes>): Array<Record<string, unknown>> {
  return (res.body as { results: Array<Record<string, unknown>> }).results;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_boss", username: "Daniel Boss", role: "boss" }, // admin TIER, no assignedJobIds
          { id: "u_admin", username: "Literal Admin", role: "admin" },
          { id: "u_lh", username: "Lead Hand", role: "leadingHand", assignedJobIds: ["j1"] },
          { id: "u_field", username: "Sparky Field", role: "electrician", assignedJobIds: ["j1"] },
        ],
      },
    ],
    [
      "jobs.json",
      {
        jobs: [
          { id: "j1", name: "Magill Road", status: "active" },
          { id: "j2", name: "Magill Heights", status: "active" }, // LH NOT assigned
        ],
      },
    ],
    ["jobs/j1/data.json", { snags: [{ id: "s1", desc: "Meter box loose", status: "open", createdAt: "2026-06-01" }] }],
    ["jobs/j2/data.json", { snags: [{ id: "s2", desc: "Meter box rusty", status: "open", createdAt: "2026-06-02" }] }],
  ]);
  for (const p of [blobPath, authPath, handlerPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("visibility scoping (#188 line-74 tier fix)", () => {
  it("a boss-tier account (not literal 'admin', no assignedJobIds) gets FULL-company results", async () => {
    const res = await search("boss", "u_boss", "magill");
    expect(res.statusCode).toBe(200);
    const jobs = results(res).filter((r) => r.type === "job").map((r) => r.id);
    expect(jobs.sort()).toEqual(["j1", "j2"]); // both jobs — NOT the empty LH branch
  });

  it("the literal admin account is unchanged (also full-company)", async () => {
    const res = await search("admin", "u_admin", "magill");
    expect(results(res).filter((r) => r.type === "job")).toHaveLength(2);
  });

  it("a leading hand is scoped to assigned jobs only", async () => {
    const res = await search("leadingHand", "u_lh", "magill");
    const jobs = results(res).filter((r) => r.type === "job").map((r) => r.id);
    expect(jobs).toEqual(["j1"]); // j1 only — never j2, which they aren't on
  });
});

describe("result shape + gating", () => {
  it("user results deep-link to /employees/[id]; clients have no link", async () => {
    (blob.get("users.json") as { users: Array<Record<string, unknown>> }).users.push({
      id: "u_client",
      username: "Client Co",
      role: "client",
    });
    const res = await search("boss", "u_boss", "spar");
    const user = results(res).find((r) => r.type === "user" && r.id === "u_field");
    expect(user?.url).toBe("/employees/u_field");
    const client = await search("boss", "u_boss", "client co");
    const c = results(client).find((r) => r.type === "user" && r.id === "u_client");
    expect(c?.url).toBeNull();
  });

  it("non-staff are 403; q<2 returns an empty result set, not an error", async () => {
    expect((await search("electrician", "u_field", "magill")).statusCode).toBe(403);
    const short = await search("boss", "u_boss", "m");
    expect(short.statusCode).toBe(200);
    expect(results(short)).toEqual([]);
  });
});
