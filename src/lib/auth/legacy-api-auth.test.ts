import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireFromHere = createRequire(import.meta.url);
const bcrypt = requireFromHere("bcryptjs") as {
  hash: (value: string, rounds: number) => Promise<string>;
};
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const authApiPath = requireFromHere.resolve("../../../api/auth.js");

let users: Array<Record<string, unknown>> = [];
let auth: {
  signSession: (payload: Record<string, unknown>) => string;
  getCurrentUser: (req: { headers: { cookie?: string } }) => Promise<Record<string, unknown> | null>;
};
let authHandler: (
  req: Record<string, unknown>,
  res: ReturnType<typeof createRes>
) => Promise<void>;

function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
    setHeader(name: string, value: unknown) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
  };
}

describe("legacy auth disabled-user gates", () => {
  beforeEach(async () => {
    process.env.SESSION_SECRET = "test-session-secret-long-enough";
    users = [
      {
        id: "u_active",
        username: "active",
        role: "electrician",
        assignedJobIds: ["job-1"],
        passwordHash: await bcrypt.hash("1234", 4),
      },
      {
        id: "u_archived",
        username: "archived",
        role: "electrician",
        archived: true,
        assignedJobIds: ["job-1"],
        passwordHash: await bcrypt.hash("1234", 4),
      },
      {
        id: "u_disabled",
        username: "disabled",
        role: "electrician",
        status: "disabled",
        assignedJobIds: ["job-1"],
        passwordHash: await bcrypt.hash("1234", 4),
      },
    ];
    delete requireFromHere.cache[authApiPath];
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
    authHandler = requireFromHere(authApiPath);
  });

  it("allows active users to log in unchanged", async () => {
    const res = createRes();
    await authHandler(
      { method: "POST", query: { action: "login" }, body: { username: "active", secret: "1234" }, headers: {} },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(String(res.headers["set-cookie"])).toContain("buhl_session=");
    expect(res.body).toMatchObject({ user: { id: "u_active", username: "active" } });
    expect(JSON.stringify(res.body)).not.toContain("passwordHash");
  });

  it("rejects archived users after a valid password", async () => {
    const res = createRes();
    await authHandler(
      { method: "POST", query: { action: "login" }, body: { username: "archived", secret: "1234" }, headers: {} },
      res
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Account disabled. Ask your supervisor." });
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects disabled-status users after a valid password", async () => {
    const res = createRes();
    await authHandler(
      { method: "POST", query: { action: "login" }, body: { username: "disabled", secret: "1234" }, headers: {} },
      res
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: "Account disabled. Ask your supervisor." });
  });

  it("does not return archived users from an existing session", async () => {
    const token = auth.signSession({
      userId: "u_archived",
      role: "electrician",
      exp: Date.now() + 60_000,
    });

    await expect(auth.getCurrentUser({ headers: { cookie: `buhl_session=${token}` } })).resolves.toBeNull();
  });
});
