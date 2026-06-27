import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #337 — GET /api/crew-week. Admin-tier only; per-worker per-day leave/assigned/
 * free over a week. Approved leave only; current-state assignment; non-field /
 * disabled excluded.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const leaveLibPath = requireFromHere.resolve("../../../api/_lib/leave.js");
const crewLibPath = requireFromHere.resolve("../../../api/_lib/crew-week.js");
const handlerPath = requireFromHere.resolve("../../../api/crew-week.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

function clone<T>(v: T): T { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
function createRes() {
  return {
    statusCode: 200, body: null as unknown,
    status(c: number) { this.statusCode = c; return this; },
    json(b: unknown) { this.body = b; return this; },
    setHeader() { return this; }, end() { return this; },
  };
}
function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}
async function call(opts: { role: string; userId?: string; query?: Record<string, string> }): Promise<Res> {
  const res = createRes();
  await handler({ method: "GET", query: opts.query || {}, headers: { cookie: cookieFor(opts.userId || "u_admin", opts.role) }, body: undefined }, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    ["users.json", { users: [
      { id: "u_admin", username: "boss", role: "admin", assignedJobIds: [] },
      { id: "u_field", username: "Sparky", role: "electrician", assignedJobIds: ["job-a"] },
      { id: "u_free", username: "Mate", role: "tradie", assignedJobIds: [] },
      { id: "u_gone", username: "Ex", role: "electrician", disabled: true, assignedJobIds: ["job-a"] },
    ] }],
    ["jobs.json", { jobs: [{ id: "job-a", name: "100 Arthur" }] }],
    ["leave-requests.json", { requests: [
      { id: "l1", userId: "u_field", userName: "Sparky", type: "annual", fromDate: "2026-06-24", toDate: "2026-06-24", status: "approved" },
      { id: "l2", userId: "u_field", type: "sick", fromDate: "2026-06-25", toDate: "2026-06-25", status: "pending" }, // omitted
    ] }],
  ]);
  for (const p of [authPath, handlerPath, leaveLibPath, crewLibPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fb: unknown) => (blob.has(key) ? clone(blob.get(key)) : fb)),
      writeBlob: vi.fn(async () => {}),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

describe("GET /api/crew-week (#337)", () => {
  it("403s a non-admin", async () => {
    expect((await call({ role: "electrician", userId: "u_field", query: { weekStart: "2026-06-22" } })).statusCode).toBe(403);
  });

  it("projects per-day leave (approved) / assigned (current) / free, excluding non-field + disabled", async () => {
    const res = await call({ role: "admin", query: { weekStart: "2026-06-22" } });
    expect(res.statusCode).toBe(200);
    const b = res.body as {
      weekStart: string; weekDays: string[];
      workers: Array<{ id: string; assignedJobNames: string[]; days: Array<{ date: string; state: string; leaveType: string | null }> }>;
    };
    expect(b.weekStart).toBe("2026-06-22");
    expect(b.weekDays).toHaveLength(7);
    // admin + disabled excluded; field + free worker remain.
    expect(b.workers.map((w) => w.id).sort()).toEqual(["u_field", "u_free"]);

    const sparky = b.workers.find((w) => w.id === "u_field")!;
    expect(sparky.assignedJobNames).toEqual(["100 Arthur"]);
    expect(sparky.days[0]).toMatchObject({ date: "2026-06-22", state: "assigned" }); // Mon
    expect(sparky.days[2]).toMatchObject({ date: "2026-06-24", state: "leave", leaveType: "annual" }); // Wed approved leave
    expect(sparky.days[3]).toMatchObject({ date: "2026-06-25", state: "assigned" }); // Thu — pending leave omitted

    const mate = b.workers.find((w) => w.id === "u_free")!;
    expect(mate.days.every((d) => d.state === "free")).toBe(true);
  });
});
