import { beforeEach, describe, expect, it, vi } from "vitest";

const flags: Record<string, boolean> = {};
vi.mock("../../../api/_lib/feature-flags.js", () => ({
  isFlagEnabled: vi.fn(async (key: string) => flags[key] === true),
}));

import { philSharpenedFlags } from "./sharpened";

describe("philSharpenedFlags", () => {
  beforeEach(() => {
    for (const k of Object.keys(flags)) delete flags[k];
  });

  it("resolves phil_sharpened", async () => {
    flags.phil_sharpened = true;
    expect((await philSharpenedFlags({ role: "tradie" })).sharpened).toBe(true);
  });

  it("never reports job rooms while no rooms view exists — even with phil_job_rooms ON", async () => {
    // Production has phil_job_rooms ON; the view that registers the in-job bar
    // left with #916, so a rooms bar would be four dead buttons (2026-09-23).
    flags.phil_sharpened = true;
    flags.phil_job_rooms = true;
    expect(await philSharpenedFlags({ role: "tradie" })).toEqual({ sharpened: true, jobRooms: false });
  });
});
