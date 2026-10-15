import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Change role (owner pull 2026-10-15: an electrician becoming the project
 * manager had no way to get there). POST /api/employees?action=role, against
 * the REAL handler with an in-memory blob.
 *
 * Contract pinned here:
 *   · The users.json login — what every permission check reads — carries the
 *     new role, and a linked HR row moves with it (one person, one role). The
 *     PATCH path writes only the HR row; this is the one that grants access.
 *   · Either id (HR row or login) works, like disable.
 *   · A worker who hasn't finished setup (no login) only has an HR row to move.
 *   · Refused: your own role, an unknown role, an apprentice without a year, a
 *     client login, and demoting the last active admin.
 *   · A real change is audited; asking for the role someone already has
 *     writes nothing.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const authLibPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const employeesPath = requireFromHere.resolve("../../../api/employees.js");

type Res = ReturnType<typeof createRes>;
type Users = { users: Array<Record<string, unknown>> };
type Employees = { employees: Array<Record<string, unknown>> };
let store: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let employeesHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let writeBlob: ReturnType<typeof vi.fn>;
let auditAppend: ReturnType<typeof vi.fn>;

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

function cookieFor(userId: string, role: string) {
  return `buhl_session=${auth.signSession({ userId, role })}`;
}

async function changeRole(
  id: string,
  body: Record<string, unknown>,
  cookie = cookieFor("u_admin", "admin"),
) {
  const res = createRes();
  await employeesHandler(
    { method: "POST", query: { action: "role", id }, body, headers: { cookie } },
    res,
  );
  return res;
}

function user(id: string) {
  return (store.get("users.json") as Users).users.find((u) => u.id === id)!;
}
function hrRow(id: string) {
  return (store.get("employees.json") as Employees).employees.find((e) => e.id === id)!;
}
function rowOf(res: Res) {
  return (res.body as { row: { employee: Record<string, unknown> } }).row.employee;
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
          // A legacy login with NO onboarding row (how most of the crew exist).
          { id: "u_simon", username: "simon", name: "Simon Sparky", role: "electrician", passwordHash: "$2a$10$x", assignedJobIds: ["j_1"] },
          // A signup-link worker: login linked from the HR row below.
          {
            id: "u_alfredo",
            username: "alfredo.reyes@gmail.com",
            name: "Alfredo Reyes",
            email: "alfredo.reyes@gmail.com",
            role: "electrician",
            passwordHash: "$2a$10$x",
            assignedJobIds: [],
          },
          { id: "u_client", username: "client", role: "client", passwordHash: "$2a$10$x", assignedJobIds: [] },
        ],
      },
    ],
    [
      "employees.json",
      {
        employees: [
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
          // Invited, not set up yet — no login exists.
          {
            id: "e_draft",
            firstName: "Ona",
            lastName: "Books",
            email: "onbooks@gmail.com",
            phone: null,
            role: "labourer",
            apprenticeYear: null,
            appAccess: "phil",
            status: "draft",
            assignedJobIds: [],
            assignedGearIds: [],
            userId: null,
            source: "onboarding",
          },
        ],
      },
    ],
  ]);

  for (const p of [authLibPath, employeesPath]) {
    delete requireFromHere.cache[p];
  }
  writeBlob = vi.fn(async (key: string, data: unknown) => {
    store.set(key, clone(data));
  });
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback,
      ),
      writeBlob,
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  auditAppend = vi.fn(async () => {});
  requireFromHere.cache[auditPath] = {
    id: auditPath,
    filename: auditPath,
    loaded: true,
    exports: { append: auditAppend },
  } as NodeJS.Module;

  auth = requireFromHere(authLibPath) as typeof auth;
  employeesHandler = requireFromHere(employeesPath) as typeof employeesHandler;
});

afterEach(() => {
  delete process.env.FLAG_EMPLOYEES;
});

