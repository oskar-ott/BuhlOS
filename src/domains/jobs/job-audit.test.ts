import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * api/_lib/job-audit.js — the per-job structural audit trail.
 *
 * 2026-10-15 (shorter-paths audit): one job save can produce several audit
 * kinds (status + basics + areas + tasks). They used to be appended one at a
 * time — a serial read+put on the same blob per kind, paid before the save
 * could respond. appendAuditMany folds them into ONE read-modify-write; this
 * pins that (one read, one write, every entry kept, same shape, same trim).
 */

const requireFromHere = createRequire(import.meta.url);
const blobPath = requireFromHere.resolve("../../../api/_lib/blob.js");
const auditPath = requireFromHere.resolve("../../../api/_lib/job-audit.js");

type AuditEntry = { kind: string; summary: string; byUserId?: string; byUsername?: string };
type AuditModule = {
  readAudit: (jobId: string) => Promise<AuditEntry[]>;
  appendAudit: (jobId: string, entry: AuditEntry) => Promise<void>;
  appendAuditMany: (jobId: string, entries: AuditEntry[]) => Promise<void>;
};

let store: Map<string, unknown>;
let readBlob: ReturnType<typeof vi.fn>;
let writeBlob: ReturnType<typeof vi.fn>;
let audit: AuditModule;

beforeEach(() => {
  store = new Map<string, unknown>();
  readBlob = vi.fn(async (key: string, fallback: unknown) =>
    store.has(key) ? JSON.parse(JSON.stringify(store.get(key))) : fallback
  );
  writeBlob = vi.fn(async (key: string, data: unknown) => {
    store.set(key, JSON.parse(JSON.stringify(data)));
  });
  delete requireFromHere.cache[auditPath];
  requireFromHere.cache[blobPath] = {
    id: blobPath,
    filename: blobPath,
    loaded: true,
    exports: { readBlob, writeBlob, setNoCache: vi.fn() },
  } as NodeJS.Module;
  audit = requireFromHere(auditPath);
});

describe("appendAuditMany", () => {
  it("writes every kind of one save in a single read-modify-write", async () => {
    await audit.appendAuditMany("job-1", [
      { kind: "status", summary: "Status draft → active", byUserId: "u1", byUsername: "Oskar" },
      { kind: "basics", summary: "Updated job basics", byUserId: "u1", byUsername: "Oskar" },
      { kind: "areas", summary: "Areas 0 → 3", byUserId: "u1", byUsername: "Oskar" },
    ]);
    expect(readBlob).toHaveBeenCalledTimes(1);
    expect(writeBlob).toHaveBeenCalledTimes(1);
    const entries = await audit.readAudit("job-1");
    expect(entries.map((e) => e.kind)).toEqual(["status", "basics", "areas"]);
    expect(entries.every((e) => e.byUsername === "Oskar")).toBe(true);
  });

  it("appends after what is already there and skips malformed items", async () => {
    await audit.appendAudit("job-1", { kind: "status", summary: "first" });
    await audit.appendAuditMany("job-1", [
      { kind: "", summary: "no kind" } as AuditEntry,
      { kind: "tasks", summary: "Rough-in tasks 2 → 4" },
    ]);
    const entries = await audit.readAudit("job-1");
    expect(entries.map((e) => e.summary)).toEqual(["first", "Rough-in tasks 2 → 4"]);
  });

  it("writes nothing for an empty or all-invalid batch", async () => {
    await audit.appendAuditMany("job-1", []);
    await audit.appendAuditMany("job-1", [{ kind: "x", summary: "" }]);
    expect(writeBlob).not.toHaveBeenCalled();
  });

  it("keeps the 500-entry cap (trims to 400) across a batch", async () => {
    store.set("jobs/job-1/audit.json", {
      entries: Array.from({ length: 499 }, (_, i) => ({ kind: "k", summary: `s${i}` })),
    });
    await audit.appendAuditMany("job-1", [
      { kind: "a", summary: "a" },
      { kind: "b", summary: "b" },
    ]);
    const entries = await audit.readAudit("job-1");
    expect(entries).toHaveLength(400);
    expect(entries[entries.length - 1]?.kind).toBe("b");
  });
});
