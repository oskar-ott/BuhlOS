import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * The pure PDF composer (#912) — offline, real pdf-lib. Pins: a valid PDF
 * comes back for the happy path, embedded photos actually grow the document,
 * unembeddable/missing bytes degrade to the honest placeholder box instead of
 * throwing, and image kind sniffing is by magic bytes.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { composeItpPdf, sniffImageKind } = requireFromHere("../../../api/_lib/itp-simple-pdf.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PDFDocument } = requireFromHere("pdf-lib");

// Minimal valid 1×1 fixtures.
const JPG_1PX = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
    "base64",
  ),
);
const PNG_1PX = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const HEADER = {
  title: "Rough-in — Level 1",
  jobName: "100 Arthur St",
  jobLegacyId: "100-arthur",
  authorName: "Sparky",
  generatedAtLabel: "18 Jul 2026",
};

async function pageCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPageCount();
}

describe("composeItpPdf (#912)", () => {
  it("renders a valid PDF with areas and embedded jpg + png photos", async () => {
    const bytes = await composeItpPdf({
      ...HEADER,
      areas: [
        { name: "Kitchen", photos: [{ bytes: JPG_1PX, caption: "GPO heights checked" }] },
        { name: "Switchboard", photos: [{ bytes: PNG_1PX }] },
      ],
    });
    expect(bytes.length).toBeGreaterThan(1000);
    expect(await pageCount(bytes)).toBeGreaterThanOrEqual(1);
  });

  it("embedded photos grow the document vs the same report without them", async () => {
    const withPhoto = await composeItpPdf({
      ...HEADER,
      areas: [{ name: "Kitchen", photos: [{ bytes: JPG_1PX }] }],
    });
    const withoutPhoto = await composeItpPdf({
      ...HEADER,
      areas: [{ name: "Kitchen", photos: [] }],
    });
    expect(withPhoto.length).toBeGreaterThan(withoutPhoto.length);
  });

  it("missing or garbage bytes render the placeholder instead of throwing", async () => {
    const bytes = await composeItpPdf({
      ...HEADER,
      areas: [
        {
          name: "Roof",
          photos: [
            { bytes: null, caption: "fetch failed upstream" },
            { bytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]) },
          ],
        },
      ],
    });
    expect(await pageCount(bytes)).toBeGreaterThanOrEqual(1);
  });

  it("handles an empty report and many photos across page breaks", async () => {
    const empty = await composeItpPdf({ ...HEADER, areas: [] });
    expect(await pageCount(empty)).toBe(1);

    const many = await composeItpPdf({
      ...HEADER,
      areas: [{ name: "Long walk", photos: Array.from({ length: 14 }, () => ({ bytes: JPG_1PX })) }],
    });
    expect(await pageCount(many)).toBeGreaterThanOrEqual(1);
  });

  it("sniffs image kinds by magic bytes only", () => {
    expect(sniffImageKind(JPG_1PX)).toBe("jpg");
    expect(sniffImageKind(PNG_1PX)).toBe("png");
    expect(sniffImageKind(Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8]))).toBeNull();
    expect(sniffImageKind(null)).toBeNull();
  });
});
