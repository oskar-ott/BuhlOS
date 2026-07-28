import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Crew sign-up link — INSTANT ACCESS (founder decision 2026-07-28), against
 * the REAL handlers with an in-memory blob:
 *
 *   · POST /api/signup?action=submit creates the users.json login + the
 *     employees.json row IMMEDIATELY and stamps the request row approved
 *     (reviewedBy = the auto sentinel, pinHash nulled — credentials never
 *     linger in the queue).
 *   · The new account can sign in with email + PIN straight away (api/auth.js).
 *   · The link's own gates are unweakened: cap counts instant (approved)
 *     accounts exactly as before, paused refuses, duplicate email refuses,
 *     and the whole surface stays dark behind `signup_link`.
 *   · The admin approve action still works for leftover pre-instant pending
 *     rows — same single writer (api/_lib/signup-account.js), no divergence.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const authLibPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const signupAccountPath = requireFromHere.resolve("../../../api/_lib/signup-account.js");
const signupPath = requireFromHere.resolve("../../../api/signup.js");
const employeesPath = requireFromHere.resolve("../../../api/employees.js");
const authApiPath = requireFromHere.resolve("../../../api/auth.js");
const bcrypt = requireFromHere("bcryptjs") as {
  hashSync: (s: string, rounds: number) => string;
  compareSync: (s: string, hash: string) => boolean;
};

type Res = ReturnType<typeof createRes>;
let store: Map<string, unknown>;
let auditAppend: ReturnType<typeof vi.fn>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let signupHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let employeesHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;
let authHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

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

function submitBody(over: Record<string, unknown> = {}) {
  return {
    code: "CREWCODE",
    firstName: "Alfredo",
    lastName: "Reyes",
    preferredName: null,
    email: "alfredo.reyes@gmail.com",
    mobile: "0400 111 222",
    role: "electrician",
    apprenticeYear: null,
    legalName: "Alfredo Reyes Garcia",
    dob: "1998-03-14",
    startYear: null,
    pin: "8053",
    confirmPin: "8053",
    ...over,
  };
}

async function submit(over: Record<string, unknown> = {}) {
  const res = createRes();
  await signupHandler(
    { method: "POST", query: { action: "submit" }, body: submitBody(over), headers: {} },
    res,
  );
  return res;
}

async function login(username: string, secret: string) {
  const res = createRes();
  await authHandler(
    { method: "POST", query: { action: "login" }, body: { username, secret }, headers: {} },
    res,
  );
  return res;
}

function users(): Array<Record<string, unknown>> {
  return (store.get("users.json") as { users: Array<Record<string, unknown>> }).users;
}
function employees(): Array<Record<string, unknown>> {
  return ((store.get("employees.json") as { employees?: Array<Record<string, unknown>> })?.employees) ?? [];
}
function requests(): Array<Record<string, unknown>> {
  return (store.get("signup-requests.json") as { requests: Array<Record<string, unknown>> }).requests;
}
function link(): Record<string, unknown> {
  return (store.get("signup-links.json") as { links: Array<Record<string, unknown>> }).links[0]!;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.FLAG_SIGNUP_LINK = "1";
  process.env.FLAG_EMPLOYEES = "1";
  delete process.env.RESEND_API_KEY; // email dark → welcomeSent stays false
  delete process.env.EMAIL_FROM;
  delete process.env.OWNER_PASSWORD_HASH;

  store = new Map<string, unknown>([
    [
      "users.json",
      {
        users: [
          { id: "u_admin", username: "boss", role: "admin", passwordHash: "$2a$10$x", assignedJobIds: [] },
          { id: "u_taken", username: "taken", email: "taken@gmail.com", role: "electrician", passwordHash: "$2a$10$x" },
        ],
      },
    ],
    ["employees.json", { employees: [{ id: "e_books", firstName: "Ona", lastName: "Books", email: "onbooks@gmail.com", userId: null }] }],
    [
      "signup-links.json",
      {
        links: [
          {
            id: "sl_1",
            code: "CREWCODE",
            status: "active",
            expiresAt: "2027-01-01T00:00:00.000Z",
            cap: null,
            createdAt: "2026-07-01T00:00:00.000Z",
            createdBy: "u_admin",
            createdByName: "boss",
          },
        ],
      },
    ],
    ["signup-requests.json", { requests: [] }],
  ]);

  auditAppend = vi.fn(async () => {});
  for (const p of [authLibPath, signupAccountPath, signupPath, employeesPath, authApiPath]) {
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
    exports: { append: auditAppend },
  } as NodeJS.Module;

  auth = requireFromHere(authLibPath);
  signupHandler = requireFromHere(signupPath);
  employeesHandler = requireFromHere(employeesPath);
  authHandler = requireFromHere(authApiPath);
});

