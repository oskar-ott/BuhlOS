import { describe, expect, it } from "vitest";
import {
  parseTakeoffInput,
  readAiDraft,
  validateProposedLine,
  QUOTE_DRAFT_PROMPT_VERSION,
  SCOPE_TEXT_MAX_CHARS,
} from "./ai-draft";
import { QUOTE_LIMITS } from "./schema";

/**
 * #246 — the pure side of AI quote drafts: the STUBBED Epic-5 takeoff
 * contract and the model-proposal validator the API hand-mirrors
 * (quotes-v2-ai-draft-api.test.ts pins the server side).
 */

describe("parseTakeoffInput — the typed, stubbed Epic-5 contract", () => {
  it("parses a valid takeoff payload", () => {
    const result = parseTakeoffInput({
      source: "takeoff",
      items: [
        { description: "Twin GPO", qty: 24, unit: "ea", drawingRef: "E-101 rev C" },
        { description: "Cat6 run", qty: 320, unit: "m" },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.takeoff.items).toHaveLength(2);
      expect(result.takeoff.items[0]).toMatchObject({ description: "Twin GPO", qty: 24 });
    }
  });

  it("rejects a wrong source tag", () => {
    expect(
      parseTakeoffInput({ source: "manual", items: [{ description: "GPO", qty: 1, unit: "ea" }] }).ok
    ).toBe(false);
  });

  it("rejects an empty items array — a takeoff with nothing measured is not a takeoff", () => {
    expect(parseTakeoffInput({ source: "takeoff", items: [] }).ok).toBe(false);
  });

  it("rejects bad item shapes: missing description, negative qty, non-numeric qty", () => {
    const bad = [
      { qty: 1, unit: "ea" },
      { description: "GPO", qty: -1, unit: "ea" },
      { description: "GPO", qty: "3", unit: "ea" },
    ];
    for (const item of bad) {
      expect(parseTakeoffInput({ source: "takeoff", items: [item] }).ok).toBe(false);
    }
  });

  it("rejects non-object input", () => {
    expect(parseTakeoffInput(null).ok).toBe(false);
    expect(parseTakeoffInput("takeoff").ok).toBe(false);
  });
});

describe("validateProposedLine — the model-proposal gate", () => {
  const base = { kind: "material", description: "Twin GPO", qty: null, unit: null, uncertainty: null };

  it("accepts a minimal valid line (qty null = no quantity stated)", () => {
    const result = validateProposedLine(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.line).toEqual({ kind: "material", description: "Twin GPO", qty: null, unit: null });
      expect(result.uncertainty).toBeNull();
    }
  });

  it("accepts an explicit quantity + unit + uncertainty note", () => {
    const result = validateProposedLine({
      ...base,
      kind: "labour",
      qty: 8,
      unit: " hrs ",
      uncertainty: "assumes single-storey access",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.line.qty).toBe(8);
      expect(result.line.unit).toBe("hrs");
      expect(result.uncertainty).toBe("assumes single-storey access");
    }
  });

  it("whitelists kind — anything outside material|labour|other is rejected", () => {
    expect(validateProposedLine({ ...base, kind: "plumbing" }).ok).toBe(false);
    expect(validateProposedLine({ ...base, kind: "" }).ok).toBe(false);
  });

  it("rejects an empty or missing description", () => {
    expect(validateProposedLine({ ...base, description: "  " }).ok).toBe(false);
    expect(validateProposedLine({ ...base, description: undefined }).ok).toBe(false);
  });

  it("rejects an over-long description rather than silently truncating", () => {
    const result = validateProposedLine({
      ...base,
      description: "x".repeat(QUOTE_LIMITS.maxLineDescription + 1),
    });
    expect(result.ok).toBe(false);
  });

  it("qty must be null unless a number was explicitly given — strings/negatives/NaN rejected", () => {
    for (const qty of ["3", -1, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(validateProposedLine({ ...base, qty }).ok).toBe(false);
    }
    const undef = validateProposedLine({ kind: "other", description: "Allowance" });
    expect(undef.ok).toBe(true);
    if (undef.ok) expect(undef.line.qty).toBeNull();
  });

  it("normalises empty unit to null; rejects a non-string unit", () => {
    const empty = validateProposedLine({ ...base, unit: "" });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.line.unit).toBeNull();
    expect(validateProposedLine({ ...base, unit: 5 }).ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(validateProposedLine(null).ok).toBe(false);
    expect(validateProposedLine("line").ok).toBe(false);
  });
});

describe("readAiDraft — the additive doc field", () => {
  it("returns the honest empty state when the field is absent or malformed — never an invented draft", () => {
    expect(readAiDraft({ id: "qv2_x", sections: [] })).toEqual({ runs: [], suggestions: [] });
    expect(readAiDraft({ aiDraft: { runs: "nope" } })).toEqual({ runs: [], suggestions: [] });
    expect(readAiDraft(null)).toEqual({ runs: [], suggestions: [] });
  });

  it("parses a stored aiDraft state", () => {
    const state = {
      runs: [
        {
          id: "aidr_1",
          createdAt: "2026-07-02T00:00:00.000Z",
          createdById: "u_est",
          model: "claude-sonnet-4-6",
          promptVersion: QUOTE_DRAFT_PROMPT_VERSION,
          sourceTextExcerpt: "Supply and install…",
          truncated: false,
          usedChars: 500,
          usage: { inputTokens: 400, outputTokens: 120 },
          takeoffProvided: false,
        },
      ],
      suggestions: [
        {
          id: "ais_1",
          type: "quote_draft_line",
          status: "suggested",
          model: "claude-sonnet-4-6",
          promptVersion: QUOTE_DRAFT_PROMPT_VERSION,
          confidence: null,
          createdAt: "2026-07-02T00:00:00.000Z",
          createdBy: "system:ai",
          reviewedById: null,
          reviewedByName: null,
          reviewedAt: null,
          reviewNote: null,
          humanCorrection: null,
          runId: "aidr_1",
          sectionTitle: "Lighting",
          line: { kind: "material", description: "LED downlight", qty: 24, unit: "ea" },
          uncertainty: null,
        },
      ],
    };
    const parsed = readAiDraft({ id: "qv2_x", aiDraft: state });
    expect(parsed.runs).toHaveLength(1);
    expect(parsed.suggestions[0]?.line.qty).toBe(24);
  });

  it("pins the disclosed truncation boundary", () => {
    expect(SCOPE_TEXT_MAX_CHARS).toBe(12_000);
  });
});
