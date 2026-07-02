import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  LABEL_CONFIDENCE_DISPLAY_MIN,
  PHOTO_LABEL_TAXONOMY,
  POSSIBLE_DEFECT_CONFIDENCE_MIN,
  isUnlabelled,
  hasVisibleLabel,
  needsClassification,
  visibleLabels,
  type EvidenceLabelEntry,
} from "./labels";

/**
 * #262 — AI photo labels. Client display rules + the server authority's
 * merge/correction logic (api/_lib/photo-labels.js), plus the sync test that
 * keeps the two constant sets identical (audit-log enum precedent).
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const server = requireFromHere("../../../api/_lib/photo-labels.js");

const aiEntry = (over: Partial<EvidenceLabelEntry> = {}): EvidenceLabelEntry => ({
  label: "switchboard",
  source: "ai",
  status: "suggested",
  confidence: 0.9,
  modelVersion: "m1",
  promptVersion: "photo-labels-v1",
  at: "2026-07-02T10:00:00.000Z",
  ...over,
});

describe("taxonomy stays in sync with the server authority", () => {
  it("labels, thresholds and prompt version match api/_lib/photo-labels.js", () => {
    expect([...PHOTO_LABEL_TAXONOMY]).toEqual(server.PHOTO_LABEL_TAXONOMY);
    expect(LABEL_CONFIDENCE_DISPLAY_MIN).toBe(server.LABEL_CONFIDENCE_DISPLAY_MIN);
    expect(POSSIBLE_DEFECT_CONFIDENCE_MIN).toBe(server.POSSIBLE_DEFECT_CONFIDENCE_MIN);
  });

  it("possible-defect ships in the v1 taxonomy (the #267 contract)", () => {
    expect(PHOTO_LABEL_TAXONOMY).toContain("possible-defect");
  });
});

describe("visibleLabels display rules", () => {
  it("no labels is a normal state — empty list, unlabelled", () => {
    expect(visibleLabels({})).toEqual([]);
    expect(isUnlabelled({})).toBe(true);
    expect(isUnlabelled({ labels: [] })).toBe(true);
  });

  it("suggested labels show as tentative at/above the display floor", () => {
    const item = { labels: [aiEntry({ confidence: 0.5 })] };
    const shown = visibleLabels(item);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ label: "switchboard", tentative: true, confidence: 0.5 });
  });

  it("suggested labels below the floor are hidden — no confident-looking wrong answers", () => {
    const item = { labels: [aiEntry({ confidence: 0.49 })] };
    expect(visibleLabels(item)).toEqual([]);
    expect(isUnlabelled(item)).toBe(true);
  });

  it("accepted and human-confirmed labels render solid, ahead of suggestions", () => {
    const item = {
      labels: [
        aiEntry({ label: "rough-in", confidence: 0.9 }),
        aiEntry({ label: "outlet", status: "accepted" }),
        aiEntry({ label: "lighting", source: "human", status: "confirmed", confidence: null }),
      ],
    };
    const shown = visibleLabels(item);
    expect(shown.map((l) => l.label)).toEqual(["outlet", "lighting", "rough-in"]);
    expect(shown.map((l) => l.tentative)).toEqual([false, false, true]);
  });

  it("rejected labels never render", () => {
    const item = { labels: [aiEntry({ status: "rejected" })] };
    expect(visibleLabels(item)).toEqual([]);
  });

  it("dedupes by label — a confirmed entry wins over a suggestion of the same label", () => {
    const item = {
      labels: [
        aiEntry({ label: "outlet", source: "human", status: "confirmed", confidence: null }),
        aiEntry({ label: "outlet" }),
      ],
    };
    const shown = visibleLabels(item);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.tentative).toBe(false);
  });

  it("hasVisibleLabel matches the display, not the raw entries", () => {
    const item = { labels: [aiEntry({ confidence: 0.2 })] };
    expect(hasVisibleLabel(item, "switchboard")).toBe(false);
    expect(hasVisibleLabel({ labels: [aiEntry()] }, "switchboard")).toBe(true);
  });

  it("needsClassification: photo rows without a run at this modelVersion", () => {
    expect(needsClassification({ kind: "photo" }, "m1")).toBe(true);
    expect(needsClassification({ kind: "note" }, "m1")).toBe(false);
    expect(
      needsClassification(
        { kind: "photo", aiLabelRuns: [{ modelVersion: "m1", promptVersion: "v", at: "t", labelCount: 0 }] },
        "m1"
      )
    ).toBe(false);
  });
});

describe("server mergeAiLabels", () => {
  it("keeps taxonomy whitelist — unknown labels and bad confidence are dropped", () => {
    const merged = server.mergeAiLabels(
      {},
      [
        { label: "switchboard", confidence: 0.8 },
        { label: "made-up-label", confidence: 0.9 },
        { label: "outlet", confidence: 1.4 },
        { label: "lighting", confidence: "high" },
      ],
      { modelVersion: "m1" }
    );
    expect(merged.added.map((e: EvidenceLabelEntry) => e.label)).toEqual(["switchboard"]);
  });

  it("writes a run marker even for a zero-label run (idempotency includes empties)", () => {
    const merged = server.mergeAiLabels({}, [], { modelVersion: "m1" });
    expect(merged.added).toEqual([]);
    expect(merged.aiLabelRuns).toHaveLength(1);
    expect(merged.aiLabelRuns[0]).toMatchObject({ modelVersion: "m1", labelCount: 0 });
    expect(server.hasAiLabelRun({ aiLabelRuns: merged.aiLabelRuns }, "m1")).toBe(true);
  });

  it("a human-rejected label never resurfaces from a later run", () => {
    const item = { labels: [aiEntry({ status: "rejected", modelVersion: "m1" })] };
    const merged = server.mergeAiLabels(item, [{ label: "switchboard", confidence: 0.95 }], {
      modelVersion: "m2",
    });
    expect(merged.added).toEqual([]);
  });

  it("does not duplicate a label the row already carries", () => {
    const item = { labels: [aiEntry({ label: "outlet", status: "accepted" })] };
    const merged = server.mergeAiLabels(item, [{ label: "outlet", confidence: 0.9 }], {
      modelVersion: "m2",
    });
    expect(merged.added).toEqual([]);
  });
});

describe("server applyLabelCorrection", () => {
  const actor = { id: "u1", username: "boss" };

  it("accept flips a suggestion to accepted with the reviewer stamped", () => {
    const item = { labels: [aiEntry()] };
    const r = server.applyLabelCorrection(item, { accept: ["switchboard"] }, actor);
    expect(r.ok).toBe(true);
    expect(r.labels[0]).toMatchObject({
      status: "accepted",
      reviewedById: "u1",
      reviewedByName: "boss",
    });
  });

  it("remove on an AI label marks it rejected (sticky), not deleted", () => {
    const item = { labels: [aiEntry()] };
    const r = server.applyLabelCorrection(item, { remove: ["switchboard"] }, actor);
    expect(r.ok).toBe(true);
    expect(r.labels).toHaveLength(1);
    expect(r.labels[0].status).toBe("rejected");
    expect(server.rejectedLabelSet({ labels: r.labels }).has("switchboard")).toBe(true);
  });

  it("remove on a human label deletes it outright", () => {
    const item = {
      labels: [aiEntry({ source: "human", status: "confirmed", confidence: null })],
    };
    const r = server.applyLabelCorrection(item, { remove: ["switchboard"] }, actor);
    expect(r.ok).toBe(true);
    expect(r.labels).toEqual([]);
  });

  it("add creates a human-owned confirmed label; duplicates are no-ops", () => {
    const r = server.applyLabelCorrection({}, { add: ["cable-tray"] }, actor);
    expect(r.ok).toBe(true);
    expect(r.labels[0]).toMatchObject({ label: "cable-tray", source: "human", status: "confirmed" });
    const again = server.applyLabelCorrection({ labels: r.labels }, { add: ["cable-tray"] }, actor);
    expect(again.ok).toBe(false); // nothing changed — honest error, no silent write
  });

  it("AI never overwrites a human decision — accepting then re-suggesting keeps the human record", () => {
    const item = { labels: [aiEntry()] };
    const accepted = server.applyLabelCorrection(item, { accept: ["switchboard"] }, actor);
    const merged = server.mergeAiLabels({ labels: accepted.labels }, [{ label: "switchboard", confidence: 0.3 }], {
      modelVersion: "m9",
    });
    expect(merged.added).toEqual([]);
    expect(merged.labels[0].status).toBe("accepted");
  });

  it("rejects labels outside the taxonomy", () => {
    const r = server.applyLabelCorrection({}, { add: ["free-text"] }, actor);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown label/);
  });
});
