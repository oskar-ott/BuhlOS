import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Integration tests for the Gear/Assets serverless handler (api/assets.js)
 * against the REAL handler, with signed sessions and an in-memory Vercel Blob.
 * Mirrors the harness in src/domains/users/users-api.test.ts, plus a mock of
 * `@vercel/blob` `list` + global `fetch` because the list path enumerates one
 * `assets/<id>.json` blob per asset and fetches each by URL.
 *
 * This pins the role rules a field-readiness audit found broken — the same
 * "the UI exists but the API reads/writes the wrong role tier" class of bug
 * that hit job assignment:
 *   - admin TIER (admin/office/boss/…) sees the WHOLE register, not just the
 *     assets they personally hold (the literal `role === 'admin'` P1 bug);
 *   - field-tier + leading hands see ONLY their own held gear;
 *   - clients and unknown roles are denied outright;
 *   - an asset HOLDER must be a field worker or leading hand — never an
 *     admin/office/client/unknown user, never a disabled/archived user —
 *     enforced on both transfer and create-and-assign;
 *   - asset responses never leak passwordHash.
 *
 * NOTE: requireAuth → getCurrentUser re-reads users.json and takes the role
 * from there (the cookie only carries userId), so every acting user is seeded
 * in users.json; the `role` passed to call() is cosmetic and kept in sync.
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const vercelBlobPath = requireFromHere.resolve("@vercel/blob");
const assetsPath = requireFromHere.resolve("../../../api/assets.js");
const libAssetsPath = requireFromHere.resolve("../../../api/_lib/assets.js");

type Res = ReturnType<typeof createRes>;
let blob: Map<string, unknown>;
let auth: { signSession: (payload: Record<string, unknown>) => string };
let assetsHandler: (req: Record<string, unknown>, res: Res) => Promise<unknown>;

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

function cookieFor(userId: string, role: string): string {
  return `buhl_session=${auth.signSession({ userId, role, exp: Date.now() + 60_000 })}`;
}

async function call(
  {
    method,
    userId,
    role,
    query = {},
    body,
  }: {
    method: string;
    userId: string;
    role: string;
    query?: Record<string, string>;
    body?: unknown;
  },
) {
  const res = createRes();
  await assetsHandler(
    { method, query, body, headers: { cookie: cookieFor(userId, role) } },
    res,
  );
  return res;
}

/** Asset ids the caller can see in the list response. */
function assetIds(res: Res): string[] {
  return (res.body as { assets: Array<{ id: string }> }).assets.map((a) => a.id).sort();
}

/** Read an asset's current holder straight from the in-memory blob. */
function holderOf(assetId: string): string | null {
  const a = blob.get(`assets/${assetId}.json`) as { currentHolderId: string | null } | undefined;
  return a ? a.currentHolderId : null;
}