afterEach(() => {
  delete process.env.FLAG_SIGNUP_LINK;
  delete process.env.FLAG_EMPLOYEES;
});

describe("POST /api/signup?action=submit — instant access", () => {
  it("creates the login + employee row immediately and marks the request approved", async () => {
    const res = await submit();
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, state: "approved", canSignIn: true });

    const u = users().find((x) => x.username === "alfredo.reyes@gmail.com");
    expect(u).toBeTruthy();
    expect(u!.createdVia).toBe("signup-link");
    expect(u!.email).toBe("alfredo.reyes@gmail.com");
    expect(bcrypt.compareSync("8053", u!.passwordHash as string)).toBe(true);

    const e = employees().find((x) => x.email === "alfredo.reyes@gmail.com");
    expect(e).toBeTruthy();
    expect(e!.source).toBe("signup-link");
    expect(e!.userId).toBe(u!.id);
    expect(e!.appAccess).toBe("phil");
    expect(e!.legalName).toBe("Alfredo Reyes Garcia");
    expect((e!.setup as { loginCreated: boolean }).loginCreated).toBe(true);
    expect(e!.createdBy).toBe("signup-link:auto");

    // The queue keeps the row as joined-via-link history — approved by the
    // sentinel, with NO lingering credentials.
    const r = requests().find((x) => x.email === "alfredo.reyes@gmail.com");
    expect(r).toBeTruthy();
    expect(r!.status).toBe("approved");
    expect(r!.reviewedBy).toBe("signup-link:auto");
    expect(r!.reviewedAt).toBeTruthy();
    expect(r!.pinHash).toBeNull();

    // The audit trail tells the whole story: submitted + auto-approved + activated.
    const actions = auditAppend.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toContain("signup.submitted");
    expect(actions).toContain("signup.approved");
    expect(actions).toContain("employee.activated");
  });

  it("start year: a plausible year lands on the employee row; a rubbish one refuses", async () => {
    const bad = await submit({ startYear: 1899 });
    expect(bad.statusCode).toBe(400);
    expect((bad.body as { error: string }).error).toContain("Start year");

    const res = await submit({ startYear: 2024 });
    expect(res.statusCode).toBe(200);
    const e = employees().find((x) => x.email === "alfredo.reyes@gmail.com");
    expect(e!.startYear).toBe(2024);
    expect(e!.startDate).toBeNull();
  });

  it("the new account signs in with email + PIN straight away", async () => {
    expect((await submit()).statusCode).toBe(200);
    const r = await login("alfredo.reyes@gmail.com", "8053");
    expect(r.statusCode).toBe(200);
    expect((r.body as { user: { username: string; passwordHash?: string } }).user.username).toBe(
      "alfredo.reyes@gmail.com",
    );
    expect((r.body as { user: { passwordHash?: string } }).user.passwordHash).toBeUndefined();
  });

  it("the cap counts instant accounts exactly as approved rows counted before", async () => {
    link().cap = 1;
    expect((await submit()).statusCode).toBe(200);
    const second = await submit({ email: "second.sparky@gmail.com", firstName: "Sana", lastName: "Second" });
    expect(second.statusCode).toBe(409);
    expect((second.body as { error: string }).error).toContain("hit its sign-up limit");
    expect(users().some((u) => u.username === "second.sparky@gmail.com")).toBe(false);
  });

  it("a paused link still refuses — the admin controls are unweakened", async () => {
    link().status = "paused";
    const res = await submit();
    expect(res.statusCode).toBe(409);
    expect((res.body as { error: string }).error).toContain("paused");
    expect(users().some((u) => u.username === "alfredo.reyes@gmail.com")).toBe(false);
  });

  it("duplicate emails still refuse: existing login, existing employee, and a replayed submit", async () => {
    const dupUser = await submit({ email: "taken@gmail.com" });
    expect(dupUser.statusCode).toBe(409);
    expect((dupUser.body as { reason: string }).reason).toBe("existing_account");

    const dupEmployee = await submit({ email: "onbooks@gmail.com" });
    expect(dupEmployee.statusCode).toBe(409);
    expect((dupEmployee.body as { reason: string }).reason).toBe("existing_employee");

    // After an instant signup the same email is an existing ACCOUNT — a
    // double-tap replay can never create two logins.
    expect((await submit()).statusCode).toBe(200);
    const replay = await submit();
    expect(replay.statusCode).toBe(409);
    expect((replay.body as { reason: string }).reason).toBe("existing_account");
    expect(users().filter((u) => u.username === "alfredo.reyes@gmail.com")).toHaveLength(1);
    expect(requests().filter((r) => r.email === "alfredo.reyes@gmail.com")).toHaveLength(1);
  });

  it("stays dark behind the signup_link flag", async () => {
    process.env.FLAG_SIGNUP_LINK = "0";
    const res = await submit();
    expect(res.statusCode).toBe(404);
    expect(users().some((u) => u.username === "alfredo.reyes@gmail.com")).toBe(false);
  });
});

