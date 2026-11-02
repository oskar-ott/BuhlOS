import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * api/_lib/itp-simple-model.js + api/_lib/itp-simple-email.js — the pure
 * server helpers behind "out of date", the default PDF name and the email.
 */

const requireFromHere = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const model = requireFromHere("../../../api/_lib/itp-simple-model.js");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderItpEmail } = requireFromHere("../../../api/_lib/itp-simple-email.js");

const KITCHEN = {
  id: "a1",
  name: "Kitchen",
  photos: [
    { id: "p1", url: "u1", caption: "" },
    { id: "p2", url: "u2", caption: "Bench" },
  ],
};
const ROOF = { id: "a2", name: "Roof", photos: [{ id: "p3", url: "u3", caption: "" }] };
const REPORT = { areas: [KITCHEN, ROOF] };

describe("itp-simple-model (server)", () => {
  it("fingerprints a PDF's own areas: photos added, removed or re-captioned change it; renames don't", () => {
    const key = model.liveContentKey(REPORT, ["a1"]);
    expect(key).toBe(model.liveContentKey(REPORT, ["a1"]));
    // Other area changed → this PDF unaffected.
    const roofChanged = { areas: [KITCHEN, { ...ROOF, photos: [] }] };
    expect(model.liveContentKey(roofChanged, ["a1"])).toBe(key);
    // Area renamed → unaffected.
    const renamed = { areas: [{ ...KITCHEN, name: "Kitchen 2" }, ROOF] };
    expect(model.liveContentKey(renamed, ["a1"])).toBe(key);
    // Photo removed / added / caption edited → changes.
    const removed = { areas: [{ ...KITCHEN, photos: [KITCHEN.photos[0]!] }, ROOF] };
    expect(model.liveContentKey(removed, ["a1"])).not.toBe(key);
    const captioned = {
      areas: [
        {
          ...KITCHEN,
          photos: [KITCHEN.photos[0]!, { ...KITCHEN.photos[1]!, caption: "Bench top" }],
        },
        ROOF,
      ],
    };
    expect(model.liveContentKey(captioned, ["a1"])).not.toBe(key);
    // Area removed entirely → changes (its photos are gone).
    expect(model.liveContentKey({ areas: [ROOF] }, ["a1"])).not.toBe(key);
  });

  it("default name: All areas when every area is in, else the names", () => {
    expect(model.defaultPdfName(REPORT.areas, 2)).toBe("All areas");
    expect(model.defaultPdfName([KITCHEN], 2)).toBe("Kitchen");
    expect(model.defaultPdfName([], 2)).toBe("All areas");
    const long = Array.from({ length: 30 }, (_, i) => ({ name: `Bedroom ${i + 1} upstairs` }));
    expect(model.defaultPdfName(long, 40).length).toBeLessThanOrEqual(120);
  });

  it("snapshot keeps capture order and drops unknown ids", () => {
    const snap = model.snapshotFor(REPORT, ["a2", "nope", "a1"]);
    expect(snap.areas.map((a: { id: string }) => a.id)).toEqual(["a1", "a2"]);
    expect(model.countPhotos(snap.areas)).toBe(3);
  });

  it("email address check", () => {
    expect(model.isEmailAddress("sam@builder.com.au")).toBe(true);
    expect(model.isEmailAddress(" sam@builder.com.au ")).toBe(true);
    expect(model.isEmailAddress("sam@builder")).toBe(false);
    expect(model.isEmailAddress("")).toBe(false);
  });
});

describe("renderItpEmail", () => {
  it("subject is '{PDF name} — {job address}'; body carries the note, the facts and the attachment line", () => {
    const m = renderItpEmail({
      pdfName: "Rough-in for builder",
      jobAddress: "12 Banksia Rd",
      note: "Ready for inspection <today>",
      areaCount: 2,
      photoCount: 6,
      madeLabel: "2 Nov 2026, 8:41 am",
      attached: true,
      senderName: "Sparky",
    });
    expect(m.subject).toBe("Rough-in for builder — 12 Banksia Rd");
    expect(m.text).toContain("Ready for inspection <today>");
    expect(m.text).toContain("2 areas · 6 photos · made 2 Nov 2026, 8:41 am");
    expect(m.text).toContain("The PDF is attached.");
    expect(m.html).toContain("Ready for inspection &lt;today&gt;");
    expect(m.html).not.toContain("<today>");
  });

  it("over the mail cap it carries a download link and says so", () => {
    const m = renderItpEmail({
      pdfName: "All areas",
      jobAddress: "12 Banksia Rd",
      areaCount: 4,
      photoCount: 120,
      madeLabel: "2 Nov 2026, 8:41 am",
      attached: false,
      downloadUrl: "https://blob.example/itp.pdf",
    });
    expect(m.text).toContain("too big to attach");
    expect(m.text).toContain("https://blob.example/itp.pdf");
    expect(m.html).toContain('href="https://blob.example/itp.pdf"');
    expect(m.text).not.toContain("delivered");
  });
});