function seedAsset(id: string, currentHolderId: string | null, extra: Record<string, unknown> = {}) {
  blob.set(`assets/${id}.json`, {
    id,
    name: id,
    type: "tool",
    identifier: null,
    notes: null,
    currentHolderId,
    assignedAt: currentHolderId ? "2026-01-01T00:00:00.000Z" : null,
    expectedReturn: null,
    archived: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  });
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  blob = new Map<string, unknown>();
  blob.set("users.json", {
    users: [
      { id: "u_admin", username: "boss", role: "admin", passwordHash: "$2a$10$x" },
      // admin TIER but NOT literal 'admin' — the users the P1 bug hid the register from.
      { id: "u_office", username: "office", role: "office", passwordHash: "$2a$10$x" },
      { id: "u_boss", username: "bigboss", role: "boss", passwordHash: "$2a$10$x" },
      // field-tier holders (electrician/tradie are field roles).
      { id: "u_field", username: "sparky", role: "electrician", passwordHash: "$2a$10$x" },
      { id: "u_field2", username: "appy", role: "tradie", passwordHash: "$2a$10$x" },
      { id: "u_lh", username: "lead", role: "lh", passwordHash: "$2a$10$x" },
      // not valid holders:
      { id: "u_client", username: "client", role: "client", passwordHash: "$2a$10$x" },
      { id: "u_unknown", username: "accounts", role: "accounts", passwordHash: "$2a$10$x" },
      // valid role but disabled → not assignable.
      { id: "u_disabled", username: "exfield", role: "tradie", disabled: true, passwordHash: "$2a$10$x" },
    ],
  });
  // a_held → held by u_field; a_field2 → held by u_field2; a_storage → in storage; a_archived → archived.
  seedAsset("a_held", "u_field");
  seedAsset("a_field2", "u_field2");
  seedAsset("a_storage", null);
  seedAsset("a_archived", null, { archived: true });

  for (const p of [authPath, assetsPath, libAssetsPath]) delete requireFromHere.cache[p];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback,
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;
  // The list path uses @vercel/blob `list` to enumerate asset blobs and global
  // fetch to read each one — model both against the in-memory Map.
  requireFromHere.cache[vercelBlobPath] = {
    id: vercelBlobPath,
    filename: vercelBlobPath,
    loaded: true,
    exports: {
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({
        blobs: [...blob.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ pathname: k, url: `memory://${k}` })),
      })),
      put: vi.fn(async () => ({})),
    },
  } as NodeJS.Module;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const key = String(url).replace(/^memory:\/\//, "").replace(/\?.*$/, "");
      if (!blob.has(key)) return { ok: false, json: async () => null };
      return { ok: true, json: async () => clone(blob.get(key)) };
    }),
  );

  auth = requireFromHere(authPath);
  assetsHandler = requireFromHere(assetsPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /api/assets — list visibility by role TIER (not literal 'admin')", () => {
  it("admin sees the whole register (all non-archived assets)", async () => {
    const res = await call({ method: "GET", userId: "u_admin", role: "admin" });
    expect(res.statusCode).toBe(200);
    expect(assetIds(res)).toEqual(["a_field2", "a_held", "a_storage"]);
  });

  it.each([
    ["office", "u_office"],
    ["boss", "u_boss"],
  ])(
    "%s (admin TIER, not literal 'admin') ALSO sees the whole register — the P1 bug",
    async (role, userId) => {
      const res = await call({ method: "GET", userId, role });
      expect(res.statusCode).toBe(200);
      // Before the fix this returned [] (office/boss held nothing personally).
      expect(assetIds(res)).toEqual(["a_field2", "a_held", "a_storage"]);
    },
  );

  it("a field worker sees ONLY the assets they currently hold", async () => {
    const res = await call({ method: "GET", userId: "u_field", role: "electrician" });
    expect(res.statusCode).toBe(200);
    expect(assetIds(res)).toEqual(["a_held"]);
  });

  it("a different field worker sees only THEIR held asset (no cross-holder leak)", async () => {
    const res = await call({ method: "GET", userId: "u_field2", role: "tradie" });
    expect(res.statusCode).toBe(200);
    expect(assetIds(res)).toEqual(["a_field2"]);
  });

  it("a leading hand sees only their own held gear (none here)", async () => {
    const res = await call({ method: "GET", userId: "u_lh", role: "lh" });
    expect(res.statusCode).toBe(200);
    expect(assetIds(res)).toEqual([]);
  });

  it("admin can include archived assets with ?archived=1", async () => {
    const res = await call({ method: "GET", userId: "u_admin", role: "admin", query: { archived: "1" } });
    expect(assetIds(res)).toEqual(["a_archived", "a_field2", "a_held", "a_storage"]);
  });

  it("403s a client", async () => {
    const res = await call({ method: "GET", userId: "u_client", role: "client" });
    expect(res.statusCode).toBe(403);
  });

  it("403s an unknown role (not admin-tier, not field/LH)", async () => {
    const res = await call({ method: "GET", userId: "u_unknown", role: "accounts" });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/assets?id= — single-asset visibility", () => {
  it("admin-tier (office) can open any asset's detail", async () => {
    const res = await call({ method: "GET", userId: "u_office", role: "office", query: { id: "a_held" } });
    expect(res.statusCode).toBe(200);
    expect((res.body as { asset: { id: string } }).asset.id).toBe("a_held");
  });

  it("the holder can open their own asset", async () => {
    const res = await call({ method: "GET", userId: "u_field", role: "electrician", query: { id: "a_held" } });
    expect(res.statusCode).toBe(200);
  });

  it("403s a field worker opening an asset they do NOT hold", async () => {
    const res = await call({ method: "GET", userId: "u_field2", role: "tradie", query: { id: "a_held" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST ?action=transfer — an asset HOLDER must be field/LH", () => {
  it("admin assigns a storage asset to a field worker (holder + history updated)", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      query: { action: "transfer" },
      body: { assetId: "a_storage", toUserId: "u_field2" },
    });
    expect(res.statusCode).toBe(200);
    expect(holderOf("a_storage")).toBe("u_field2");
    const history = blob.get("assets/a_storage/history.json") as { entries: unknown[] };
    expect(history.entries.length).toBe(1);
  });

  it("admin can assign to a leading hand", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      query: { action: "transfer" },
      body: { assetId: "a_storage", toUserId: "u_lh" },
    });
    expect(res.statusCode).toBe(200);
    expect(holderOf("a_storage")).toBe("u_lh");
  });

  it("REJECTS assigning to an admin-tier user (office is not a gear holder)", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      query: { action: "transfer" },
      body: { assetId: "a_storage", toUserId: "u_office" },
    });
    expect(res.statusCode).toBe(400);
    expect(holderOf("a_storage")).toBeNull(); // unchanged
  });

  it("REJECTS assigning to a client", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      query: { action: "transfer" },
      body: { assetId: "a_storage", toUserId: "u_client" },
    });
    expect(res.statusCode).toBe(400);
    expect(holderOf("a_storage")).toBeNull();
  });

  it("REJECTS assigning to a disabled field worker", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      query: { action: "transfer" },
      body: { assetId: "a_storage", toUserId: "u_disabled" },
    });
    expect(res.statusCode).toBe(400);
    expect(holderOf("a_storage")).toBeNull();
  });

  it("404s assigning to a non-existent user", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      query: { action: "transfer" },
      body: { assetId: "a_storage", toUserId: "u_nope" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("admin can return an asset to storage (toUserId null)", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      query: { action: "transfer" },
      body: { assetId: "a_held", toUserId: null },
    });
    expect(res.statusCode).toBe(200);
    expect(holderOf("a_held")).toBeNull();
  });

  it("a field worker handing THEIR asset to a workmate starts the handshake (#306)", async () => {
    const res = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      query: { action: "transfer" },
      body: { assetId: "a_held", toUserId: "u_field2" },
    });
    expect(res.statusCode).toBe(200);
    // No longer instant: pending until u_field2 accepts (handshake suite).
    expect(holderOf("a_held")).toBe("u_field");
    expect((res.body as { asset: { pendingTransfer: { toUserId: string } } }).asset.pendingTransfer.toUserId).toBe("u_field2");
  });

  it("403s a field worker transferring an asset they do NOT hold", async () => {
    const res = await call({
      method: "POST",
      userId: "u_field2",
      role: "tradie",
      query: { action: "transfer" },
      body: { assetId: "a_held", toUserId: "u_field2" },
    });
    expect(res.statusCode).toBe(403);
    expect(holderOf("a_held")).toBe("u_field"); // unchanged
  });
});

