import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #240 — the quote delivery-lifecycle actions on /api/quotes. Admin-tier only;
 * mark-sent / mark-viewed append events; GET ?action=delivery + the full bundle
 * both return the derived deliveryState.
 */
const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const deliveryLibPath = requireFromHere.resolve("../../../api/_lib/quote-delivery.js");
const handlerPath = requireFromHere.resolve("../../../api/quotes.js");

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
async function call(opts: { method?: string; role: string; userId?: string; query?: Record<string, string>; body?: unknown }): Promise<Res> {
  const res = createRes();
  await handler({ method: opts.method || "GET", query: opts.query || {}, body: opts.body, headers: { cookie: cookieFor(opts.userId || "u_admin", opts.role) } }, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>([
    ["users.json", { users: [
      { id: "u_admin", username: "boss", role: "admin" },
      { id: "u_field", username: "sparky", role: "electrician" },
    ] }],
    ["quotes.json", { quotes: [{ id: "q1", name: "Tender A", status: "submitted", version: 1, createdAt: "2026-06-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z" }] }],
  ]);
  for (const p of [authPath, handlerPath, deliveryLibPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath, filename: blobPath, loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fb: unknown) => (blob.has(key) ? clone(blob.get(key)) : fb)),
      writeBlob: vi.fn(async (key: string, data: unknown) => { blob.set(key, clone(data)); }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  auth = requireFromHere(authPath);
  handler = requireFromHere(handlerPath);
});

const quoteRec = () => (blob.get("quotes.json") as { quotes: Array<{ id: string; delivery?: { sentEvents?: unknown[]; viewedEvents?: unknown[] } }> }).quotes[0]!;

describe("quote delivery lifecycle (#240)", () => {
  it("403s a non-admin on mark-sent", async () => {
    expect((await call({ method: "POST", role: "electrician", userId: "u_field", query: { action: "mark-sent", id: "q1" }, body: { at: "2026-06-02", recipient: "c@x" } })).statusCode).toBe(403);
  });

  it("mark-sent requires a recipient + date", async () => {
    expect((await call({ method: "POST", role: "admin", query: { action: "mark-sent", id: "q1" }, body: { at: "2026-06-02" } })).statusCode).toBe(400);
  });

  it("records a send → state sent, then a manual view → state viewed", async () => {
    const sent = await call({ method: "POST", role: "admin", query: { action: "mark-sent", id: "q1" }, body: { at: "2026-06-02", recipient: "client@x", method: "email" } });
    expect(sent.statusCode).toBe(200);
    expect((sent.body as { deliveryState: { state: string; recipient: string } }).deliveryState).toMatchObject({ state: "sent", recipient: "client@x" });
    expect(quoteRec().delivery?.sentEvents).toHaveLength(1);

    const viewed = await call({ method: "POST", role: "admin", query: { action: "mark-viewed", id: "q1" }, body: {} });
    expect(viewed.statusCode).toBe(200);
    expect((viewed.body as { deliveryState: { state: string } }).deliveryState.state).toBe("viewed");
    expect(quoteRec().delivery?.viewedEvents).toHaveLength(1);
  });

  it("GET ?action=delivery returns the lifecycle; the full bundle includes deliveryState", async () => {
    await call({ method: "POST", role: "admin", query: { action: "mark-sent", id: "q1" }, body: { at: "2026-06-02", recipient: "c@x", method: "email" } });
    const d = await call({ role: "admin", query: { action: "delivery", id: "q1" } });
    expect(d.statusCode).toBe(200);
    expect((d.body as { deliveryState: { state: string } }).deliveryState.state).toBe("sent");

    const bundle = await call({ role: "admin", query: { id: "q1" } });
    expect(bundle.statusCode).toBe(200);
    expect((bundle.body as { deliveryState: { state: string } }).deliveryState.state).toBe("sent");
  });
});
