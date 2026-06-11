import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #151 — blob backup, retention and restore, against the REAL handlers/lib
 * (require-cache injection, in-memory blob store — the established api
 * harness pattern).
 *
 * Includes the RESTORE DRILL the issue's AC requires: snapshot → clobber →
 * dry-run (no write) → apply → byte-identical recovery, executed against this
 * non-production store on every CI run (documented in docs/backups.md).
 */

const requireFromHere = createRequire(import.meta.url);
const blobSdkPath = requireFromHere.resolve("@vercel/blob");
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const backupLibPath = requireFromHere.resolve("../../../api/_lib/backup.js");
const handlerPath = requireFromHere.resolve("../../../api/backup-snapshot.js");

type Handler = (
  req: Record<string, unknown>,
  res: ReturnType<typeof createRes>
) => Promise<unknown>;

let store: Map<string, string>; // pathname → raw JSON text (the fake blob service)
let audits: Array<Record<string, unknown>>;
let auth: { signSession: (p: Record<string, unknown>) => string };
let handler: Handler;
let backupLib: {
  runSnapshot: (o?: { date?: string }) => Promise<{ copied: number; failed: unknown[]; targets: number }>;
  computeRetention: (dates: string[], now?: Date) => { keep: string[]; prune: string[] };
  pruneSnapshots: (o?: { now?: Date }) => Promise<{ pruned: string[]; deletedBlobs: number }>;
  restoreDocument: (o: {
    date: string;
    pathname: string;
    apply?: boolean;
    now?: Date;
  }) => Promise<{ applied: boolean; diff: Record<string, never> | { identical: boolean; backup: { shape: unknown }; current: { shape?: unknown; exists: boolean }; preRestoreCopy?: string } }>;
  listSnapshotDates: () => Promise<string[]>;
};

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

function urlFor(pathname: string): string {
  return `https://blob.test/${encodeURIComponent(pathname)}`;
}

