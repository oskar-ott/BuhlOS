import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #355 — audit-log durability framework slice.
 *
 * Exercises api/_lib/audit-log.js's append() directly against a stateful
 * in-memory blob mock (the createRequire cache-substitution pattern used across
 * the api-handler suites). Covers:
 *   - blocking mode THROWS on a write failure; default best-effort RESOLVES null
 *   - an unknown action + a failed best-effort write are OBSERVABLE (console.error)
 *   - the 7+ existing best-effort callers are behaviourally unchanged (default arg)
 *
 * The error-journal mirror (api/_lib/error-log.js) is left real but pointed at
 * the same blob mock, so a drop's mirror is a no-op write here — asserted not to
 * throw into append().
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/audit-log.js");
const errorLogPath = requireFromHere.resolve("../../../api/_lib/error-log.js");

type AppendFn = (
  payload: Record<string, unknown>,
  options?: { blocking?: boolean }
) => Promise<Record<string, unknown> | null>;

let blob: Map<string, unknown>;
let writeShouldFail: boolean;
let append: AppendFn;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function clone<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

const VALID_PAYLOAD = {
  action: "job.deleted",
  actorId: "u_admin",
  actorName: "Daniel",
  actorRole: "admin",
  jobId: "smoke-test-1",
  targetType: "job",
  targetId: "smoke-test-1",
  summary: 'test job deleted — "SMOKE_TEST_1" (draft)',
};

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

beforeEach(() => {
  blob = new Map<string, unknown>();
  writeShouldFail = false;
  consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  delete requireFromHere.cache[auditPath];
  delete requireFromHere.cache[errorLogPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: {
      readBlob: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      readBlobFresh: vi.fn(async (key: string, fallback: unknown) =>
        blob.has(key) ? clone(blob.get(key)) : fallback
      ),
      writeBlob: vi.fn(async (key: string, data: unknown) => {
        if (writeShouldFail) throw new Error("blob write boom");
        blob.set(key, clone(data));
      }),
      setNoCache: vi.fn(),
    },
  } as NodeJS.Module;

  ({ append } = requireFromHere(auditPath) as { append: AppendFn });
});

describe("append() default best-effort (unchanged for the existing callers)", () => {
  it("writes the entry and returns it on success", async () => {
    const entry = await append(VALID_PAYLOAD);
    expect(entry).toMatchObject({ action: "job.deleted", targetId: "smoke-test-1" });
    const monthKey = [...blob.keys()].find((k) => k.startsWith("audit/"));
    expect(monthKey).toBeDefined();
    const file = blob.get(monthKey as string) as { entries: unknown[] };
    expect(file.entries).toHaveLength(1);
  });

  it("SWALLOWS a write failure — resolves null, never throws (the .catch contract)", async () => {
    writeShouldFail = true;
    // No options arg — exactly how the 7+ existing handlers call it.
    await expect(append(VALID_PAYLOAD)).resolves.toBeNull();
  });
});

describe("append(payload, { blocking: true })", () => {
  it("THROWS on a write failure so the caller learns the audit was lost", async () => {
    writeShouldFail = true;
    await expect(append(VALID_PAYLOAD, { blocking: true })).rejects.toThrow(/blob write boom/);
  });

  it("returns the entry on success just like best-effort", async () => {
    const entry = await append(VALID_PAYLOAD, { blocking: true });
    expect(entry).toMatchObject({ action: "job.deleted" });
  });

  it("still returns null (does NOT throw) for an unknown action — a bad verb is a caller bug, not a storage failure", async () => {
    await expect(
      append({ ...VALID_PAYLOAD, action: "job.obliterated" }, { blocking: true })
    ).resolves.toBeNull();
  });
});

describe("observable drops (#355 — silent drops become visible)", () => {
  it("console.errors an unknown action with context, then returns null", async () => {
    const r = await append({ ...VALID_PAYLOAD, action: "job.obliterated" });
    expect(r).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
    const call = consoleErrorSpy.mock.calls.find(([msg]) =>
      String(msg).includes("dropped")
    );
    expect(call).toBeDefined();
    expect(String(call?.[0])).toMatch(/unknown-action/);
    // The context object carries the action/actor/target for searchability.
    expect(call?.[1]).toMatchObject({ action: "job.obliterated", targetId: "smoke-test-1" });
  });

  it("console.errors a failed best-effort write (not swallowed silently)", async () => {
    writeShouldFail = true;
    const r = await append(VALID_PAYLOAD);
    expect(r).toBeNull();
    const call = consoleErrorSpy.mock.calls.find(([msg]) =>
      String(msg).includes("dropped (write-failed)")
    );
    expect(call).toBeDefined();
  });

  it("does NOT console.error a drop on a clean success", async () => {
    await append(VALID_PAYLOAD);
    const dropCall = consoleErrorSpy.mock.calls.find(([msg]) =>
      String(msg).includes("dropped")
    );
    expect(dropCall).toBeUndefined();
  });
});
