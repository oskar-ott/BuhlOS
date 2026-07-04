import { createRequire } from "node:module";
import { describe, it, expect } from "vitest";

// #206 rooms→areas bridge — validateAreaGroups must PRESERVE the additive
// aiSourceId + provenance fields (an area accepted from a plan room), so the
// accept endpoint's direct write and any round-trip keep the link. The PUT
// remap (api/jobs.js carryMeta) re-attaches them by name; this covers the
// validation layer they both flow through.
const requireFromHere = createRequire(import.meta.url);
const { validateAreaGroups } = requireFromHere("../../../api/_lib/validation.js") as {
  validateAreaGroups: (
    raw: unknown,
    field?: string,
  ) => { ok: true; groups: Array<Record<string, unknown>> } | { ok: false; error: string };
};

describe("validateAreaGroups — AI provenance preservation", () => {
  it("preserves aiSourceId and provenance on an area that carries them", () => {
    const prov = { source: "ai-drawings-room", roomId: "r1", planId: "p1", pageIndex: 0, rev: "B" };
    const res = validateAreaGroups([
      { name: "Level 1", areas: [{ name: "KITCHEN", aiSourceId: "aidr:room:r1", provenance: prov }] },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const area = res.groups[0]!.areas as Array<Record<string, unknown>>;
    expect(area[0]!.aiSourceId).toBe("aidr:room:r1");
    expect(area[0]!.provenance).toEqual(prov);
    // still mints an id for a room-sourced area (none supplied)
    expect(typeof area[0]!.id).toBe("string");
  });

  it("leaves a normal area with no provenance keys untouched", () => {
    const res = validateAreaGroups([{ name: "Level 1", areas: [{ name: "HALL" }] }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const area = (res.groups[0]!.areas as Array<Record<string, unknown>>)[0]!;
    expect("aiSourceId" in area).toBe(false);
    expect("provenance" in area).toBe(false);
  });

  it("rejects a non-string aiSourceId", () => {
    const res = validateAreaGroups([{ name: "L1", areas: [{ name: "KITCHEN", aiSourceId: 42 }] }]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/aiSourceId/);
  });

  it("rejects a non-object provenance (e.g. an array)", () => {
    const res = validateAreaGroups([{ name: "L1", areas: [{ name: "KITCHEN", provenance: ["nope"] }] }]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/provenance/);
  });

  it("caps a runaway aiSourceId to a tidy length", () => {
    const res = validateAreaGroups([
      { name: "L1", areas: [{ name: "KITCHEN", aiSourceId: "x".repeat(500) }] },
    ]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const area = (res.groups[0]!.areas as Array<Record<string, unknown>>)[0]!;
    expect((area.aiSourceId as string).length).toBe(200);
  });
});