describe("POST create-and-assign — holder validation", () => {
  it("admin creates an asset assigned to a field worker", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      body: { name: "Impact driver", type: "tool", currentHolderId: "u_field2" },
    });
    expect(res.statusCode).toBe(201);
    const created = (res.body as { asset: { id: string; currentHolderId: string } }).asset;
    expect(created.currentHolderId).toBe("u_field2");
  });

  it("REJECTS create-and-assign to an admin-tier user", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      body: { name: "Laptop", type: "other", currentHolderId: "u_office" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("REJECTS create-and-assign to a disabled field worker", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      body: { name: "Drill", type: "tool", currentHolderId: "u_disabled" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("403s a field worker trying to create an asset (admin-tier only)", async () => {
    const res = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      body: { name: "Ladder", type: "other" },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("never leaks passwordHash", () => {
  it("the detail view enriches holder NAME only, no hash", async () => {
    const res = await call({ method: "GET", userId: "u_admin", role: "admin", query: { id: "a_held" } });
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("passwordHash");
    expect((res.body as { asset: { currentHolderName: string } }).asset.currentHolderName).toBe("sparky");
  });
});

describe("worker↔worker handshake (#306)", () => {
  it("a field transfer to a workmate goes PENDING — holder unchanged until accepted", async () => {
    const res = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      query: { action: "transfer" },
      body: { assetId: "a_held", toUserId: "u_field2", note: "smoko handover" },
    });
    expect(res.statusCode).toBe(200);
    const asset = (res.body as { asset: Record<string, unknown> }).asset;
    expect(asset.currentHolderId).toBe("u_field"); // STILL the initiator's
    expect(asset.pendingTransfer).toMatchObject({ toUserId: "u_field2", fromUserId: "u_field" });

    // a second proposal while one is pending is refused
    const second = await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      query: { action: "transfer" },
      body: { assetId: "a_held", toUserId: "u_lh" },
    });
    expect(second.statusCode).toBe(409);
  });

  it("the receiver sees the incoming asset in their list and can ACCEPT (holder flips)", async () => {
    await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      query: { action: "transfer" },
      body: { assetId: "a_held", toUserId: "u_field2" },
    });
    const list = await call({ method: "GET", userId: "u_field2", role: "tradie" });
    expect(assetIds(list)).toContain("a_held");

    const res = await call({
      method: "POST",
      userId: "u_field2",
      role: "tradie",
      query: { action: "transfer-response" },
      body: { assetId: "a_held", accept: true },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { asset: { currentHolderId: string } }).asset.currentHolderId).toBe("u_field2");
    expect(holderOf("a_held")).toBe("u_field2");
  });

  it("DECLINE reverts cleanly; only the named receiver may respond", async () => {
    await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      query: { action: "transfer" },
      body: { assetId: "a_held", toUserId: "u_field2" },
    });
    const wrong = await call({
      method: "POST",
      userId: "u_lh",
      role: "lh",
      query: { action: "transfer-response" },
      body: { assetId: "a_held", accept: true },
    });
    expect(wrong.statusCode).toBe(403);

    const declined = await call({
      method: "POST",
      userId: "u_field2",
      role: "tradie",
      query: { action: "transfer-response" },
      body: { assetId: "a_held", accept: false },
    });
    expect(declined.statusCode).toBe(200);
    expect(holderOf("a_held")).toBe("u_field"); // reverted to the initiator
    const after = (declined.body as { asset: { pendingTransfer: unknown } }).asset;
    expect(after.pendingTransfer).toBeNull();
  });

  it("admin transfers stay INSTANT and void a pending handover; worker→storage stays instant", async () => {
    await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      query: { action: "transfer" },
      body: { assetId: "a_held", toUserId: "u_field2" },
    });
    const adminMove = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      query: { action: "transfer" },
      body: { assetId: "a_held", toUserId: "u_lh" },
    });
    expect(adminMove.statusCode).toBe(200);
    expect(holderOf("a_held")).toBe("u_lh"); // instant
    expect((adminMove.body as { asset: { pendingTransfer: unknown } }).asset.pendingTransfer ?? null).toBeNull();

    const toStorage = await call({
      method: "POST",
      userId: "u_field2",
      role: "tradie",
      query: { action: "transfer" },
      body: { assetId: "a_field2", toUserId: null },
    });
    expect(toStorage.statusCode).toBe(200);
    expect(holderOf("a_field2")).toBeNull(); // instant return to depot
  });

  it("an expired proposal auto-cancels with history; responding to it 409s", async () => {
    await call({
      method: "POST",
      userId: "u_field",
      role: "electrician",
      query: { action: "transfer" },
      body: { assetId: "a_held", toUserId: "u_field2" },
    });
    // age the proposal past the window
    const stored = blob.get("assets/a_held.json") as { pendingTransfer: { expiresAt: string } };
    stored.pendingTransfer.expiresAt = "2020-01-01T00:00:00.000Z";

    const res = await call({
      method: "POST",
      userId: "u_field2",
      role: "tradie",
      query: { action: "transfer-response" },
      body: { assetId: "a_held", accept: true },
    });
    expect(res.statusCode).toBe(409);
    expect(holderOf("a_held")).toBe("u_field"); // never moved
    const history = blob.get("assets/a_held/history.json") as { entries: Array<{ kind?: string }> };
    expect(history.entries.some((e) => e.kind === "transfer_expired")).toBe(true);
  });
});

