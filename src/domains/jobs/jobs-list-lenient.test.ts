import { describe, expect, it, vi } from "vitest";
import { JobListResponseSchema } from "./schema";

/**
 * #383 — the documented lenient-list decision: a single bad row (legacy
 * out-of-enum status etc.) drops with a logged warning instead of failing
 * the entire jobs list parse for every admin and worker.
 */
describe("JobListResponseSchema — lenient row drop (#383)", () => {
  it("keeps good rows and drops the bad one with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const parsed = JobListResponseSchema.safeParse({
      jobs: [
        { id: "j1", name: "Good", status: "active" },
        { id: "j2", name: "Legacy", status: "paused" }, // never in the enum
        { id: "j3", name: "Also good", status: "draft" },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.jobs.map((j) => j.id)).toEqual(["j1", "j3"]);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0])).toContain("j2");
    warn.mockRestore();
  });

  it("an all-good list parses identically to before", () => {
    const parsed = JobListResponseSchema.safeParse({
      jobs: [{ id: "j1", name: "Good", status: "active" }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.jobs).toHaveLength(1);
  });
});
