import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Unit tests for the area-id uniqueness guard in api/_lib/validation.js
 * (validateAreaGroups). The whole Phil + task-state stack keys on areaId
 * (dwellings[areaId][stage].tasks[taskId], /api/task-toggle's write target,
 * the Phil area selector's first-match find, the canonical task index
 * filter), so two live areas in one job sharing an id silently mis-key.
 * Ids are normally nanoid-minted, but a client-supplied `a.id` is trusted
 * verbatim — this guard is the authoritative enforcement of the invariant.
 *
 * validateAreaGroups is a pure { ok, ... } function, so we exercise it
 * directly (no blob/auth harness needed). It's a CommonJS module under
 * api/, which vitest excludes from compilation, so we createRequire it the
 * same way jobs-api.test.ts loads the serverless handlers.
 */
const requireFromHere = createRequire(import.meta.url);

type AreaOut = { id: string; name: string; archived?: boolean };
type GroupOut = { id: string; name: string; areas: AreaOut[] };
type Result = { ok: true; groups: GroupOut[] } | { ok: false; error: string };

const { validateAreaGroups, findDuplicateLiveAreaId } = requireFromHere(
  "../../../api/_lib/validation.js",
) as {
  validateAreaGroups: (raw: unknown, fieldName?: string) => Result;
  findDuplicateLiveAreaId: (areaGroups: unknown) => string | null;
};

function flatAreas(result: Result): AreaOut[] {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.groups.flatMap((g) => g.areas);
}

describe("validateAreaGroups area-id uniqueness", () => {
  it("rejects two non-archived areas sharing an id within the same group", () => {
    const result = validateAreaGroups([
      {
        name: "Level 1",
        areas: [
          { id: "ar_dup", name: "Kitchen" },
          { id: "ar_dup", name: "Bathroom" },
        ],
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("duplicate");
    expect(result.error).toContain("ar_dup");
  });

  it("rejects duplicate non-archived area ids ACROSS groups in the same job", () => {
    const result = validateAreaGroups([
      { name: "Level 1", areas: [{ id: "ar_dup", name: "Kitchen" }] },
      { name: "Level 2", areas: [{ id: "ar_dup", name: "Bedroom" }] },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toContain("ar_dup");
  });

  it("allows a non-archived area to reuse the id of an ARCHIVED area", () => {
    // Archived areas are filtered out before any keying, so they don't collide
    // WHILE archived. Resurrecting the archived one (unarchive) is guarded by
    // the SAME findDuplicateLiveAreaId check on the bulk-edit write path before
    // it persists (see jobs-bulk-edit-api.test.ts) — so the collision is caught
    // at the moment it would become two LIVE areas, not silently written.
    const result = validateAreaGroups([
      {
        name: "Level 1",
        areas: [
          { id: "ar_dup", name: "Old Kitchen", archived: true },
          { id: "ar_dup", name: "New Kitchen" },
        ],
      },
    ]);
    expect(result.ok).toBe(true);
    expect(flatAreas(result).map((a) => a.id)).toEqual(["ar_dup", "ar_dup"]);
  });

  it("allows two archived areas to share an id (fully harmless)", () => {
    const result = validateAreaGroups([
      {
        name: "Level 1",
        areas: [
          { id: "ar_dup", name: "A", archived: true },
          { id: "ar_dup", name: "B", archived: true },
        ],
      },
    ]);
    expect(result.ok).toBe(true);
  });

  it("accepts distinct client-supplied ids unchanged", () => {
    const result = validateAreaGroups([
      {
        name: "Level 1",
        areas: [
          { id: "ar_kitchen", name: "Kitchen" },
          { id: "ar_bath", name: "Bathroom" },
        ],
      },
    ]);
    expect(result.ok).toBe(true);
    expect(flatAreas(result).map((a) => a.id)).toEqual(["ar_kitchen", "ar_bath"]);
  });

  it("mints unique ids for areas without one (no false-positive collision)", () => {
    const result = validateAreaGroups([
      {
        name: "Level 1",
        areas: [{ name: "Kitchen" }, { name: "Bathroom" }, { name: "Hall" }],
      },
    ]);
    expect(result.ok).toBe(true);
    const ids = flatAreas(result).map((a) => a.id);
    expect(ids.every((id) => id.startsWith("ar_"))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("findDuplicateLiveAreaId (shared guard)", () => {
  it("returns null when every live area id is unique", () => {
    expect(
      findDuplicateLiveAreaId([
        { id: "g1", name: "G1", areas: [{ id: "ar_a", name: "A" }, { id: "ar_b", name: "B" }] },
        { id: "g2", name: "G2", areas: [{ id: "ar_c", name: "C" }] },
      ]),
    ).toBeNull();
  });

  it("returns the first repeated LIVE area id (within and across groups)", () => {
    expect(
      findDuplicateLiveAreaId([
        { id: "g1", name: "G1", areas: [{ id: "ar_dup", name: "A" }] },
        { id: "g2", name: "G2", areas: [{ id: "ar_dup", name: "B" }] },
      ]),
    ).toBe("ar_dup");
  });

  it("ignores archived areas — a live area may reuse an archived id", () => {
    expect(
      findDuplicateLiveAreaId([
        {
          id: "g1",
          name: "G1",
          areas: [
            { id: "ar_dup", name: "Old", archived: true },
            { id: "ar_dup", name: "New" },
          ],
        },
      ]),
    ).toBeNull();
  });

  it("flags TWO LIVE areas sharing an id even when an archived copy also exists", () => {
    // This is the on-disk corruption the bulk-edit guard must catch: two live
    // areas keyed the same. (The archived third copy is irrelevant.)
    expect(
      findDuplicateLiveAreaId([
        {
          id: "g1",
          name: "G1",
          areas: [
            { id: "ar_dup", name: "Live A" },
            { id: "ar_dup", name: "Live B" },
            { id: "ar_dup", name: "Archived", archived: true },
          ],
        },
      ]),
    ).toBe("ar_dup");
  });

  it("is pure — does not mutate the input", () => {
    const input = [
      { id: "g1", name: "G1", areas: [{ id: "ar_a", name: "A" }, { id: "ar_a", name: "B" }] },
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    findDuplicateLiveAreaId(input);
    expect(input).toEqual(snapshot);
  });

  it("tolerates malformed input without throwing", () => {
    expect(findDuplicateLiveAreaId(null)).toBeNull();
    expect(findDuplicateLiveAreaId(undefined)).toBeNull();
    expect(findDuplicateLiveAreaId([{ name: "no areas array" }])).toBeNull();
    expect(findDuplicateLiveAreaId([{ areas: [null, { name: "no id" }] }])).toBeNull();
  });
});
