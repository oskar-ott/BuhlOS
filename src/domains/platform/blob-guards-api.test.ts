import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #157 — write guards through the REAL api/_lib/blob.js (only @vercel/blob,
 * global fetch and the audit lib are mocked): per-store validation, shrink
 * refusal with explicit override, revision stamping, stale-write rejection,
 * cache hygiene on rejection, writeEntry threading, and the approve
 * handler's conflict → 409 mapping.
 */

const requireFromHere = createRequire(import.meta.url);
const sdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const guardsPath = requireFromHere.resolve("../../../api/_lib/blob-guards.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const timeEntriesPath = requireFromHere.resolve("../../../api/_lib/time-entries.js");

type BlobModule = {
  readBlob: (key: string, fallback?: unknown) => Promise<unknown>;
  writeBlob: (key: string, data: unknown, opts?: Record<string, unknown>) => Promise<void>;
};

let store: Map<string, string>;
let audits: Array<Record<string, unknown>>;
let blobLib: BlobModule;

function urlFor(pathname: string): string {
  return `https://blob.test/${encodeURIComponent(pathname)}`;
}

function seed(key: string, doc: unknown) {
  store.set(key, JSON.stringify(doc));
}
function stored(key: string): Record<string, unknown> {
  return JSON.parse(store.get(key)!);
}

beforeEach(() => {
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  store = new Map();
  audits = [];
  for (const p of [sdkPath, blobPath, guardsPath, auditPath, timeEntriesPath]) {
    delete requireFromHere.cache[p];
  }
  requireFromHere.cache[sdkPath] = {
    id: sdkPath,
    filename: sdkPath,
    loaded: true,
    exports: {
      list: vi.fn(async (opts: { prefix?: string }) => ({
        blobs: [...store.keys()]
          .filter((k) => k.startsWith(opts.prefix ?? ""))
          .map((pathname) => ({ pathname, url: urlFor(pathname) })),
      })),
      put: vi.fn(async (pathname: string, body: string) => {
        store.set(pathname, body);
        return { url: urlFor(pathname) };
      }),
      del: vi.fn(),
    },
  } as NodeJS.Module;
  requireFromHere.cache[auditPath] = {
    id: auditPath,
    filename: auditPath,
    loaded: true,
    exports: {
      append: vi.fn(async (entry: Record<string, unknown>) => {
        audits.push(entry);
        return { id: "al_x" };
      }),
    },
  } as NodeJS.Module;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const pathname = decodeURIComponent(new URL(url).pathname.slice(1));
      const value = store.get(pathname);
      return { ok: value !== undefined, json: async () => JSON.parse(value!) };
    })
  );
  blobLib = requireFromHere(blobPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function manyUsers(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `u${i}`, username: `u${i}` }));
}

describe("revision stamping", () => {
  it("stamps __rev/__updatedAt and increments across writes", async () => {
    await blobLib.writeBlob("users.json", { users: manyUsers(2) });
    expect(stored("users.json").__rev).toBe(1);
    await blobLib.writeBlob("users.json", { users: manyUsers(3) });
    expect(stored("users.json").__rev).toBe(2);
    expect(typeof stored("users.json").__updatedAt).toBe("string");
  });

  it("never mutates the caller's object", async () => {
    const mine: Record<string, unknown> = { users: manyUsers(1) };
    await blobLib.writeBlob("users.json", mine);
    expect(mine.__rev).toBeUndefined();
  });
});

