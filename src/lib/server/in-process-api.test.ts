import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/**
 * api/_lib/in-process-api.js — office pages run GET /api/<handler> inside their
 * own function (owner, 2026-10-09: "the admin side is slow"). Same handler, same
 * auth (cookie passed through), same answer as over HTTP; anything it can't run
 * falls back to the network fetch.
 */
const requireFromHere = createRequire(import.meta.url);
const { inProcessFetch, handlerKeyOf, queryObject, HANDLER_KEYS } = requireFromHere("../../../api/_lib/in-process-api.js");

type Req = { method: string; url: string; query: Record<string, unknown>; headers: Record<string, string> };
type Res = { status(c: number): Res; json(b: unknown): Res; setHeader(k: string, v: string): Res; end(b?: unknown): Res };

function deps(handler: (req: Req, res: Res) => unknown) {
  const fallback = vi.fn(async () => new Response(JSON.stringify({ via: "network" }), { status: 200 }));
  const lines: string[] = [];
  return {
    fallback,
    lines,
    d: { fetch: fallback, log: (l: string) => lines.push(l), handlers: { "time-entries": () => handler } },
  };
}

describe("inProcessFetch", () => {
  it("runs the handler in-process with the query, cookie and host, and returns a real Response", async () => {
    let seen: Req | null = null;
    const { d, fallback, lines } = deps((req, res) => {
      seen = req;
      res.setHeader("Cache-Control", "private, no-store");
      return res.status(200).json({ entries: [{ id: "e1" }] });
    });
    const res: Response = await inProcessFetch(
      "https://buhlos.com/api/time-entries?scope=approver&status=submitted",
      { cache: "no-store", headers: { cookie: "buhl_session=abc" } },
      d,
    );
    expect(res.ok).toBe(true);
    expect(await res.json()).toEqual({ entries: [{ id: "e1" }] });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(seen).toMatchObject({
      method: "GET",
      url: "/api/time-entries?scope=approver&status=submitted",
      query: { scope: "approver", status: "submitted" },
      headers: { cookie: "buhl_session=abc", host: "buhlos.com", "x-forwarded-proto": "https" },
    });
    expect(fallback).not.toHaveBeenCalled();
    // the perf line names the path and query KEYS only — never ids, dates or names
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[perf\] in-process \/api\/time-entries\?scope&status \d+ms 200$/);
    expect(lines[0]).not.toContain("approver");
  });

  it("passes the handler's error status through unchanged (a 401 stays a 401)", async () => {
    const { d } = deps((_req, res) => res.status(401).json({ error: "unauthorized" }));
    const res: Response = await inProcessFetch("/api/time-entries", {}, d);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("falls back to the network for unknown paths, non-GETs, and a handler that throws", async () => {
    const throwing = deps(() => {
      throw new Error("boom");
    });
    expect(await (await inProcessFetch("/api/time-entries", {}, throwing.d)).json()).toEqual({ via: "network" });
    expect(throwing.fallback).toHaveBeenCalledTimes(1);
    expect(throwing.lines[0]).toContain("falling back to fetch");

    const ok = deps((_req, res) => res.status(200).json({}));
    await inProcessFetch("/api/not-listed", {}, ok.d);
    await inProcessFetch("/api/time-entries", { method: "POST" }, ok.d);
    expect(ok.fallback).toHaveBeenCalledTimes(2);
  });

  it("a handler that never answers is a 500 (it would hang over HTTP), and a 204 has no body", async () => {
    const silent = deps(() => undefined);
    expect((await inProcessFetch("/api/time-entries", {}, silent.d)).status).toBe(500);
    const empty = deps((_req, res) => res.status(204).end());
    const r: Response = await inProcessFetch("/api/time-entries", {}, empty.d);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
  });

  it("only knows real api files, and parses repeated query keys like Vercel", () => {
    expect(handlerKeyOf("/api/time-entries")).toBe("time-entries");
    expect(handlerKeyOf("/api/../etc")).toBeNull();
    expect(handlerKeyOf("/api/unknown")).toBeNull();
    expect(queryObject(new URLSearchParams("a=1&a=2&b=3"))).toEqual({ a: ["1", "2"], b: "3" });
    // every mapped key is a real file under api/
    for (const key of HANDLER_KEYS as string[]) {
      expect(() => requireFromHere.resolve(`../../../api/${key}.js`), key).not.toThrow();
    }
  });
});

describe("listTimeEntryBlobs — one listing in flight at a time, never cached after", () => {
  it("concurrent callers share one list() call; a later caller lists again", async () => {
    const blobPath = requireFromHere.resolve("@vercel/blob");
    const listPath = requireFromHere.resolve("../../../api/_lib/time-entry-blobs.js");
    const list = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { blobs: [{ pathname: "users/u1/time-entries/2026-10-01.json", url: "https://x/u1" }], hasMore: false };
    });
    const saved = requireFromHere.cache[blobPath];
    requireFromHere.cache[blobPath] = { id: blobPath, filename: blobPath, loaded: true, exports: { list } } as NodeJS.Module;
    delete requireFromHere.cache[listPath];
    try {
      const { listTimeEntryBlobs } = requireFromHere(listPath);
      const [a, b, c] = await Promise.all([listTimeEntryBlobs(), listTimeEntryBlobs(), listTimeEntryBlobs()]);
      expect(list).toHaveBeenCalledTimes(1);
      expect(a).toEqual(b);
      expect(a).not.toBe(b); // each caller gets its own array
      expect(c).toHaveLength(1);
      await listTimeEntryBlobs();
      expect(list).toHaveBeenCalledTimes(2); // settled → the next caller lists afresh
    } finally {
      if (saved) requireFromHere.cache[blobPath] = saved;
      else delete requireFromHere.cache[blobPath];
      delete requireFromHere.cache[listPath];
    }
  });
});
