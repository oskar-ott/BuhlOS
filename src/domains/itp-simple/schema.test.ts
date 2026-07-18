import { describe, expect, it } from "vitest";
import {
  ItpListResponseSchema,
  ItpReportResponseSchema,
  pdfMissingNewCaptures,
} from "./schema";

describe("itp-simple client contract (#912)", () => {
  it("parses a list response and defaults the artefact fields", () => {
    const parsed = ItpListResponseSchema.parse({
      job: { id: "100-arthur", name: "100 Arthur St" },
      reports: [
        {
          id: "r1",
          title: "Rough-in — Level 1",
          createdAt: "2026-07-18T01:00:00Z",
          updatedAt: "2026-07-18T01:00:00Z",
        },
      ],
    });
    expect(parsed.reports[0]!.pdfUrl).toBeNull();
    expect(parsed.reports[0]!.areaCount).toBe(0);
    expect(parsed.reports[0]!.photoCount).toBe(0);
  });

  it("parses a report detail with nested areas + photos", () => {
    const parsed = ItpReportResponseSchema.parse({
      report: {
        id: "r1",
        title: "Fit-off",
        createdAt: "2026-07-18T01:00:00Z",
        updatedAt: "2026-07-18T02:00:00Z",
        areas: [
          {
            id: "a1",
            name: "Kitchen",
            createdAt: "2026-07-18T01:10:00Z",
            photos: [
              { id: "p1", url: "https://blob/x.jpg", createdAt: "2026-07-18T01:20:00Z" },
            ],
          },
        ],
      },
    });
    expect(parsed.report.areas[0]!.photos[0]!.caption).toBe("");
  });

  it("rejects a payload without the report envelope", () => {
    expect(ItpReportResponseSchema.safeParse({ id: "r1" }).success).toBe(false);
  });

  describe("pdfMissingNewCaptures — adds-only, never claims deletions", () => {
    const base = {
      pdfGeneratedAt: "2026-07-18T02:00:00Z",
      areas: [
        {
          createdAt: "2026-07-18T01:00:00Z",
          photos: [{ createdAt: "2026-07-18T01:30:00Z" }],
        },
      ],
    };

    it("false when nothing was captured after the PDF", () => {
      expect(pdfMissingNewCaptures(base)).toBe(false);
    });

    it("false when no PDF exists yet", () => {
      expect(pdfMissingNewCaptures({ ...base, pdfGeneratedAt: null })).toBe(false);
    });

    it("true when a photo was added after the PDF", () => {
      expect(
        pdfMissingNewCaptures({
          ...base,
          areas: [
            {
              ...base.areas[0]!,
              photos: [...base.areas[0]!.photos, { createdAt: "2026-07-18T03:00:00Z" }],
            },
          ],
        }),
      ).toBe(true);
    });

    it("true when a whole area was added after the PDF", () => {
      expect(
        pdfMissingNewCaptures({
          ...base,
          areas: [...base.areas, { createdAt: "2026-07-18T04:00:00Z", photos: [] }],
        }),
      ).toBe(true);
    });
  });
});
