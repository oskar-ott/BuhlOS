import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One person, ONE roster row (owner-reported 2026-08-06: a signup-link worker
 * appeared twice on /employees — once as their users.json login, once as
 * their employees.json HR record; "once for email, once for phone").
 *
 * Contract pinned here, against the REAL handler with an in-memory blob:
 *   · GET list: an onboarding row linked by userId ABSORBS its users.json
 *     twin — the login never renders as a second row; unlinked users and
 *     unlinked onboarding rows still both appear.
 *   · The merged row carries the login's LIVE assignedJobIds (Phil-visibility
 *     truth) and reads disabled when the login is archived.
 *   · GET ?id= by USER id resolves to the same merged row (old deep links).
 *   · Disable cascades across BOTH stores from either id — a disabled roster
 *     row can never hide a live login.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const authLibPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const employeesPath = requireFromHere.resolve("../../../api/employees.js");

type Res = ReturnType<typeof createRes>;
let store: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let employeesHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

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

function adminCookie() {
  return `buhl_session=${auth.signSession({ userId: "u_admin", role: "admin" })}`;
}

async function call(over: Record<string, unknown> = {}) {
  const res = createRes();
  await employeesHandler(
    { method: "GET", query: {}, body: {}, headers: { cookie: adminCookie() }, ...over },
    res,
  );
  return res;
}

type Row = { employee: Record<string, unknown>; jobsCount: number };
function rowsOf(res: Res): Row[] {
  return (res.body as { employees: Row[] }).employees;
}

beforeEach(async () => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_EMPLOYEES = "1";
  delete process.env.OWNER_PASSWORD_HASH;

  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "admin", passwordHash: "$2a$10$x", assignedJobIds: [] },
          // A signup-link worker: login linked from the onboarding row below.
          {
            id: "u_alfredo",
            username: "alfredo.reyes@gmail.com",
            name: "Alfredo Reyes",
            email: "alfredo.reyes@gmail.com",
            role: "electrician",
            passwordHash: "$2a$10$x",
            assignedJobIds: ["j_live_1", "j_live_2"],
            createdVia: "signup-link",
          },
          // A legacy login with NO onboarding row — must still get its own row.
          { id: "u_legacy", username: "legacy", name: "Legacy Sparky", role: "electrician", passwordHash: "$2a$10$x", assignedJobIds: [] },
        ],
      },
    ],
    [
      "employees.json",
      {
        employees: [
          // The signup-created HR record for u_alfredo (phone + HR facts).
          {
            id: "e_alfredo",
            firstName: "Alfredo",
            lastName: "Reyes",
            displayName: null,
            email: "alfredo.reyes@gmail.com",
            phone: "0400 111 222",
            role: "electrician",
            apprenticeYear: null,
            appAccess: "phil",
            status: "active",
            assignedJobIds: [],
            assignedGearIds: [],
            createdAt: "2026-08-01T00:00:00.000Z",
            userId: "u_alfredo",
            source: "signup-link",
          },
          // A draft onboarding-only employee (no login yet) — still one row.
          {
            id: "e_draft",
            firstName: "Ona",
            lastName: "Books",
            email: "onbooks@gmail.com",
            phone: null,
            role: "electrician",
            status: "draft",
            assignedJobIds: [],
            assignedGearIds: [],
            userId: null,
            source: "onboarding",
          },
        ],
      },
    ],
    ["employee-invites.json", { invites: [] }],
  ]);

  // Same CJS require.cache injection the signup-api tests use — the handlers
  // are CommonJS, so vi.doMock (ESM) never reaches their require('./_lib/…').
  for (const p of [authLibPath, employeesPath]) {
    delete requireFromHere.cache[p];
  }
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        store.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[auditPath] = {
    id: auditPath,
    filename: auditPath,
    loaded: true,
    exports: { append: vi.fn(async () => {}) },
  } as NodeJS.Module;

  auth = requireFromHere(authLibPath) as typeof auth;
  employeesHandler = requireFromHere(employeesPath) as typeof employeesHandler;
});

afterEach(() => {
  delete process.env.FLAG_EMPLOYEES;
});

