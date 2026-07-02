import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * Shared AI-suggestion review conventions (standalone AI batch — #246/#262/
 * #267/#347/#373). The envelope + state machine every AI output in the batch
 * rides on: suggestions carry provenance and confidence, and only an explicit
 * human review moves them out of `suggested`.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ai = requireFromHere("../../../api/_lib/ai-suggestions.js");

describe("suggestionEnvelope", () => {
  it("stamps id, status=suggested, provenance and review-empty fields", () => {
    const env = ai.suggestionEnvelope({
      type: "photo_label",
      model: "claude-sonnet-4-6",
      promptVersion: "photo-labels-v1",
      confidence: 0.82,
      sources: [{ store: "jobs/j1/data.json", id: "ev_1" }],
      jobId: "j1",
      sourceEntityType: "evidence",
      sourceEntityId: "ev_1",
    });
    expect(env.id).toMatch(/^ais_/);
    expect(env.status).toBe("suggested");
    expect(env.model).toBe("claude-sonnet-4-6");
    expect(env.promptVersion).toBe("photo-labels-v1");
    expect(env.confidence).toBe(0.82);
    expect(env.sources).toEqual([{ store: "jobs/j1/data.json", id: "ev_1" }]);
    expect(env.createdBy).toBe("system:ai");
    expect(env.reviewedById).toBeNull();
    expect(env.reviewedAt).toBeNull();
    expect(env.humanCorrection).toBeNull();
  });

  it("requires type, model and promptVersion — provenance is not optional", () => {
    expect(() => ai.suggestionEnvelope({ model: "m", promptVersion: "v" })).toThrow(/type/);
    expect(() => ai.suggestionEnvelope({ type: "t", promptVersion: "v" })).toThrow(/model/);
    expect(() => ai.suggestionEnvelope({ type: "t", model: "m" })).toThrow(/promptVersion/);
  });

  it("clamps confidence into 0..1 and nulls non-numeric confidence", () => {
    expect(ai.clampConfidence(1.4)).toBe(1);
    expect(ai.clampConfidence(-3)).toBe(0);
    expect(ai.clampConfidence("0.5")).toBe(0.5);
    expect(ai.clampConfidence("high")).toBeNull();
    expect(ai.clampConfidence(undefined)).toBeNull();
  });
});

describe("reviewSuggestion state machine", () => {
  const fresh = () =>
    ai.suggestionEnvelope({ type: "t", model: "m", promptVersion: "v1" });

  it("accepts, rejects and supersedes a suggested record", () => {
    for (const status of ["accepted", "rejected"]) {
      const r = ai.reviewSuggestion(fresh(), {
        status,
        reviewedById: "u1",
        reviewedByName: "Oskar",
      });
      expect(r.ok).toBe(true);
      expect(r.record.status).toBe(status);
      expect(r.record.reviewedById).toBe("u1");
      expect(r.record.reviewedAt).toBeTruthy();
    }
    // superseded is a system transition — no reviewer required
    const s = ai.reviewSuggestion(fresh(), { status: "superseded" });
    expect(s.ok).toBe(true);
    expect(s.record.status).toBe("superseded");
  });

  it("edited requires the humanCorrection payload", () => {
    const missing = ai.reviewSuggestion(fresh(), {
      status: "edited",
      reviewedById: "u1",
    });
    expect(missing.ok).toBe(false);
    const ok = ai.reviewSuggestion(fresh(), {
      status: "edited",
      reviewedById: "u1",
      humanCorrection: { description: "fixed" },
    });
    expect(ok.ok).toBe(true);
    expect(ok.record.humanCorrection).toEqual({ description: "fixed" });
  });

  it("terminal states never transition again — reviewed history is immutable", () => {
    const accepted = ai.reviewSuggestion(fresh(), {
      status: "accepted",
      reviewedById: "u1",
    }).record;
    for (const status of ["accepted", "edited", "rejected", "superseded"]) {
      const again = ai.reviewSuggestion(accepted, {
        status,
        reviewedById: "u2",
        humanCorrection: {},
      });
      expect(again.ok).toBe(false);
    }
  });

  it("requires a reviewer for human review actions", () => {
    const r = ai.reviewSuggestion(fresh(), { status: "accepted" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/reviewing user/);
  });

  it("does not mutate the input record", () => {
    const record = fresh();
    ai.reviewSuggestion(record, { status: "accepted", reviewedById: "u1" });
    expect(record.status).toBe("suggested");
    expect(record.reviewedById).toBeNull();
  });
});

describe("parseModelJson", () => {
  it("parses plain and fenced JSON", () => {
    expect(ai.parseModelJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(ai.parseModelJson('```json\n{"a":1}\n```')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("fails honestly on prose, partial JSON and empty replies", () => {
    expect(ai.parseModelJson("Sure! Here are the labels…").ok).toBe(false);
    expect(ai.parseModelJson('{"a":').ok).toBe(false);
    expect(ai.parseModelJson("").ok).toBe(false);
    expect(ai.parseModelJson(undefined as unknown as string).ok).toBe(false);
  });
});

describe("numeral grounding (#347 validation)", () => {
  it("passes prose whose numbers all appear in the payload", () => {
    const payload = { hours: { thisWeek: 18, average: 6 }, jobName: "Birdwood" };
    const prose = "Birdwood consumed 18h this week against a 6h average.";
    expect(ai.ungroundedNumerals(prose, payload)).toEqual([]);
  });

  it("names numbers the payload cannot ground", () => {
    const payload = { hours: { thisWeek: 18 } };
    const prose = "Job consumed 18h this week, roughly 3 times its usual 6h.";
    expect(ai.ungroundedNumerals(prose, payload)).toEqual(["3", "6"]);
  });

  it("normalises number formats — 18.0 in prose grounds against 18", () => {
    expect(ai.ungroundedNumerals("18.0 hours", { h: 18 })).toEqual([]);
  });

  it("empty prose has nothing ungrounded", () => {
    expect(ai.ungroundedNumerals("", { a: 1 })).toEqual([]);
  });
});
