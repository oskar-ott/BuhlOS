import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * BuhlOS-issued job numbers (#1152, job_code_auto — dark), through the REAL
 * api/jobs.js handler and the REAL createJob. Blob is in memory; the Postgres
 * side of api/_lib/job-codes.js (`connect`) is replaced by an in-memory
 * counter + claims that follow the same rules and can be made to fail. The
 * real SQL is covered by job-codes.pg.test.ts.
 *
 * What it defends:
 *   - flag OFF ⇒ exactly the behaviour before the flag: the number store is
 *     never touched, a create with no code has no code, the phone still
 *     requires one.
 *   - flag ON  ⇒ a create with no code gets the next number, on the office
 *     form and the phone; nothing is ever created with a made-up number; a
 *     refused create or a retry never uses a number up; a typed number still
 *     works, even with the number store down.
 *   - a job with no number can be given one ONCE, by the office.
 */
const requireFromHere = createRequire(import.meta.url);
const resolve = (p: string) => requireFromHere.resolve(p);
const blobPath = resolve("../../../api/_lib/blob.js");
const codesPath = resolve("../../../api/_lib/job-codes.js");
const fresh = [
  "../../../api/_lib/auth.js",
  "../../../api/jobs.js",
  "../../../api/_lib/job-redaction.js",
  "../../../api/_lib/job-audit.js",
  "../../../api/_lib/feature-flags.js",
  "../../../api/_lib/jobs-summary.js",
  "../../../api/_lib/job-detail-projection.js",
  "../../../api/_lib/audit-log.js",
  "../../../api/_lib/job-create.js",
].map(resolve);

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let failJobsWrite: boolean;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

/** The in-memory stand-in for the Postgres number store. */
let store: {
  next: number;
  claims: Map<string, { jobId: string | null; source: string }>;
  down: boolean;
  calls: string[];
};

function clone<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}
function createRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
}
async function call(method: string, userId: string, role: string, body: unknown): Promise<Res> {
  const res = createRes();
  const cookie = `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
  await handler({ method, query: {}, body, headers: { cookie } }, res);
  return res;
}
const post = (userId: string, role: string, body: unknown) => call("POST", userId, role, body);
const put = (userId: string, role: string, body: unknown) => call("PUT", userId, role, body);
const jobs = () => (blob.get("jobs.json") as { jobs: Array<Record<string, unknown>> }).jobs;
const job = (id: string) => jobs().find((j) => j.id === id);
const users = () => (blob.get("users.json") as { users: Array<{ id: string; assignedJobIds: string[] }> }).users;
const created = (res: Res) => (res.body as { job: { id: string; code?: string | null; name: string } }).job;
const errorOf = (res: Res) => (res.body as { error: string }).error;

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  failJobsWrite = false;
  blob = new Map<string, unknown>([
    ["users.json", { users: [
      { id: "u_admin", username: "admin", name: "Karen Boss", role: "admin", assignedJobIds: [] },
      { id: "u_field", username: "sparky", role: "electrician", assignedJobIds: [] },
      { id: "u_field2", username: "mate", role: "electrician", assignedJobIds: [] },
      { id: "u_lh", username: "lead", role: "lh", assignedJobIds: ["old-job"] },
    ] }],
    ["jobs.json", { jobs: [
      { id: "sm-job", name: "ServiceM8 job", status: "active", code: "IV3345" },
      { id: "phone-job", name: "Old phone job", status: "active", code: "IV7001" },
      { id: "old-job", name: "Old job with no number", status: "active" },
    ] }],
  ]);
  store = { next: 4000, claims: new Map(), down: false, calls: [] };

  for (const p of fresh) delete requireFromHere.cache[p];
  delete requireFromHere.cache[codesPath];
  const real = requireFromHere(codesPath);
  const boom = () => { throw new real.JobCodeError("unavailable"); };
  requireFromHere.cache[codesPath] = {
    id: codesPath, filename: codesPath, loaded: true,
    exports: {
      ...real,
      connect: () => ({
        issue: async (o: { existingCodes?: string[]; jobId?: string | null }) => {
          store.calls.push("issue");
          if (store.down) boom();
          const used = real.usedNumbers(o.existingCodes);
          let n = store.next;
          while (n <= real.LAST && (used.has(n) || store.claims.has(real.codeOf(n)))) n += 1;
          if (n > real.LAST) throw new real.JobCodeError("range_exhausted");
          store.claims.set(real.codeOf(n), { jobId: o.jobId ?? null, source: "issued" });
          store.next = n + 1;
          return real.codeOf(n);
        },
        claimTyped: async (code: string, o: { jobId?: string | null }) => {
          store.calls.push(`claim:${code}`);
          if (store.down) boom();
          const held = store.claims.get(code);
          if (!held) { store.claims.set(code, { jobId: o.jobId ?? null, source: "typed" }); return { ok: true, fresh: true }; }
          return held.jobId === o.jobId ? { ok: true, fresh: false } : { ok: false, heldBy: held.jobId };
        },
        release: async (code: string, jobId: string) => {
          store.calls.push(`release:${code}`);
          const held = store.claims.get(code);
          if (held && held.source === "typed" && held.jobId === jobId) store.claims.delete(code);
        },
      }),
    },
  } as NodeJS.Module;
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) => (blob.has(key) ? clone(blob.get(key)) : fallback)),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        if (key === "jobs.json" && failJobsWrite) throw new Error("blob down");
        blob.set(key, clone(data));
      }),
      deleteBlob: vi.fn(async (key: string) => { blob.delete(key); }),
      setNoCache: vi.fn(),
      blobUploadedAt: vi.fn(async () => "T1"),
    },
  } as NodeJS.Module;
  auth = requireFromHere(resolve("../../../api/_lib/auth.js"));
  handler = requireFromHere(resolve("../../../api/jobs.js"));
});

afterEach(() => {
  delete process.env.FLAG_JOB_CODE_AUTO;
  delete process.env.FLAG_PHIL_SHARPENED;
  delete requireFromHere.cache[codesPath];
});

describe("flag OFF — exactly as before, and the number store is never touched", () => {
  it("an office create with no IV number has no number", async () => {
    const res = await post("u_admin", "admin", { name: "Plain job" });
    expect(res.statusCode).toBe(200);
    expect(created(res).code ?? null).toBeNull();
    expect(job("plain-job")).not.toHaveProperty("code");
  });

  it("a typed number works and is clash-checked against the jobs, as always", async () => {
    expect(created(await post("u_admin", "admin", { name: "Typed", code: "iv4100" })).code).toBe("IV4100");
    const dup = await post("u_admin", "admin", { name: "Typed again", code: "IV3345" });
    expect(dup.statusCode).toBe(409);
    expect(errorOf(dup)).toContain("ServiceM8 job");
  });

  it("the phone still requires a number", async () => {
    process.env.FLAG_PHIL_SHARPENED = "true";
    const res = await post("u_field", "electrician", { name: "Site" });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toContain("IV followed by 4 digits");
    expect(job("site")).toBeUndefined();
  });

  it("giving an old job a number is not available", async () => {
    const res = await put("u_admin", "admin", { id: "old-job", issueCode: true });
    expect(res.statusCode).toBe(404);
    expect(job("old-job")).not.toHaveProperty("code");
  });

  afterEach(() => {
    expect(store.calls).toEqual([]);
  });
});

describe("flag ON — the office form", () => {
  beforeEach(() => { process.env.FLAG_JOB_CODE_AUTO = "true"; });

  it("a create with no IV number gets the next one, starting at IV4000", async () => {
    const a = await post("u_admin", "admin", { name: "First" });
    expect(a.statusCode).toBe(200);
    expect(created(a).code).toBe("IV4000");
    expect(job("first")).toMatchObject({ code: "IV4000" });
    expect(created(await post("u_admin", "admin", { name: "Second", code: "" })).code).toBe("IV4001");
    expect(created(await post("u_admin", "admin", { name: "Third", code: null })).code).toBe("IV4002");
    expect(store.claims.get("IV4000")).toEqual({ jobId: "first", source: "issued" });
  });

  it("skips a number already on a job, however it got there", async () => {
    jobs().push({ id: "typed-early", name: "Typed early", status: "active", code: "IV4000" }, { id: "x", name: "X", status: "archived", code: "iv4001" });
    expect(created(await post("u_admin", "admin", { name: "Next" })).code).toBe("IV4002");
  });

  it("a typed number still works, is claimed, and can't then be issued", async () => {
    expect(created(await post("u_admin", "admin", { name: "Typed", code: "IV4000" })).code).toBe("IV4000");
    expect(store.claims.get("IV4000")).toEqual({ jobId: "typed", source: "typed" });
    // even if jobs.json were read stale, the claim keeps the issuer off it
    jobs().splice(jobs().findIndex((j) => j.id === "typed"), 1);
    expect(created(await post("u_admin", "admin", { name: "Issued" })).code).toBe("IV4001");
  });

  it("a typed number another job has claimed is refused — nothing is created", async () => {
    store.claims.set("IV4050", { jobId: "someone-elses", source: "typed" });
    const res = await post("u_admin", "admin", { name: "Clash", code: "IV4050" });
    expect(res.statusCode).toBe(409);
    expect(errorOf(res)).toBe("code IV4050 is already in use — pick another");
    expect(job("clash")).toBeUndefined();
  });

  it("NO NUMBER, NO JOB: when one can't be issued the create fails plainly and nothing is written", async () => {
    store.down = true;
    const before = clone(blob.get("jobs.json"));
    const res = await post("u_admin", "admin", { name: "Unlucky" });
    expect(res.statusCode).toBe(503);
    expect(errorOf(res)).toBe("Couldn't get the next job number just now, so nothing was created. Try again, or type a job number instead.");
    expect(blob.get("jobs.json")).toEqual(before);
    expect(blob.has("jobs/unlucky/data.json")).toBe(false);
  });

  it("…and typing a number still works while the number store is down", async () => {
    store.down = true;
    const res = await post("u_admin", "admin", { name: "Typed anyway", code: "IV4200" });
    expect(res.statusCode).toBe(200);
    expect(job("typed-anyway")).toMatchObject({ code: "IV4200" });
    // the jobs.json clash check is still the backstop
    expect((await post("u_admin", "admin", { name: "Typed twice", code: "IV4200" })).statusCode).toBe(409);
  });

  it("says so when every number is used", async () => {
    store.next = 10000;
    const res = await post("u_admin", "admin", { name: "Too late" });
    expect(res.statusCode).toBe(503);
    expect(errorOf(res)).toContain("up to IV9999 are used");
    expect(job("too-late")).toBeUndefined();
  });

  it("a create refused for any other reason never uses a number up", async () => {
    expect((await post("u_admin", "admin", { name: "Sm job" })).statusCode).toBe(400); // name taken (same id)
    expect((await post("u_admin", "admin", { name: "Bad status", status: "archived" })).statusCode).toBe(400);
    expect((await post("u_admin", "admin", { name: "Bad code", code: "7001" })).statusCode).toBe(400);
    expect(store.calls).toEqual([]);
    expect(created(await post("u_admin", "admin", { name: "Fine" })).code).toBe("IV4000");
  });

  it("if the job can't be saved, a typed number is given back; an issued one stays used", async () => {
    failJobsWrite = true;
    expect((await post("u_admin", "admin", { name: "Typed", code: "IV4300" })).statusCode).toBe(500);
    expect(store.claims.has("IV4300")).toBe(false);
    expect((await post("u_admin", "admin", { name: "Issued" })).statusCode).toBe(500);
    expect(store.claims.get("IV4000")).toEqual({ jobId: "issued", source: "issued" });
    failJobsWrite = false;
    expect(created(await post("u_admin", "admin", { name: "After" })).code).toBe("IV4001");
    expect(created(await post("u_admin", "admin", { name: "Typed", code: "IV4300" })).code).toBe("IV4300");
  });
});

describe("flag ON — the phone (\"+ New job\")", () => {
  beforeEach(() => {
    process.env.FLAG_JOB_CODE_AUTO = "true";
    process.env.FLAG_PHIL_SHARPENED = "true";
  });

  it("a worker creates a job with just a name and gets the next number; the job is on their list", async () => {
    const res = await post("u_field", "electrician", { name: "Smith St rewire", siteAddress: "12 Smith St" });
    expect(res.statusCode).toBe(200);
    expect(created(res)).toMatchObject({ id: "smith-st-rewire", code: "IV4000" });
    expect(job("smith-st-rewire")).toMatchObject({ code: "IV4000", status: "active", createdByUserId: "u_field", siteAddress: "12 Smith St" });
    expect(users().find((u) => u.id === "u_field")!.assignedJobIds).toContain("smith-st-rewire");
  });

  it("two workers get two different numbers", async () => {
    const [a, b] = await Promise.all([
      post("u_field", "electrician", { name: "Job A" }),
      post("u_field2", "electrician", { name: "Job B" }),
    ]);
    expect([created(a).code, created(b).code].sort()).toEqual(["IV4000", "IV4001"]);
  });

  it("a retry of a create that already landed returns the same job and the same number", async () => {
    const first = await post("u_field", "electrician", { name: "Smith St rewire" });
    const again = await post("u_field", "electrician", { name: "  smith st REWIRE " });
    expect(again.statusCode).toBe(200);
    expect(created(again)).toMatchObject({ id: created(first).id, code: "IV4000" });
    expect(jobs().filter((j) => j.id === "smith-st-rewire")).toHaveLength(1);
    expect(store.calls).toEqual(["issue"]); // one number, not two
  });

  it("someone else's job with that name is not handed over — and no number is used", async () => {
    await post("u_field", "electrician", { name: "Smith St rewire" });
    const res = await post("u_field2", "electrician", { name: "Smith St rewire" });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toBe("a job with that name already exists — use a different name");
    expect(store.calls).toEqual(["issue"]);
  });

  it("a typed number (the ServiceMate side) still works and is still format-checked", async () => {
    expect(created(await post("u_field", "electrician", { name: "From ServiceMate", code: "IV3400" })).code).toBe("IV3400");
    expect((await post("u_field", "electrician", { name: "Bad", code: "3400" })).statusCode).toBe(400);
    const dup = await post("u_field2", "electrician", { name: "Dup", code: "IV3345" });
    expect(dup.statusCode).toBe(409);
    expect(errorOf(dup)).not.toContain("ServiceM8 job"); // never names a job the worker may not see
  });

  it("when no number can be issued the worker is told, and nothing is created or put on their list", async () => {
    store.down = true;
    const res = await post("u_field", "electrician", { name: "Unlucky" });
    expect(res.statusCode).toBe(503);
    expect(errorOf(res)).toContain("nothing was created");
    expect(job("unlucky")).toBeUndefined();
    expect(users().find((u) => u.id === "u_field")!.assignedJobIds).toEqual([]);
  });

  it("the phone still can't send anything but name, number and address", async () => {
    const res = await post("u_field", "electrician", { name: "Sneaky", contractValue: 99, status: "draft" });
    expect(res.statusCode).toBe(200);
    expect(job("sneaky")).toMatchObject({ status: "active", code: "IV4000" });
    expect(job("sneaky")).not.toHaveProperty("contractValue");
  });
});

describe("flag ON — giving an older job its number, once", () => {
  beforeEach(() => { process.env.FLAG_JOB_CODE_AUTO = "true"; });

  it("the office gives a job with no number the next one", async () => {
    const res = await put("u_admin", "admin", { id: "old-job", issueCode: true });
    expect(res.statusCode).toBe(200);
    expect(created(res).code).toBe("IV4000");
    expect(job("old-job")).toMatchObject({ code: "IV4000", name: "Old job with no number" });
    expect(store.claims.get("IV4000")).toEqual({ jobId: "old-job", source: "issued" });
    const audit = blob.get("jobs/old-job/audit.json") as { entries: Array<{ summary: string }> } | undefined;
    expect(JSON.stringify(audit ?? {})).toContain("Job number IV4000 issued by BuhlOS");
  });

  it("a job's number is never changed: a second ask, or a job that already has one, is refused", async () => {
    await put("u_admin", "admin", { id: "old-job", issueCode: true });
    const again = await put("u_admin", "admin", { id: "old-job", issueCode: true });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again)).toContain("already has a number (IV4000)");
    expect((await put("u_admin", "admin", { id: "sm-job", issueCode: true })).statusCode).toBe(409);
    expect(job("sm-job")).toMatchObject({ code: "IV3345" });
    expect(store.calls).toEqual(["issue"]);
  });

  it("only the office tier, only that one instruction", async () => {
    expect((await put("u_lh", "lh", { id: "old-job", issueCode: true })).statusCode).toBe(403);
    expect((await put("u_field", "electrician", { id: "old-job", issueCode: true })).statusCode).toBe(403);
    expect((await put("u_admin", "admin", { id: "old-job", issueCode: true, code: "IV0001" })).statusCode).toBe(400);
    expect((await put("u_admin", "admin", { id: "old-job", issueCode: true, name: "Renamed" })).statusCode).toBe(400);
    expect((await put("u_admin", "admin", { id: "old-job", issueCode: "yes" })).statusCode).toBe(400);
    expect((await put("u_admin", "admin", { id: "nope", issueCode: true })).statusCode).toBe(404);
    expect(job("old-job")).toEqual({ id: "old-job", name: "Old job with no number", status: "active" });
    expect(store.calls).toEqual([]);
  });

  it("a number can't be chosen or changed through an ordinary edit", async () => {
    const res = await put("u_admin", "admin", { id: "old-job", name: "Old job with no number", code: "IV0001" });
    expect(res.statusCode).toBeLessThan(500);
    expect(job("old-job")).not.toHaveProperty("code");
    await put("u_admin", "admin", { id: "sm-job", name: "ServiceM8 job", code: "IV9999" });
    expect(job("sm-job")).toMatchObject({ code: "IV3345" });
  });

  it("when no number can be issued, the job is left exactly as it was", async () => {
    store.down = true;
    const res = await put("u_admin", "admin", { id: "old-job", issueCode: true });
    expect(res.statusCode).toBe(503);
    expect(errorOf(res)).toBe("Couldn't get the next job number just now. Nothing was changed — try again.");
    expect(job("old-job")).toEqual({ id: "old-job", name: "Old job with no number", status: "active" });
  });
});