describe("create persists hire fields (#394) and archive works (#389)", () => {
  it("create with hired-gear fields stores them verbatim — create and edit can't disagree", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      body: {
        name: "Genie lift",
        type: "other",
        ownership: "hired",
        hireEndDate: "2026-07-31",
        hireRateExGst: 180.5,
        hireSupplier: "Coates Hire",
      },
    });
    expect(res.statusCode).toBe(201);
    expect((res.body as { asset: Record<string, unknown> }).asset).toMatchObject({
      ownership: "hired",
      hireEndDate: "2026-07-31",
      hireRateExGst: 180.5,
      hireSupplier: "Coates Hire",
    });
  });

  it("create without ownership defaults to owned with null hire fields", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      body: { name: "Crimps", type: "tool" },
    });
    expect((res.body as { asset: Record<string, unknown> }).asset).toMatchObject({
      ownership: "owned",
      hireEndDate: null,
      hireRateExGst: null,
      hireSupplier: null,
    });
  });

  it("DELETE soft-archives (admin only) — record kept, archived flag set", async () => {
    const res = await call({
      method: "DELETE",
      userId: "u_admin",
      role: "admin",
      query: { id: "a_storage" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { asset: { archived: boolean } }).asset.archived).toBe(true);
    const denied = await call({
      method: "DELETE",
      userId: "u_field",
      role: "electrician",
      query: { id: "a_held" },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe("calibrationDue (#305) — optional ISO date on create/edit", () => {
  it("create accepts a valid ISO calibrationDue and stores it", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      body: { name: "Fluke 1587", type: "tool", calibrationDue: "2026-09-30" },
    });
    expect(res.statusCode).toBe(201);
    expect((res.body as { asset: { calibrationDue: string } }).asset.calibrationDue).toBe(
      "2026-09-30",
    );
  });

  it("create REJECTS a non-ISO calibrationDue", async () => {
    const res = await call({
      method: "POST",
      userId: "u_admin",
      role: "admin",
      body: { name: "Fluke 1587", type: "tool", calibrationDue: "30/09/2026" },
    });
    expect(res.statusCode).toBe(400);
    expect(String((res.body as { error: string }).error)).toContain("calibrationDue");
  });

  it("PUT sets calibrationDue on an existing asset and PUT null clears it", async () => {
    const set = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      query: { id: "a_held" },
      body: { calibrationDue: "2026-07-01" },
    });
    expect(set.statusCode).toBe(200);
    expect((set.body as { asset: { calibrationDue: string } }).asset.calibrationDue).toBe(
      "2026-07-01",
    );

    const clear = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      query: { id: "a_held" },
      body: { calibrationDue: null },
    });
    expect(clear.statusCode).toBe(200);
    expect((clear.body as { asset: { calibrationDue: null } }).asset.calibrationDue).toBeNull();
  });

  it("PUT leaves calibrationDue untouched when the field is absent (patch semantics)", async () => {
    await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      query: { id: "a_held" },
      body: { calibrationDue: "2026-07-01" },
    });
    const res = await call({
      method: "PUT",
      userId: "u_admin",
      role: "admin",
      query: { id: "a_held" },
      body: { notes: "serviced" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.body as { asset: { calibrationDue: string } }).asset.calibrationDue).toBe(
      "2026-07-01",
    );
  });
});
