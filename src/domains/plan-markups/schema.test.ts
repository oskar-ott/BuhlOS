import { describe, it, expect } from "vitest";
import {
  CreateMarkupPayloadSchema,
  DrawingMarkupSchema,
  UpdateMarkupPayloadSchema,
} from "./schema";

const basePin = {
  id: "mk_1",
  jobId: "job-1",
  planId: "plan-1",
  pageIndex: 0,
  type: "pin" as const,
  x: 0.5,
  y: 0.5,
  visibleToPhil: false,
  archived: false,
};

describe("DrawingMarkupSchema — type + coordinate validation", () => {
  it("accepts a valid pin/note with an x,y anchor in 0..1", () => {
    expect(DrawingMarkupSchema.safeParse(basePin).success).toBe(true);
    expect(DrawingMarkupSchema.safeParse({ ...basePin, type: "note", text: "check this" }).success).toBe(true);
  });

  it("accepts a line with exactly two points and an area with 3+", () => {
    const line = { ...basePin, type: "line", x: undefined, y: undefined, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    const area = { ...basePin, type: "area", x: undefined, y: undefined, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }] };
    expect(DrawingMarkupSchema.safeParse(line).success).toBe(true);
    expect(DrawingMarkupSchema.safeParse(area).success).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(DrawingMarkupSchema.safeParse({ ...basePin, type: "polygon" }).success).toBe(false);
  });

  it("rejects coordinates outside 0..1", () => {
    expect(DrawingMarkupSchema.safeParse({ ...basePin, x: 1.2 }).success).toBe(false);
    expect(DrawingMarkupSchema.safeParse({ ...basePin, y: -0.01 }).success).toBe(false);
  });

  it("rejects a pin with no anchor", () => {
    const noAnchor = {
      id: "mk_1", jobId: "job-1", planId: "plan-1", pageIndex: 0,
      type: "pin" as const, visibleToPhil: false, archived: false,
    };
    expect(DrawingMarkupSchema.safeParse(noAnchor).success).toBe(false);
  });

  it("rejects a line that does not have exactly two points", () => {
    const oneeled = { ...basePin, type: "line", x: undefined, y: undefined, points: [{ x: 0, y: 0 }] };
    const three = { ...basePin, type: "line", x: undefined, y: undefined, points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }] };
    expect(DrawingMarkupSchema.safeParse(oneeled).success).toBe(false);
    expect(DrawingMarkupSchema.safeParse(three).success).toBe(false);
  });

  it("rejects an area with fewer than three points", () => {
    const two = { ...basePin, type: "area", x: undefined, y: undefined, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    expect(DrawingMarkupSchema.safeParse(two).success).toBe(false);
  });

  it("rejects over-long text/label", () => {
    expect(DrawingMarkupSchema.safeParse({ ...basePin, text: "a".repeat(2001) }).success).toBe(false);
    expect(DrawingMarkupSchema.safeParse({ ...basePin, label: "a".repeat(121) }).success).toBe(false);
  });
});

describe("CreateMarkupPayloadSchema", () => {
  it("accepts a minimal pin create (visibleToPhil optional, defaults handled server-side)", () => {
    const r = CreateMarkupPayloadSchema.safeParse({
      jobId: "job-1",
      planId: "plan-1",
      pageIndex: 2,
      type: "pin",
      x: 0.1,
      y: 0.9,
    });
    expect(r.success).toBe(true);
  });

  it("rejects a create missing job/plan linkage", () => {
    expect(CreateMarkupPayloadSchema.safeParse({ planId: "p", pageIndex: 0, type: "pin", x: 0.5, y: 0.5 }).success).toBe(false);
    expect(CreateMarkupPayloadSchema.safeParse({ jobId: "j", pageIndex: 0, type: "pin", x: 0.5, y: 0.5 }).success).toBe(false);
  });

  it("rejects a negative / non-integer pageIndex", () => {
    expect(CreateMarkupPayloadSchema.safeParse({ jobId: "j", planId: "p", pageIndex: -1, type: "pin", x: 0.5, y: 0.5 }).success).toBe(false);
    expect(CreateMarkupPayloadSchema.safeParse({ jobId: "j", planId: "p", pageIndex: 1.5, type: "pin", x: 0.5, y: 0.5 }).success).toBe(false);
  });
});

describe("UpdateMarkupPayloadSchema — strict partial", () => {
  it("accepts known editable fields", () => {
    expect(UpdateMarkupPayloadSchema.safeParse({ visibleToPhil: true }).success).toBe(true);
    expect(UpdateMarkupPayloadSchema.safeParse({ text: "new", label: null }).success).toBe(true);
    expect(UpdateMarkupPayloadSchema.safeParse({ x: 0.2, y: 0.3 }).success).toBe(true);
    expect(UpdateMarkupPayloadSchema.safeParse({ archived: true }).success).toBe(true);
  });

  it("rejects unknown keys (no broad body spreading)", () => {
    expect(UpdateMarkupPayloadSchema.safeParse({ id: "mk_1" }).success).toBe(false);
    expect(UpdateMarkupPayloadSchema.safeParse({ jobId: "other" }).success).toBe(false);
    expect(UpdateMarkupPayloadSchema.safeParse({ type: "line" }).success).toBe(false);
  });

  it("rejects out-of-range coordinates on edit", () => {
    expect(UpdateMarkupPayloadSchema.safeParse({ x: 2 }).success).toBe(false);
  });

  it("#233 — the .strict() schema accepts asBuilt so updateMarkup() doesn't reject it", () => {
    expect(UpdateMarkupPayloadSchema.safeParse({ asBuilt: true }).success).toBe(true);
    expect(UpdateMarkupPayloadSchema.safeParse({ asBuilt: false }).success).toBe(true);
    // non-boolean is rejected
    expect(UpdateMarkupPayloadSchema.safeParse({ asBuilt: "yes" }).success).toBe(false);
  });
});

describe("#233 DrawingMarkupSchema — asBuilt", () => {
  it("accepts a stored markup carrying asBuilt true/false", () => {
    expect(DrawingMarkupSchema.safeParse({ ...basePin, asBuilt: true }).success).toBe(true);
    expect(DrawingMarkupSchema.safeParse({ ...basePin, asBuilt: false }).success).toBe(true);
  });

  it("accepts a legacy markup with no asBuilt at all (migration-free)", () => {
    expect(DrawingMarkupSchema.safeParse(basePin).success).toBe(true);
  });

  it("rejects a non-boolean asBuilt", () => {
    expect(DrawingMarkupSchema.safeParse({ ...basePin, asBuilt: 1 }).success).toBe(false);
  });

  it("create payload need not carry asBuilt (set via PATCH in the viewer)", () => {
    const r = CreateMarkupPayloadSchema.safeParse({
      jobId: "job-1",
      planId: "plan-1",
      pageIndex: 0,
      type: "pin",
      x: 0.5,
      y: 0.5,
    });
    expect(r.success).toBe(true);
  });
});