describe("validation", () => {
  it("rejects a shape-invalid users.json loudly, audits it, and never persists", async () => {
    seed("users.json", { users: manyUsers(2), __rev: 7 });
    await expect(
      blobLib.writeBlob("users.json", { users: [{ name: "no id" }] })
    ).rejects.toMatchObject({ code: "invalid_write" });
    expect(stored("users.json").__rev).toBe(7); // untouched
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("storage.write_rejected");
    expect(audits[0]!.targetId).toBe("users.json");
  });

  it("a rejected write never poisons the read cache", async () => {
    seed("users.json", { users: manyUsers(2), __rev: 7 });
    const before = (await blobLib.readBlob("users.json")) as { __rev: number };
    expect(before.__rev).toBe(7);
    await expect(blobLib.writeBlob("users.json", { users: "garbage" })).rejects.toMatchObject({
      code: "invalid_write",
    });
    const after = (await blobLib.readBlob("users.json")) as { __rev: number };
    expect(after.__rev).toBe(7);
  });

  it("validates per-user time-entry day files by pattern", async () => {
    await expect(
      blobLib.writeBlob("users/u1/time-entries/2026-06-12.json", { id: "te", status: 9 })
    ).rejects.toMatchObject({ code: "invalid_write" });
    await blobLib.writeBlob("users/u1/time-entries/2026-06-12.json", {
      id: "te1",
      userId: "u1",
      date: "2026-06-12",
      status: "submitted",
    });
    expect(stored("users/u1/time-entries/2026-06-12.json").__rev).toBe(1);
  });

  it("unguarded stores still write (no validator → pass)", async () => {
    await blobLib.writeBlob("itp-templates.json", { templates: [] });
    expect(stored("itp-templates.json").__rev).toBe(1);
  });

  it("validates the v2 quotes registry (#183) — rows must carry ids", async () => {
    await expect(
      blobLib.writeBlob("quotes-v2.json", { quotes: [{ name: "no id" }] })
    ).rejects.toMatchObject({ code: "invalid_write" });
    await blobLib.writeBlob("quotes-v2.json", {
      quotes: [{ id: "qv2_a", name: "Shed", status: "draft" }],
    });
    expect(stored("quotes-v2.json").__rev).toBe(1);
  });

  it("validates v2 quote documents by pattern (#183) — sections/lines need ids", async () => {
    await expect(
      blobLib.writeBlob("quotes-v2/qv2_a.json", { id: "qv2_a", name: "Shed", status: "draft" })
    ).rejects.toMatchObject({ code: "invalid_write" }); // sections missing
    await expect(
      blobLib.writeBlob("quotes-v2/qv2_a.json", {
        id: "qv2_a",
        name: "Shed",
        status: "draft",
        sections: [{ id: "qsec_a", lines: [{ kind: "material" }] }],
      })
    ).rejects.toMatchObject({ code: "invalid_write" }); // line missing id
    await blobLib.writeBlob("quotes-v2/qv2_a.json", {
      id: "qv2_a",
      name: "Shed",
      status: "draft",
      sections: [{ id: "qsec_a", lines: [{ id: "qline_a", kind: "material" }] }],
    });
    expect(stored("quotes-v2/qv2_a.json").__rev).toBe(1);
    // LEGACY per-section quote blobs (quotes/<id>/<section>.json) stay unguarded.
    await blobLib.writeBlob("quotes/q_old/pricing.json", { gstPct: 10 });
    expect(stored("quotes/q_old/pricing.json").__rev).toBe(1);
  });
});

describe("shrinkage guard", () => {
  it("rejects a write dropping >20% of users unless allowShrink is explicit", async () => {
    seed("users.json", { users: manyUsers(20), __rev: 1 });
    await expect(blobLib.writeBlob("users.json", { users: manyUsers(10) })).rejects.toMatchObject({
      code: "shrink_rejected",
      before: 20,
      after: 10,
    });
    expect(audits[0]!.action).toBe("storage.write_rejected");
    await blobLib.writeBlob("users.json", { users: manyUsers(10) }, { allowShrink: true });
    expect((stored("users.json").users as unknown[]).length).toBe(10);
  });

  it("small stores (under the floor) shrink freely — onboarding churn isn't a disaster", async () => {
    seed("users.json", { users: manyUsers(5), __rev: 1 });
    await blobLib.writeBlob("users.json", { users: manyUsers(2) });
    expect((stored("users.json").users as unknown[]).length).toBe(2);
  });

  it("the v2 quotes registry is shrink-guarded (#183) — archive flips, never removals", async () => {
    const manyQuotes = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `qv2_${i}`, name: `Q${i}`, status: "draft" }));
    seed("quotes-v2.json", { quotes: manyQuotes(12), __rev: 1 });
    await expect(
      blobLib.writeBlob("quotes-v2.json", { quotes: manyQuotes(6) })
    ).rejects.toMatchObject({ code: "shrink_rejected", before: 12, after: 6 });
  });
});

describe("writeGuardErrorResponse — clean operator error, not a 500 (#512)", () => {
  it("maps a real shrink_rejected error to a 409 carrying before/after", async () => {
    const { writeGuardErrorResponse } = requireFromHere(guardsPath);
    seed("users.json", { users: manyUsers(20), __rev: 1 });
    let mapped: { status: number; body: Record<string, unknown> } | null = null;
    try {
      await blobLib.writeBlob("users.json", { users: manyUsers(10) });
    } catch (e) {
      mapped = writeGuardErrorResponse(e);
    }
    expect(mapped).toEqual({
      status: 409,
      body: { error: expect.stringContaining("suspicious shrink"), code: "shrink_rejected", before: 20, after: 10 },
    });
  });

  it("maps a real invalid_write to a 400", async () => {
    const { writeGuardErrorResponse } = requireFromHere(guardsPath);
    let mapped: { status: number; body: Record<string, unknown> } | null = null;
    try {
      await blobLib.writeBlob("users.json", { users: [{ name: "no id" }] });
    } catch (e) {
      mapped = writeGuardErrorResponse(e);
    }
    expect(mapped?.status).toBe(400);
    expect(mapped?.body.code).toBe("invalid_write");
  });

  it("maps a real stale_write to a 409", async () => {
    const { writeGuardErrorResponse } = requireFromHere(guardsPath);
    seed("users.json", { users: manyUsers(12), __rev: 5 });
    let mapped: { status: number; body: Record<string, unknown> } | null = null;
    try {
      await blobLib.writeBlob("users.json", { users: manyUsers(12) }, { expectedRev: 4 });
    } catch (e) {
      mapped = writeGuardErrorResponse(e);
    }
    expect(mapped?.status).toBe(409);
    expect(mapped?.body.code).toBe("stale_write");
  });

  it("returns null for a non-guard error so the caller rethrows", () => {
    const { writeGuardErrorResponse } = requireFromHere(guardsPath);
    expect(writeGuardErrorResponse(new Error("boom"))).toBeNull();
    expect(writeGuardErrorResponse(null)).toBeNull();
  });
});