describe("POST /api/employees?action=role — the login carries the new role", () => {
  it("electrician → project manager on a login-only worker: the login (permissions) changes", async () => {
    const res = await changeRole("u_simon", { role: "pm" });
    expect(res.statusCode).toBe(200);
    expect(user("u_simon").role).toBe("pm");
    // Nothing else on the login moves — jobs and credentials stay.
    expect(user("u_simon").assignedJobIds).toEqual(["j_1"]);
    expect(user("u_simon").passwordHash).toBe("$2a$10$x");
    expect(rowOf(res).role).toBe("pm");
    expect(rowOf(res).appAccess).toBe("both");
  });

  it("a linked worker moves on BOTH halves — by HR id or by login id", async () => {
    const byHr = await changeRole("e_alfredo", { role: "pm" });
    expect(byHr.statusCode).toBe(200);
    expect(user("u_alfredo").role).toBe("pm");
    expect(hrRow("e_alfredo").role).toBe("pm");
    expect(hrRow("e_alfredo").appAccess).toBe("both");
    expect(rowOf(byHr).id).toBe("e_alfredo");

    const byLogin = await changeRole("u_alfredo", { role: "leadinghand" });
    expect(byLogin.statusCode).toBe(200);
    expect(user("u_alfredo").role).toBe("leadinghand");
    expect(hrRow("e_alfredo").role).toBe("leadinghand");
    // The merged row answers, not the bare login.
    expect(rowOf(byLogin).id).toBe("e_alfredo");
  });

  it("a worker with no login yet only has the HR row to move (their login is created from it)", async () => {
    const res = await changeRole("e_draft", { role: "electrician" });
    expect(res.statusCode).toBe(200);
    expect(hrRow("e_draft").role).toBe("electrician");
    expect(writeBlob.mock.calls.map((c) => c[0])).toEqual(["employees.json"]);
  });

  it("apprentice needs a year; the year rides on the login for a login-only worker", async () => {
    const missing = await changeRole("u_simon", { role: "apprentice" });
    expect(missing.statusCode).toBe(400);
    expect(user("u_simon").role).toBe("electrician");

    const ok = await changeRole("u_simon", { role: "apprentice", apprenticeYear: 2 });
    expect(ok.statusCode).toBe(200);
    expect(user("u_simon").role).toBe("apprentice");
    expect(user("u_simon").apprenticeYear).toBe(2);
    expect(rowOf(ok).apprenticeYear).toBe(2);

    // Leaving apprentice clears the year.
    await changeRole("u_simon", { role: "pm" });
    expect(user("u_simon").apprenticeYear).toBeUndefined();
  });

  it("audits a real change with from → to", async () => {
    await changeRole("u_simon", { role: "pm" });
    expect(auditAppend).toHaveBeenCalledTimes(1);
    expect(auditAppend.mock.calls[0]![0]).toMatchObject({
      action: "employee.role_changed",
      targetId: "u_simon",
      summary: "Role changed electrician → pm",
      metadata: { from: "electrician", to: "pm", userId: "u_simon" },
    });
  });

  it("asking for the role someone already has writes nothing", async () => {
    const res = await changeRole("u_simon", { role: "electrician" });
    expect(res.statusCode).toBe(200);
    expect(writeBlob).not.toHaveBeenCalled();
    expect(auditAppend).not.toHaveBeenCalled();
  });

  it("a drifted HR row never hides a login that still carries the old role", async () => {
    // The trap PATCH can leave behind: HR row says pm, login still electrician.
    const emps = store.get("employees.json") as Employees;
    emps.employees.find((e) => e.id === "e_alfredo")!.role = "pm";
    const res = await changeRole("e_alfredo", { role: "pm" });
    expect(res.statusCode).toBe(200);
    expect(user("u_alfredo").role).toBe("pm");
  });
});

describe("POST /api/employees?action=role — refusals", () => {
  it("refuses changing your own role", async () => {
    const res = await changeRole("u_admin", { role: "pm" });
    expect(res.statusCode).toBe(400);
    expect(user("u_admin").role).toBe("admin");
  });

  it("refuses an unknown role", async () => {
    const res = await changeRole("u_simon", { role: "wizard" });
    expect(res.statusCode).toBe(400);
    expect(user("u_simon").role).toBe("electrician");
  });

  it("a client login is not an employee", async () => {
    const res = await changeRole("u_client", { role: "pm" });
    expect(res.statusCode).toBe(404);
    expect(user("u_client").role).toBe("client");
  });

  it("refuses demoting the last active admin", async () => {
    // The env-only owner is the actor — the one way the last stored admin can
    // be someone other than the person asking.
    const res = await changeRole("u_admin", { role: "electrician" }, cookieFor("__owner__", "owner"));
    expect(res.statusCode).toBe(409);
    expect(user("u_admin").role).toBe("admin");
  });

  it("field workers can't change anyone's role", async () => {
    const res = await changeRole("u_alfredo", { role: "admin" }, cookieFor("u_simon", "electrician"));
    expect(res.statusCode).toBe(403);
    expect(user("u_alfredo").role).toBe("electrician");
  });
});
