import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/notifications?action=subscribe (2026-11-01, "it's really slow to
 * use"). Every shell mount re-sends the device's push subscription. It used to
 * rewrite the whole users.json each time (a ~1.4 s put on every page open),
 * from a copy up to 30 s old and without the #157 revision guard — so it could
 * undo a role change or sign-up made moments before.
 *
 * Pinned: the same subscription again writes nothing; a new or changed one
 * writes with expectedRev (the house guard every other users.json writer
 * uses); a stale document is refused (409), never overwritten.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const pushPath = requireFromHere.resolve("../../../api/_lib/push.js");
const notificationsPath = requireFromHere.resolve("../../../api/notifications.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let writeBlob: ReturnType<typeof vi.fn>;

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

const SUB = { endpoint: "https://push.example/dylan", keys: { p256dh: "pk1", auth: "au1" } };

async function subscribe(body: unknown): Promise<Res> {
  for (const p of [authPath, notificationsPath]) delete requireFromHere.cache[p];
  const auth = requireFromHere(authPath) as { signSession: (p: Record<string, unknown>) => string };
  const cookie = `buhl_session=${auth.signSession({ userId: "u_dylan", role: "electrician", exp: Date.now() + 60_000 })}`;
  const handler = requireFromHere(notificationsPath) as (req: Record<string, unknown>, res: Res) => Promise<unknown>;
  const res = createRes();
  await handler({ method: "POST", query: { action: "subscribe" }, headers: { cookie }, body }, res);
  return res;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    __rev: 7,
    users: [{ id: "u_dylan", username: "dylan", role: "electrician", pushSubscriptions: [{ ...SUB, createdAt: "2026-10-01T00:00:00.000Z" }] }],
  });
  writeBlob = vi.fn(async (key: string, data: unknown) => {
    blob.set(key, JSON.parse(JSON.stringify(data)));
  });
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? JSON.parse(JSON.stringify(blob.get(key))) : fallback,
      ),
      writeBlob,
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[pushPath] = {
    id: pushPath,
    filename: pushPath,
    loaded: true,
    exports: { getWebPush: vi.fn(() => ({})), sendPushToUserId: vi.fn() },
  } as NodeJS.Module;
});

afterEach(() => {
  delete requireFromHere.cache[blobPath];
  delete requireFromHere.cache[pushPath];
  for (const p of [authPath, notificationsPath]) delete requireFromHere.cache[p];
});

describe("push subscribe — no users.json rewrite on every page open", () => {
  it("the same subscription again: 200 and nothing written", async () => {
    const res = await subscribe(SUB);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, unchanged: true });
    expect(writeBlob).not.toHaveBeenCalled();
  });

  it("a new device's subscription is saved, guarded by the document's revision", async () => {
    const res = await subscribe({ endpoint: "https://push.example/new-phone", keys: { p256dh: "pk2", auth: "au2" } });
    expect(res.statusCode).toBe(200);
    expect(writeBlob).toHaveBeenCalledTimes(1);
    expect(writeBlob.mock.calls[0]![2]).toEqual({ expectedRev: 7 });
    const saved = blob.get("users.json") as { users: Array<{ pushSubscriptions: Array<{ endpoint: string }> }> };
    expect(saved.users[0]!.pushSubscriptions.map((s) => s.endpoint)).toEqual([
      "https://push.example/dylan",
      "https://push.example/new-phone",
    ]);
  });

  it("rotated keys on the same endpoint are saved", async () => {
    const res = await subscribe({ ...SUB, keys: { p256dh: "pk-rotated", auth: "au1" } });
    expect(res.statusCode).toBe(200);
    expect(writeBlob).toHaveBeenCalledTimes(1);
  });

  it("users.json moved underneath: refused with 409, never overwritten", async () => {
    writeBlob.mockImplementationOnce(async () => {
      throw Object.assign(new Error("stale"), { code: "stale_write" });
    });
    const res = await subscribe({ endpoint: "https://push.example/new-phone", keys: { p256dh: "pk2", auth: "au2" } });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "conflict" });
  });
});