describe("GET /api/employees — linked-row dedup", () => {
  it("shows a signup-link worker ONCE (the merged row), not once per store", async () => {
    const res = await call();
    expect(res.statusCode).toBe(200);
    const rows = rowsOf(res);
    const alfredoRows = rows.filter(
      (r) => String(r.employee.email).toLowerCase() === "alfredo.reyes@gmail.com",
    );
    expect(alfredoRows).toHaveLength(1);
    // The surviving row is the HR record (phone intact), not the bare login.
    expect(alfredoRows[0]!.employee.id).toBe("e_alfredo");
    expect(alfredoRows[0]!.employee.phone).toBe("0400 111 222");
    // No row surfaces the raw login id anymore.
    expect(rows.some((r) => r.employee.id === "u_alfredo")).toBe(false);
  });

  it("keeps one row each for unlinked logins and unlinked onboarding rows", async () => {
    const rows = rowsOf(await call());
    expect(rows.filter((r) => r.employee.id === "u_legacy")).toHaveLength(1);
    expect(rows.filter((r) => r.employee.id === "e_draft")).toHaveLength(1);
  });

  it("merged row carries the login's LIVE assignedJobIds (Phil-visibility truth)", async () => {
    const rows = rowsOf(await call());
    const merged = rows.find((r) => r.employee.id === "e_alfredo")!;
    expect(merged.employee.assignedJobIds).toEqual(["j_live_1", "j_live_2"]);
    expect(merged.jobsCount).toBe(2);
  });

  it("merged row reads disabled when the LOGIN is archived, whatever the HR row says", async () => {
    const usersBlob = store.get("users.json") as { users: Array<Record<string, unknown>> };
    usersBlob.users.find((u) => u.id === "u_alfredo")!.archived = true;
    const rows = rowsOf(await call());
    expect(rows.find((r) => r.employee.id === "e_alfredo")!.employee.status).toBe("disabled");
  });

  it("GET ?id=<user id> resolves to the SAME merged row (old deep links keep landing)", async () => {
    const res = await call({ query: { id: "u_alfredo" } });
    expect(res.statusCode).toBe(200);
    const row = (res.body as { row: Row }).row;
    expect(row.employee.id).toBe("e_alfredo");
    expect(row.employee.assignedJobIds).toEqual(["j_live_1", "j_live_2"]);
  });
});

describe("POST /api/employees?action=disable — cascades across both stores", () => {
  it("disabling by EMPLOYEE id also archives the linked login", async () => {
    const res = await call({ method: "POST", query: { action: "disable", id: "e_alfredo" } });
    expect(res.statusCode).toBe(200);
    const emp = (store.get("employees.json") as { employees: Array<Record<string, unknown>> })
      .employees.find((e) => e.id === "e_alfredo")!;
    const user = (store.get("users.json") as { users: Array<Record<string, unknown>> })
      .users.find((u) => u.id === "u_alfredo")!;
    expect(emp.status).toBe("disabled");
    expect(user.archived).toBe(true);
  });

  it("disabling by USER id also disables the linked HR row", async () => {
    const res = await call({ method: "POST", query: { action: "disable", id: "u_alfredo" } });
    expect(res.statusCode).toBe(200);
    const emp = (store.get("employees.json") as { employees: Array<Record<string, unknown>> })
      .employees.find((e) => e.id === "e_alfredo")!;
    const user = (store.get("users.json") as { users: Array<Record<string, unknown>> })
      .users.find((u) => u.id === "u_alfredo")!;
    expect(user.archived).toBe(true);
    expect(emp.status).toBe("disabled");
    // The response row is the merged row, so the client upserts in place.
    expect(((res.body as { row: Row }).row).employee.id).toBe("e_alfredo");
  });

  it("refuses to disable yourself via your own linked employee row, and writes NOTHING", async () => {
    const emp = store.get("employees.json") as { employees: Array<Record<string, unknown>> };
    emp.employees.push({
      id: "e_self",
      firstName: "Big",
      lastName: "Boss",
      email: "boss@buhl.com.au",
      role: "electrician",
      status: "active",
      assignedJobIds: [],
      assignedGearIds: [],
      userId: "u_admin",
      source: "onboarding",
    });
    const res = await call({ method: "POST", query: { action: "disable", id: "e_self" } });
    expect(res.statusCode).toBe(400);
    const after = (store.get("employees.json") as { employees: Array<Record<string, unknown>> })
      .employees.find((e) => e.id === "e_self")!;
    expect(after.status).toBe("active");
  });
});
