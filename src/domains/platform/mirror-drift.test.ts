import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

/**
 * DWD-04 — recordMirrorDrift turns a silent Blob-ok / PG-fail divergence into a
 * visible signal on the error journal. It is NARROW: it fires ONLY on a genuine
 * PG error (reason:'error'), never on gated/unmirrored skips or a clean mirror,
 * threads context (domain/jobId/key), and is best-effort (never throws).
 */
const requireFromHere = createRequire(import.meta.url);
const { recordMirrorDrift } = requireFromHere(
  requireFromHere.resolve("../../../api/_lib/mirror-drift.js"),
) as {
  recordMirrorDrift: (args: {
    domain?: string;
    result?: { reason?: string; error?: string; partial?: boolean } | null;
    jobId?: string;
    key?: string;
    capture?: (p: Record<string, unknown>) => Promise<unknown>;
  }) => Promise<void>;
};

describe("recordMirrorDrift — DWD-04 drift visibility", () => {
  it("captures a warning when the PG write errored after Blob succeeded", async () => {
    const capture = vi.fn(async (_p: Record<string, unknown>) => ({}));
    await recordMirrorDrift({ domain: "tasks", result: { reason: "error", error: "pooler down" }, jobId: "j1", key: "jobs/j1/data.json", capture });
    expect(capture).toHaveBeenCalledTimes(1);
    const arg = capture.mock.calls[0]![0]!;
    expect(arg).toMatchObject({
      source: "api",
      handler: "mirror-drift",
      severity: "warning",
      jobId: "j1",
      metadata: { domain: "tasks", jobId: "j1", key: "jobs/j1/data.json", reason: "error", error: "pooler down" },
    });
    expect(String(arg.message)).toMatch(/tasks PG write failed after Blob succeeded/);
  });

  it("captures a warning on a PARTIAL write — PG accepted an INCOMPLETE row", async () => {
    // The hours mirror upserts a time_entry but quarantines its allocations when
    // the allocated job was never mirrored. It used to report {mirrored:true}, so
    // this divergence never reached the owner console and a read cutover served
    // the broken row. A present-but-wrong row is drift.
    const capture = vi.fn(async (_p: Record<string, unknown>) => ({}));
    await recordMirrorDrift({
      domain: "hours",
      result: { mirrored: false, partial: true, reason: "allocations quarantined", error: 'time_entry mirrored WITHOUT its allocations: allocation[0] job "dca-alexandria" not imported' } as never,
      key: "users/u1/time-entries/2026-07-16.json",
      capture,
    });
    expect(capture).toHaveBeenCalledTimes(1);
    const arg = capture.mock.calls[0]![0]!;
    expect(String(arg.message)).toMatch(/hours PG row mirrored INCOMPLETE after Blob succeeded/);
    expect(String(arg.message)).toMatch(/dca-alexandria/);
    expect(arg).toMatchObject({ severity: "warning", metadata: { domain: "hours", partial: true, reason: "allocations quarantined" } });
  });

  it("does NOT capture on gated/unmirrored/ok results (no noise while flags are dark)", async () => {
    const capture = vi.fn(async () => ({}));
    for (const result of [
      { reason: "no supabase env" },
      { reason: "flag off" },
      { reason: "tenant/user not mirrored" },
      { reason: "job not in pg" },
      { mirrored: true },
      { pg: true, changed: true },
      null,
      undefined,
    ] as Array<{ reason?: string } | null | undefined>) {
      await recordMirrorDrift({ domain: "hours", result, capture });
    }
    expect(capture).not.toHaveBeenCalled();
  });

  it("is best-effort — a throwing capture is swallowed, never propagates", async () => {
    const capture = vi.fn(async () => { throw new Error("journal down"); });
    await expect(
      recordMirrorDrift({ domain: "hours", result: { reason: "error" }, capture }),
    ).resolves.toBeUndefined();
    expect(capture).toHaveBeenCalledTimes(1);
  });
});
