import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Verifies the tier-aware gating in api/_lib/auth.js (PR 2): requireAuth's
 * `roles` allow-list and the isStaffRole/roleSatisfies helpers. The bug this
 * guards against is "UI lets me in but the API 403s me" — a boss/owner/office
 * user who reaches a BuhlOS admin surface then being rejected by an API that
 * only literal-matched 'admin', or a leading hand stored as 'lh' being locked
 * out of hours approvals.
 *
 * Mirrors legacy-api-auth.test.ts: mock the Blob store, sign a real session,
 * call the real handler.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");

interface AuthModule {
  isAdminRole: (r: unknown) => boolean;
  isLeadingHandRole: (r: unknown) => boolean;
  isFieldRole: (r: unknown) => boolean;
  isStaffRole: (r: unknown) => boolean;
  roleSatisfies: (userRole: unknown, allowed: string[]) => boolean;
  signSession: (payload: Record<string, unknown>) => string;
  requireAuth: (
    req: { headers: { cookie?: string } },
    res: ReturnType<typeof createRes>,
    opts?: { roles?: string[]; jobId?: string }
  ) => Promise<Record<string, unknown> | null>;
}

let auth: AuthModule;
let users: Array<Record<string, unknown>> = [];

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
  };
}

async function gate(
  role: string,
  opts: { roles?: string[]; jobId?: string },
  assignedJobIds: string[] = []
) {
  users = [{ id: "u1", username: "u", role, assignedJobIds }];
  const token = auth.signSession({ userId: "u1", role, exp: Date.now() + 60_000 });
  const res = createRes();
  const user = await auth.requireAuth({ headers: { cookie: `buhl_session=${token}` } }, res, opts);
  return { user, res };
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  users = [];
  delete requireFromHere.cache[authPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async () => ({ users })),
      writeBlob: vi.fn(),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  auth = requireFromHere(authPath);
});

describe("isStaffRole / roleSatisfying (legacy)", () => {
  it("isStaffRole = admin tier OR leading-hand tier", () => {
    for (const r of ["admin", "boss", "owner", "office", "pm", "estimator", "lh", "leadinghand"]) {
      expect(auth.isStaffRole(r)).toBe(true);
    }
    for (const r of ["tradie", "apprentice", "electrician", "client", "accounts", ""]) {
      expect(auth.isStaffRole(r)).toBe(false);
    }
  });

  it("'admin' allow-entry admits the whole admin tier", () => {
    expect(auth.roleSatisfies("boss", ["admin"])).toBe(true);
    expect(auth.roleSatisfies("office", ["admin"])).toBe(true);
    expect(auth.roleSatisfies("ESTIMATOR", ["admin"])).toBe(true);
    expect(auth.roleSatisfies("tradie", ["admin"])).toBe(false);
  });

  it("'leadingHand' allow-entry admits the lowercase aliases", () => {
    expect(auth.roleSatisfies("lh", ["admin", "leadingHand"])).toBe(true);
    expect(auth.roleSatisfies("leadinghand", ["leadingHand"])).toBe(true);
    expect(auth.roleSatisfies("leading_hand", ["leadingHand"])).toBe(true);
  });

  it("unknown allow-entries (e.g. 'accounts') match themselves only", () => {
    expect(auth.roleSatisfies("accounts", ["accounts"])).toBe(true);
    expect(auth.roleSatisfies("admin", ["accounts"])).toBe(false);
  });
});

describe("requireAuth tier-aware { roles } gate", () => {
  it("admits every admin-tier role to an { roles: ['admin'] } gate", async () => {
    for (const role of ["admin", "boss", "owner", "manager", "office", "pm", "estimator"]) {
      const { user, res } = await gate(role, { roles: ["admin"] });
      expect(res.statusCode).toBe(200);
      expect(user).not.toBeNull();
    }
  });

  it("403s field workers and clients on an admin gate", async () => {
    for (const role of ["tradie", "apprentice", "electrician", "client"]) {
      const { user, res } = await gate(role, { roles: ["admin"] });
      expect(res.statusCode).toBe(403);
      expect(user).toBeNull();
    }
  });

  it("admits admin tier + LH aliases to the hours-approval gate", async () => {
    for (const role of ["admin", "boss", "office", "lh", "leadinghand", "leading_hand"]) {
      const { res } = await gate(role, { roles: ["admin", "leadingHand"] });
      expect(res.statusCode).toBe(200);
    }
    const denied = await gate("tradie", { roles: ["admin", "leadingHand"] });
    expect(denied.res.statusCode).toBe(403);
  });

  it("401s an unauthenticated request", async () => {
    const res = createRes();
    const user = await auth.requireAuth({ headers: {} }, res, { roles: ["admin"] });
    expect(res.statusCode).toBe(401);
    expect(user).toBeNull();
  });

  it("still enforces job assignment for field workers (jobId opt)", async () => {
    const ok = await gate("tradie", { jobId: "job-1" }, ["job-1"]);
    expect(ok.res.statusCode).toBe(200);
    const no = await gate("tradie", { jobId: "job-2" }, ["job-1"]);
    expect(no.res.statusCode).toBe(403);
    // admin-tier reaches any job without an assignment
    const boss = await gate("boss", { jobId: "job-9" }, []);
    expect(boss.res.statusCode).toBe(200);
  });
});
