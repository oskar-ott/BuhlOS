import { describe, expect, it } from "vitest";
import {
  QUOTE_LIMITS,
  QuoteConflictResponseSchema,
  QuoteCreateInputSchema,
  QuoteDetailResponseSchema,
  QuoteListResponseSchema,
  QuoteSaveInputSchema,
} from "./schema";

/** A wire-shaped quote document as api/quotes-v2.js returns it. */
function wireQuote(over: Record<string, unknown> = {}) {
  return {
    id: "qv2_abc12345",
    name: "Birdwood St rewire",
    clientName: "B. Hender",
    status: "draft",
    createdAt: "2026-06-12T00:00:00.000Z",
    createdBy: "estimator",
    updatedAt: "2026-06-12T01:00:00.000Z",
    sections: [
      {
        id: "qsec_a",
        title: "Switchboard",
        sortOrder: 0,
        lines: [
          {
            id: "qline_a",
            kind: "material",
            description: "DB upgrade",
            qty: 1,
            unit: "ea",
            rate: 1000,
          },
        ],
      },
    ],
    totals: { subtotalExGst: 1000, gst: 100, totalIncGst: 1100, lineCount: 1 },
    ...over,
  };
}

describe("quote wire schemas (honest parsers at the boundary)", () => {
  it("parses a full detail response", () => {
    const parsed = QuoteDetailResponseSchema.safeParse({ quote: wireQuote() });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.quote.sections[0]!.lines[0]!.rate).toBe(1000);
    }
  });

  it("parses a list response and rejects garbage rows", () => {
    const ok = QuoteListResponseSchema.safeParse({
      quotes: [
        {
          id: "qv2_a",
          name: "A",
          status: "draft",
          updatedAt: "2026-06-12T00:00:00.000Z",
          totalIncGst: 1100,
          lineCount: 1,
        },
      ],
    });
    expect(ok.success).toBe(true);

    expect(QuoteListResponseSchema.safeParse({ quotes: [{ id: 1 }] }).success).toBe(false);
    expect(QuoteListResponseSchema.safeParse({ quotes: "nope" }).success).toBe(false);
    expect(QuoteListResponseSchema.safeParse(null).success).toBe(false);
  });

  it("rejects unknown statuses and malformed sections — never invents data", () => {
    expect(
      QuoteDetailResponseSchema.safeParse({ quote: wireQuote({ status: "estimating" }) }).success,
    ).toBe(false);
    expect(
      QuoteDetailResponseSchema.safeParse({
        quote: wireQuote({ sections: [{ id: "s", title: "x" }] }),
      }).success,
    ).toBe(false);
  });

  it("passes through fields the calculator children will add (#193/#195/#214)", () => {
    const parsed = QuoteDetailResponseSchema.safeParse({
      quote: wireQuote({ futurePricing: { contingencyPct: 5 } }),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data.quote as Record<string, unknown>).futurePricing).toEqual({
        contingencyPct: 5,
      });
    }
  });

  it("parses the 409 conflict body (server doc rides along for reload)", () => {
    const parsed = QuoteConflictResponseSchema.safeParse({
      error: "quote changed since you loaded it",
      quote: wireQuote(),
    });
    expect(parsed.success).toBe(true);
  });
});

describe("create input", () => {
  it("trims and requires a name", () => {
    const ok = QuoteCreateInputSchema.safeParse({ name: "  Shed fitout  " });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.name).toBe("Shed fitout");
    expect(QuoteCreateInputSchema.safeParse({ name: "   " }).success).toBe(false);
    expect(QuoteCreateInputSchema.safeParse({}).success).toBe(false);
  });

  it("caps name length", () => {
    expect(
      QuoteCreateInputSchema.safeParse({ name: "x".repeat(QUOTE_LIMITS.maxName + 1) }).success,
    ).toBe(false);
  });
});

describe("save input (anti-bloat limits + updatedAt precondition)", () => {
  function saveInput(over: Record<string, unknown> = {}) {
    return {
      name: "Birdwood St rewire",
      sections: [
        {
          id: "qsec_a",
          title: "Switchboard",
          lines: [
            { id: "qline_a", kind: "material", description: "DB", qty: 1, unit: "ea", rate: 10 },
          ],
        },
      ],
      updatedAt: "2026-06-12T01:00:00.000Z",
      ...over,
    };
  }

  it("accepts a well-formed save and new lines without ids", () => {
    const input = saveInput({
      sections: [
        { title: "New section", lines: [{ kind: "labour", description: "", qty: 2, unit: "hrs", rate: 110 }] },
      ],
    });
    expect(QuoteSaveInputSchema.safeParse(input).success).toBe(true);
  });

  it("REQUIRES the loaded updatedAt (the stale-save precondition)", () => {
    expect(QuoteSaveInputSchema.safeParse(saveInput({ updatedAt: undefined })).success).toBe(false);
    expect(QuoteSaveInputSchema.safeParse(saveInput({ updatedAt: "" })).success).toBe(false);
  });

  it("rejects over-limit section and line counts", () => {
    const tooManySections = saveInput({
      sections: Array.from({ length: QUOTE_LIMITS.maxSections + 1 }, (_, i) => ({
        title: `S${i}`,
        lines: [],
      })),
    });
    expect(QuoteSaveInputSchema.safeParse(tooManySections).success).toBe(false);

    const tooManyLines = saveInput({
      sections: [
        {
          title: "S",
          lines: Array.from({ length: QUOTE_LIMITS.maxLinesPerSection + 1 }, () => ({
            kind: "other",
            description: "",
            qty: 1,
            unit: "",
            rate: 0,
          })),
        },
      ],
    });
    expect(QuoteSaveInputSchema.safeParse(tooManyLines).success).toBe(false);
  });

  it("rejects non-finite and out-of-range qty/rate", () => {
    const bad = (line: Record<string, unknown>) =>
      QuoteSaveInputSchema.safeParse(
        saveInput({ sections: [{ title: "S", lines: [{ kind: "other", description: "", qty: 1, unit: "", rate: 0, ...line }] }] }),
      ).success;
    expect(bad({ qty: Number.NaN })).toBe(false);
    expect(bad({ qty: Number.POSITIVE_INFINITY })).toBe(false);
    expect(bad({ qty: -1 })).toBe(false);
    expect(bad({ qty: QUOTE_LIMITS.maxQty + 1 })).toBe(false);
    expect(bad({ rate: QUOTE_LIMITS.maxRate + 1 })).toBe(false);
    expect(bad({ rate: -QUOTE_LIMITS.maxRate - 1 })).toBe(false);
    // Negative rate within range is a discount line — allowed.
    expect(
      QuoteSaveInputSchema.safeParse(
        saveInput({ sections: [{ title: "S", lines: [{ kind: "other", description: "disc", qty: 1, unit: "", rate: -50 }] }] }),
      ).success,
    ).toBe(true);
  });

  it("rejects empty section titles and over-cap strings", () => {
    expect(QuoteSaveInputSchema.safeParse(saveInput({ sections: [{ title: "  ", lines: [] }] })).success).toBe(false);
    expect(
      QuoteSaveInputSchema.safeParse(
        saveInput({ sections: [{ title: "x".repeat(QUOTE_LIMITS.maxSectionTitle + 1), lines: [] }] }),
      ).success,
    ).toBe(false);
  });
});
