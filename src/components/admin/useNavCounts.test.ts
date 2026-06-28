import { describe, expect, it } from "vitest";
import { deriveNavCounts, type NavCountPayloads } from "./useNavCounts";

/**
 * deriveNavCounts is the pure reducer behind the sidebar badges. The contract
 * that matters: real numbers from real payloads, and — per the honesty rule —
 * NO key (and so no badge) when a source failed, never a fabricated 0.
 */

const EMPTY: NavCountPayloads = {
  stats: null,
  hours: null,
  observations: null,
  materials: null,
  expenses: null,
  gear: null,
};

describe("deriveNavCounts", () => {
  it("derives every wired count from well-formed payloads", () => {
    const counts = deriveNavCounts({
      stats: {
        jobs: { active: 7 },
        users: { byRole: { admin: 2, leadingHand: 3, tradie: 10, client: 5 } },
        snags: { openTotal: 4 },
      },
      hours: { entries: [{}, {}, {}] },
      observations: {
        observations: [
          { status: "needs_action", requiresAction: true },
          { status: "new", requiresAction: true },
          { status: "new", requiresAction: false }, // open but not actionable
          { status: "resolved", requiresAction: true }, // actionable but closed
        ],
      },
      materials: {
        requests: [
          { status: "requested" },
          { status: "approved" },
          { status: "delivered" }, // terminal
        ],
      },
      expenses: { expenses: [{}, {}] },
      gear: { tags: [{}, {}], calibrations: [{}] },
    });

    expect(counts).toEqual({
      jobs: 7,
      people: 15, // 2 + 3 + 10 — clients excluded
      defects: 4,
      hours: 3,
      obs: 2, // only open AND requiresAction
      mats: 2, // only requested + approved
      exp: 2,
      gear: 3, // tags + calibrations
    });
  });

  it("omits a key entirely when its source failed (null) — never a fake 0", () => {
    expect(deriveNavCounts(EMPTY)).toEqual({});
  });

  it("distinguishes loaded-empty (0) from failed (absent)", () => {
    const loadedEmpty = deriveNavCounts({
      ...EMPTY,
      observations: { observations: [] },
      materials: { requests: [] },
      expenses: { expenses: [] },
    });
    expect(loadedEmpty.obs).toBe(0);
    expect(loadedEmpty.mats).toBe(0);
    expect(loadedEmpty.exp).toBe(0);
    // Failed sources still absent.
    expect(loadedEmpty.jobs).toBeUndefined();
    expect(loadedEmpty.gear).toBeUndefined();
  });

  it("sums gear from tags and calibrations independently", () => {
    expect(deriveNavCounts({ ...EMPTY, gear: { tags: [{}, {}] } }).gear).toBe(2);
    expect(deriveNavCounts({ ...EMPTY, gear: { calibrations: [{}] } }).gear).toBe(1);
    expect(deriveNavCounts({ ...EMPTY, gear: { tags: [], calibrations: [] } }).gear).toBe(0);
  });

  it("reads partial admin-stats without inventing the missing sub-counts", () => {
    const counts = deriveNavCounts({ ...EMPTY, stats: { jobs: { active: 5 } } });
    expect(counts.jobs).toBe(5);
    expect(counts.people).toBeUndefined();
    expect(counts.defects).toBeUndefined();
  });

  it("survives garbage payloads without throwing or fabricating", () => {
    const counts = deriveNavCounts({
      stats: 42,
      hours: "nope",
      observations: { observations: "not-an-array" },
      materials: [],
      expenses: { wrong: "shape" },
      gear: true,
    });
    expect(counts).toEqual({});
  });
});