beforeEach(() => {
  process.env.SESSION_SECRET = "test-session-secret-long-enough";
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
  delete process.env.CRON_SECRET;

  audits = [];
  store = new Map<string, string>([
    [
      "users.json",
      JSON.stringify({
        users: [
          { id: "u_admin", username: "boss", role: "boss" },
          { id: "u_field", username: "sparky", role: "electrician" },
        ],
      }),
    ],
    ["jobs.json", JSON.stringify({ jobs: [{ id: "j1", name: "Birdwood" }] })],
    ["jobs/j1/data.json", JSON.stringify({ evidence: [{ id: "ev1" }], snagsV2: [] })],
    ["users/u1/time-entries/2026-06-10.json", JSON.stringify({ id: "te1", totalHours: 7.6 })],
    // binaries must never be snapshotted
    ["jobs/j1/evidence-photos/p1.jpg", "JPEGBYTES"],
  ]);

  for (const p of [blobSdkPath, blobPath, authPath, auditPath, backupLibPath, handlerPath]) {
    delete requireFromHere.cache[p];
  }

  // Fake @vercel/blob over the in-memory store: paginated list (+folded),
  // server-side copy, bulk del, put.
  requireFromHere.cache[blobSdkPath] = {
    id: blobSdkPath,
    filename: blobSdkPath,
    loaded: true,
    exports: {
      list: vi.fn(async (opts: { prefix?: string; mode?: string; cursor?: string; limit?: number }) => {
        const prefix = opts.prefix ?? "";
        const matching = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
        if (opts.mode === "folded") {
          const folders = new Set<string>();
          for (const k of matching) {
            const rest = k.slice(prefix.length);
            const cut = rest.indexOf("/");
            if (cut !== -1) folders.add(prefix + rest.slice(0, cut + 1));
          }
          return { blobs: [], folders: [...folders].sort(), hasMore: false };
        }
        const limit = opts.limit ?? 1000;
        const start = opts.cursor ? Number(opts.cursor) : 0;
        const page = matching.slice(start, start + limit);
        const hasMore = start + limit < matching.length;
        return {
          blobs: page.map((pathname) => ({ pathname, url: urlFor(pathname) })),
          hasMore,
          cursor: hasMore ? String(start + limit) : undefined,
        };
      }),
      copy: vi.fn(async (fromUrl: string, toPathname: string) => {
        const fromPath = decodeURIComponent(new URL(fromUrl).pathname.slice(1));
        if (!store.has(fromPath)) throw new Error(`copy source missing: ${fromPath}`);
        store.set(toPathname, store.get(fromPath)!);
        return { url: urlFor(toPathname) };
      }),
      del: vi.fn(async (urls: string | string[]) => {
        for (const u of Array.isArray(urls) ? urls : [urls]) {
          store.delete(decodeURIComponent(new URL(u).pathname.slice(1)));
        }
      }),
      put: vi.fn(async (pathname: string, body: string) => {
        store.set(pathname, typeof body === "string" ? body : String(body));
        return { url: urlFor(pathname) };
      }),
    },
  } as NodeJS.Module;

  // Audit lib stub: capture entries (allowlist behaviour is covered by the
  // real audit tests; here we assert the backup writes one).
  requireFromHere.cache[auditPath] = {
    id: auditPath,
    filename: auditPath,
    loaded: true,
    exports: {
      append: vi.fn(async (entry: Record<string, unknown>) => {
        audits.push(entry);
        return { id: "al_test" };
      }),
    },
  } as NodeJS.Module;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const pathname = decodeURIComponent(new URL(url).pathname.slice(1));
      const value = store.get(pathname);
      return {
        ok: value !== undefined,
        status: value !== undefined ? 200 : 404,
        text: async () => value,
        json: async () => JSON.parse(value!),
      };
    })
  );

  auth = requireFromHere(authPath);
  backupLib = requireFromHere(backupLibPath);
  handler = requireFromHere(handlerPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function run(opts: { action: string; role?: string; cronHeader?: string; anon?: boolean }) {
  const res = createRes();
  const headers: Record<string, string> = {};
  if (opts.cronHeader) headers["x-cron-secret"] = opts.cronHeader;
  if (!opts.anon && !opts.cronHeader) {
    // Sign as the seeded user whose STORE role matches — getCurrentUser
    // resolves the role from users.json, not the cookie claim.
    const userId = (opts.role ?? "boss") === "electrician" ? "u_field" : "u_admin";
    headers.cookie = `buhl_session=${auth.signSession({
      userId,
      role: opts.role ?? "boss",
      exp: Date.now() + 60_000,
    })}`;
  }
  await handler({ method: "GET", query: { action: opts.action }, headers }, res);
  return res;
}

describe("snapshot run (#151)", () => {
  it("copies every canonical JSON document to backups/<date>/… and never binaries or backups/", async () => {
    const result = await backupLib.runSnapshot({ date: "2026-06-11" });
    expect(result.failed).toEqual([]);
    expect(store.has("backups/2026-06-11/users.json")).toBe(true);
    expect(store.has("backups/2026-06-11/jobs.json")).toBe(true);
    expect(store.has("backups/2026-06-11/jobs/j1/data.json")).toBe(true);
    expect(store.has("backups/2026-06-11/users/u1/time-entries/2026-06-10.json")).toBe(true);
    // the photo is write-once — excluded by design
    expect(store.has("backups/2026-06-11/jobs/j1/evidence-photos/p1.jpg")).toBe(false);
    // snapshot contents are byte-identical
    expect(store.get("backups/2026-06-11/users.json")).toBe(store.get("users.json"));
    // a second run never re-snapshots its own output
    const again = await backupLib.runSnapshot({ date: "2026-06-12" });
    expect(again.failed).toEqual([]);
    expect(store.has("backups/2026-06-12/backups/2026-06-11/users.json")).toBe(false);
  });

  it("endpoint: admin runs it, audit entry records the counts, response is ok", async () => {
    const res = await run({ action: "run", role: "boss" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("backup.completed");
    expect(audits[0]!.targetType).toBe("system");
    expect((audits[0]!.metadata as { ok: boolean; copied: number }).ok).toBe(true);
    expect((audits[0]!.metadata as { copied: number }).copied).toBeGreaterThan(0);
  });

  it("endpoint auth: cron secret works; a missing secret does NOT open the endpoint", async () => {
    process.env.CRON_SECRET = "s3cret";
    const viaCron = await run({ action: "run", cronHeader: "s3cret" });
    expect(viaCron.statusCode).toBe(200);
    const anon = await run({ action: "run", anon: true });
    expect(anon.statusCode).toBe(401);
    delete process.env.CRON_SECRET;
    const anonNoSecret = await run({ action: "run", anon: true });
    expect(anonNoSecret.statusCode).toBe(401); // stricter than cash-watch — deliberate
  });

  it("endpoint auth: a field worker cannot trigger it (403)", async () => {
    const res = await run({ action: "run", role: "electrician" });
    expect(res.statusCode).toBe(403);
  });

  it("a copy failure makes the run report failed (HTTP 500) and the audit entry says so", async () => {
    store.set("ghost.json", "{}");
    const sdk = requireFromHere.cache[blobSdkPath]!.exports as { copy: ReturnType<typeof vi.fn> };
    sdk.copy.mockImplementationOnce(async () => {
      throw new Error("blob unavailable");
    });
    const res = await run({ action: "run", role: "boss" });
    expect(res.statusCode).toBe(500);
    expect((res.body as { ok: boolean }).ok).toBe(false);
    expect((audits[0]!.metadata as { ok: boolean; failedCount: number }).ok).toBe(false);
    expect((audits[0]!.metadata as { failedCount: number }).failedCount).toBeGreaterThan(0);
  });
});

describe("retention rule (pure)", () => {
  it("keeps the newest 14 dailies plus Mondays within 8 weeks, prunes the rest", () => {
    const now = new Date("2026-06-11T00:00:00Z"); // a Thursday
    const dates: string[] = [];
    for (let i = 0; i < 60; i++) {
      const d = new Date(now.getTime() - i * 86_400_000);
      dates.push(d.toISOString().slice(0, 10));
    }
    const { keep, prune } = backupLib.computeRetention(dates, now);
    for (let i = 0; i < 14; i++) {
      expect(keep).toContain(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
    }
    expect(keep).toContain("2026-05-18"); // Monday, 24 days back — weekly anchor
    expect(keep).toContain("2026-04-20"); // Monday, 52 days back — still within 56
    expect(prune).toContain("2026-05-12"); // Tuesday, 30 days back — pruned
    expect(prune.length).toBeGreaterThan(0);
  });

  it("never prunes folder names it doesn't understand (pre-restore safety copies)", () => {
    const { keep, prune } = backupLib.computeRetention(
      ["2020-01-01", "pre-restore-2026-06-11T00-00-00-000Z"],
      new Date("2026-06-11T00:00:00Z")
    );
    expect(keep).toContain("pre-restore-2026-06-11T00-00-00-000Z");
    expect(keep).toContain("2020-01-01"); // within newest-14 of what exists
    expect(prune).toEqual([]);
  });

  it("pruneSnapshots deletes every blob under pruned dates only", async () => {
    // 20 snapshot dates of one file each, all non-Monday-aligned far past
    for (let i = 0; i < 20; i++) {
      const d = new Date(Date.UTC(2026, 0, 6 + i)); // Jan 2026
      store.set(`backups/${d.toISOString().slice(0, 10)}/users.json`, "{}");
    }
    const { pruned, deletedBlobs } = await backupLib.pruneSnapshots({
      now: new Date("2026-06-11T00:00:00Z"),
    });
    // all 20 are older than the daily window; only Mondays within 56 days survive (none)
    expect(pruned.length).toBe(6); // 20 dates − newest 14 kept by count
    expect(deletedBlobs).toBe(6);
    expect(store.has("backups/2026-01-06/users.json")).toBe(false); // oldest pruned
    expect(store.has("backups/2026-01-25/users.json")).toBe(true); // within newest 14
  });
});

describe("restore drill (#151 AC — executed against this non-production store)", () => {
  it("snapshot → clobber → dry-run (no write) → apply → byte-identical recovery + safety copy", async () => {
    const original = store.get("users.json")!;

    // 1. snapshot
    await backupLib.runSnapshot({ date: "2026-06-11" });

    // 2. clobber the live document (the disaster)
    store.set("users.json", JSON.stringify({ users: [] }));

    // 3. dry-run: reports the difference, writes NOTHING
    const dry = await backupLib.restoreDocument({
      date: "2026-06-11",
      pathname: "users.json",
      apply: false,
    });
    expect(dry.applied).toBe(false);
    expect(dry.diff.identical).toBe(false);
    expect(dry.diff.backup.shape).toEqual({ kind: "object", keys: 1, arrays: { users: 2 } });
    expect(dry.diff.current.shape).toEqual({ kind: "object", keys: 1, arrays: { users: 0 } });
    expect(store.get("users.json")).toBe(JSON.stringify({ users: [] })); // untouched

    // 4. apply: pre-restore safety copy + recovery
    const applied = await backupLib.restoreDocument({
      date: "2026-06-11",
      pathname: "users.json",
      apply: true,
      now: new Date("2026-06-11T10:00:00Z"),
    });
    expect(applied.applied).toBe(true);
    expect(JSON.parse(store.get("users.json")!)).toEqual(JSON.parse(original));
    const safetyKey = [...store.keys()].find((k) => k.startsWith("backups/pre-restore-"));
    expect(safetyKey).toBeTruthy();
    expect(store.get(safetyKey!)).toBe(JSON.stringify({ users: [] })); // the clobbered state is itself recoverable
  });

  it("refuses to restore a non-canonical path or a missing snapshot", async () => {
    await backupLib.runSnapshot({ date: "2026-06-11" });
    await expect(
      backupLib.restoreDocument({ date: "2026-06-11", pathname: "backups/evil.json" })
    ).rejects.toThrow(/not a canonical/);
    await expect(
      backupLib.restoreDocument({ date: "1999-01-01", pathname: "users.json" })
    ).rejects.toThrow(/no snapshot/);
  });

  it("lists snapshot dates for the endpoint and the restore script", async () => {
    await backupLib.runSnapshot({ date: "2026-06-10" });
    await backupLib.runSnapshot({ date: "2026-06-11" });
    expect(await backupLib.listSnapshotDates()).toEqual(["2026-06-10", "2026-06-11"]);
    const res = await run({ action: "list", role: "boss" });
    expect(res.statusCode).toBe(200);
    expect((res.body as { dates: string[] }).dates).toContain("2026-06-11");
  });
});