describe("stale-write rejection", () => {
  it("rejects when expectedRev is behind the store, reporting currentRev", async () => {
    seed("users.json", { users: manyUsers(2), __rev: 6 });
    await expect(
      blobLib.writeBlob("users.json", { users: manyUsers(2) }, { expectedRev: 5 })
    ).rejects.toMatchObject({ code: "stale_write", expectedRev: 5, currentRev: 6 });
    await blobLib.writeBlob("users.json", { users: manyUsers(2) }, { expectedRev: 6 });
    expect(stored("users.json").__rev).toBe(7);
  });

  it("writeEntry threads the day-file's own __rev as expectedRev", async () => {
    const te = requireFromHere(timeEntriesPath) as {
      writeEntry: (userId: string, entry: Record<string, unknown>) => Promise<unknown>;
    };
    seed("users/u1/time-entries/2026-06-12.json", {
      id: "te1",
      userId: "u1",
      date: "2026-06-12",
      status: "submitted",
      __rev: 6,
    });
    // A writer holding a STALE copy (rev 5) is refused…
    await expect(
      te.writeEntry("u1", {
        id: "te1",
        userId: "u1",
        date: "2026-06-12",
        status: "approved",
        __rev: 5,
      })
    ).rejects.toMatchObject({ code: "stale_write", currentRev: 6 });
    // …the writer holding the current copy wins.
    await te.writeEntry("u1", {
      id: "te1",
      userId: "u1",
      date: "2026-06-12",
      status: "approved",
      __rev: 6,
    });
    expect(stored("users/u1/time-entries/2026-06-12.json").status).toBe("approved");
  });
});

describe("handler mapping (approve → 409 on conflict)", () => {
  it("the approve endpoint returns a retryable 409 with currentRev", async () => {
    const approvePath = requireFromHere.resolve("../../../api/time-entries-approve.js");
    const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
    delete requireFromHere.cache[approvePath];
    delete requireFromHere.cache[authPath];
    process.env.SESSION_SECRET = "test-session-secret-long-enough";
    seed("users.json", {
      users: [
        { id: "u_boss", username: "boss", role: "boss" },
        { id: "u_field", username: "sparky", role: "electrician" },
      ],
    });
    // Stored day-file at rev 6; the time-entries lib is mocked to throw the
    // REAL StaleWriteError so the mapping (not the race itself) is what's
    // under test — the race window is exercised above at the lib level.
    const guards = requireFromHere(guardsPath) as {
      StaleWriteError: new (k: string, e: number, c: number) => Error;
    };
    delete requireFromHere.cache[timeEntriesPath];
    requireFromHere.cache[timeEntriesPath] = {
      id: timeEntriesPath,
      filename: timeEntriesPath,
      loaded: true,
      exports: {
        readEntry: vi.fn(async () => ({
          id: "te1",
          userId: "u_field",
          date: "2026-06-12",
          status: "submitted",
          totalHours: 7.6,
          __rev: 5,
        })),
        writeEntry: vi.fn(async () => {
          throw new guards.StaleWriteError("users/u_field/time-entries/2026-06-12.json", 5, 6);
        }),
        appendAudit: vi.fn(async () => null),
      },
    } as NodeJS.Module;
    const auth = requireFromHere(authPath) as {
      signSession: (p: Record<string, unknown>) => string;
    };
    const handler = requireFromHere(approvePath) as (
      req: Record<string, unknown>,
      res: Record<string, unknown>
    ) => Promise<unknown>;
    const res = {
      statusCode: 200,
      body: null as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(b: unknown) {
        this.body = b;
        return this;
      },
      setHeader() {
        return this;
      },
      end() {
        return this;
      },
    };
    await handler(
      {
        method: "POST",
        query: {},
        body: { userId: "u_field", date: "2026-06-12" },
        headers: {
          cookie: `buhl_session=${auth.signSession({ userId: "u_boss", role: "boss", exp: Date.now() + 60_000 })}`,
        },
      },
      res
    );
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: "conflict", currentRev: 6 });
  });
});