describe("POST /api/employees?action=signup-approve — leftover pending rows", () => {
  it("the admin approve action still creates the account via the same writer", async () => {
    const pinHash = bcrypt.hashSync("4487", 4);
    (store.get("signup-requests.json") as { requests: unknown[] }).requests.push({
      id: "sr_legacy",
      linkId: "sl_1",
      status: "pending",
      firstName: "Old",
      lastName: "Pending",
      preferredName: null,
      email: "old.pending@gmail.com",
      mobile: "+61400333444",
      role: "apprentice",
      apprenticeYear: 2,
      legalName: "Old Pending",
      dob: "1999-01-20",
      startDate: null,
      pinHash,
      submittedAt: "2026-07-20T00:00:00.000Z",
      reviewedAt: null,
      reviewedBy: null,
      rejectReason: null,
    });

    const res = createRes();
    await employeesHandler(
      {
        method: "POST",
        query: { action: "signup-approve", id: "sr_legacy" },
        body: {},
        headers: {
          cookie: `buhl_session=${auth.signSession({ userId: "u_admin", role: "admin", exp: Date.now() + 60_000 })}`,
        },
      },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, welcomeSent: false });

    const u = users().find((x) => x.username === "old.pending@gmail.com");
    expect(u).toBeTruthy();
    const e = employees().find((x) => x.email === "old.pending@gmail.com");
    expect(e).toBeTruthy();
    expect(e!.source).toBe("signup-link");
    expect(e!.apprenticeYear).toBe(2);
    expect(e!.createdBy).toBe("u_admin");

    const r = requests().find((x) => x.id === "sr_legacy");
    expect(r!.status).toBe("approved");
    expect(r!.reviewedBy).toBe("u_admin");
    expect(r!.pinHash).toBeNull();

    // …and that account signs in with email + PIN like any other.
    expect((await login("old.pending@gmail.com", "4487")).statusCode).toBe(200);
  });
});
