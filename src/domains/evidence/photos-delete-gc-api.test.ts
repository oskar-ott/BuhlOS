import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FILE-02 — api/photos.js DELETE (dwelling photo) must reclaim the blob bytes.
 *
 * The dwelling-photo DELETE strips the photos-index entry — the ONLY reference
 * to jobs/<jobId>/photos/<photoId>.jpg — but historically never deleted the
 * blob, orphaning the bytes forever. This is a genuine HARD removal (no
 * soft-delete / deleted_at, not restorable), so a best-effort deleteBlob is
 * wired AFTER the index write commits. These tests pin that behaviour:
 *   - a real removal calls deleteBlob with the exact key, after the index write;
 *   - a no-op delete (id absent) does NOT touch any bytes.
 *
 * Real-handler harness: _lib/blob, _lib/auth and the raw @vercel/blob SDK are
 * injected via the require cache (same pattern as evidence-pairing-api.test.ts).
 */
const requireFromHere = createRequire(import.meta.url);
const blobLibPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const blobSdkPath = requireFromHere.resolve("@vercel/blob");
const authPath = requireFromHere.resolve("../../../api/_lib/auth.js");
const handlerPath = requireFromHere.resolve("../../../api/photos.js");

const JOB = "job-1";
const INDEX_KEY = `jobs/${JOB}/photos-index.json`;

let store: Map<string, unknown>;
let deleteBlobCalls: string[];
let handler: (
  req: Record<string, unknown>,
  res: ReturnType<typeof createRes>
) => Promise<unknown>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
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

function urlFor(pathname: string): string {
  return `https://blob.test/${encodeURIComponent(pathname)}`;
}

async function del(body: Record<string, unknown>) {
  const res = createRes();
  await handler(
    {
      method: "DELETE",
      query: { jobId: JOB },
      headers: {},
      body,
    },
    res
  );
  return res;
}

beforeEach(() => {
  store = new Map<string, unknown>();
  deleteBlobCalls = [];

  for (const p of [blobLibPath, blobSdkPath, authPath, handlerPath]) {
    delete requireFromHere.cache[p];
  }

  // _lib/blob: readBlob is unused by the index path (photos.js has its OWN
  // readIndex via the raw SDK), but writeIndex uses the raw put(). We only need
  // setNoCache + deleteBlob (the reclaim under test).
  requireFromHere.cache[blobLibPath] = {
    id: blobLibPath,
    filename: blobLibPath,
    loaded: true,
    exports: {
      setNoCache: vi.fn(),
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        store.has(key) ? clone(store.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => store.set(key, clone(data))),
      deleteBlob: vi.fn(async (key: string) => {
        deleteBlobCalls.push(key);
        store.delete(key);
      }),
    },
  } as NodeJS.Module;

  // raw @vercel/blob: photos.js readIndex()/writeIndex() use list/put; the
  // dwelling DELETE path itself doesn't call the raw del().
  requireFromHere.cache[blobSdkPath] = {
    id: blobSdkPath,
    filename: blobSdkPath,
    loaded: true,
    exports: {
      list: vi.fn(async (opts: { prefix?: string }) => {
        const prefix = opts.prefix ?? "";
        const blobs = [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((pathname) => ({ pathname, url: urlFor(pathname) }));
        return { blobs };
      }),
      put: vi.fn(async (pathname: string, body: string) => {
        store.set(pathname, JSON.parse(String(body)));
        return { url: urlFor(pathname) };
      }),
      del: vi.fn(async () => {}),
    },
  } as NodeJS.Module;

  // readIndex() fetches the index blob's URL directly (bypasses _lib/blob).
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const pathname = decodeURIComponent(new URL(url.split("?")[0]!).pathname.slice(1));
      const value = store.get(pathname);
      return {
        ok: value !== undefined,
        status: value !== undefined ? 200 : 404,
        json: async () => value,
      };
    })
  );

  // auth: allow the write.
  requireFromHere.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      requireAuth: vi.fn(async () => ({ id: "u1", username: "sparky", role: "electrician" })),
      canWrite: vi.fn(() => true),
    },
  } as NodeJS.Module;

  handler = requireFromHere(handlerPath) as typeof handler;
});

describe("photos.js DELETE — orphan-byte reclaim", () => {
  it("deletes the blob bytes after removing the index entry", async () => {
    const photoId = "1718000000000_abc123";
    const blobKey = `jobs/${JOB}/photos/${photoId}.jpg`;
    // index references the photo; the binary exists.
    store.set(INDEX_KEY, {
      "lot-4": [{ id: photoId, url: urlFor(blobKey) }],
    });
    store.set(blobKey, "JPEGBYTES");

    const res = await del({ dwelling: "lot-4", photoId });

    expect(res.statusCode).toBe(200);
    // index entry stripped
    const idx = store.get(INDEX_KEY) as Record<string, unknown[]>;
    expect(idx["lot-4"]).toEqual([]);
    // bytes reclaimed with the exact key
    expect(deleteBlobCalls).toEqual([blobKey]);
    expect(store.has(blobKey)).toBe(false);
  });

  it("does NOT reclaim bytes when the photoId is not in the index (no-op delete)", async () => {
    const blobKey = `jobs/${JOB}/photos/keep_me_00001.jpg`;
    store.set(INDEX_KEY, {
      "lot-4": [{ id: "keep_me_00001", url: urlFor(blobKey) }],
    });
    store.set(blobKey, "JPEGBYTES");

    const res = await del({ dwelling: "lot-4", photoId: "not-present-999" });

    expect(res.statusCode).toBe(200);
    // nothing removed, nothing reclaimed
    expect(deleteBlobCalls).toEqual([]);
    expect(store.has(blobKey)).toBe(true);
  });
});
