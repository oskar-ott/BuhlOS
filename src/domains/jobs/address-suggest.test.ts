import { describe, expect, it } from "vitest";
import {
  ADDRESS_SUGGEST_LIMIT,
  buildAddressSuggestUrl,
  mergePickedAddress,
  parseAddressSuggestions,
} from "./address-suggest";

function photonResponse(propsList: Record<string, unknown>[]) {
  return { features: propsList.map((properties) => ({ type: "Feature", properties })) };
}

function labels(json: unknown): string[] {
  return parseAddressSuggestions(json).map((s) => s.label);
}

const magillRd = {
  countrycode: "AU",
  housenumber: "12",
  street: "Magill Road",
  district: "Stepney",
  state: "South Australia",
  postcode: "5069",
};

describe("buildAddressSuggestUrl", () => {
  it("hits Photon with the encoded query, a limit and the Adelaide bias", () => {
    const url = buildAddressSuggestUrl("12 magill rd");
    expect(url).toContain("https://photon.komoot.io/api/?");
    expect(url).toContain("q=12+magill+rd");
    expect(url).toContain(`limit=${ADDRESS_SUGGEST_LIMIT}`);
    expect(url).toContain("lat=-34.9285");
    expect(url).toContain("lon=138.6007");
  });
});

describe("parseAddressSuggestions", () => {
  it("formats a full street hit the way the trade writes it", () => {
    expect(parseAddressSuggestions(photonResponse([magillRd]))).toEqual([
      { label: "12 Magill Road, Stepney SA 5069", street: true },
    ]);
  });

  it("abbreviates every state it knows and passes unknown ones through", () => {
    const nsw = { ...magillRd, state: "New South Wales", postcode: "2000" };
    const odd = { ...magillRd, state: "Jervis Bay Territory", postcode: "2540" };
    expect(labels(photonResponse([nsw]))[0]).toContain(" NSW 2000");
    expect(labels(photonResponse([odd]))[0]).toContain(" Jervis Bay Territory 2540");
  });

  it("keeps a street-only hit (no house number)", () => {
    const street = { countrycode: "AU", street: "Magill Road", city: "Adelaide", state: "South Australia" };
    expect(parseAddressSuggestions(photonResponse([street]))).toEqual([
      { label: "Magill Road, Adelaide SA", street: true },
    ]);
  });

  it("marks a suburb hit as non-street and doesn't repeat it as locality", () => {
    const suburb = {
      countrycode: "AU",
      name: "Stepney",
      district: "Stepney",
      state: "South Australia",
      postcode: "5069",
    };
    expect(parseAddressSuggestions(photonResponse([suburb]))).toEqual([
      { label: "Stepney, SA 5069", street: false },
    ]);
  });

  it("drops non-Australian results", () => {
    const nz = { ...magillRd, countrycode: "NZ" };
    expect(labels(photonResponse([nz, magillRd]))).toEqual(["12 Magill Road, Stepney SA 5069"]);
  });

  it("dedupes identical formatted addresses and caps at the limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...magillRd, housenumber: String(i + 1) }));
    const out = labels(photonResponse([magillRd, magillRd, ...many]));
    expect(out.length).toBe(ADDRESS_SUGGEST_LIMIT);
    expect(new Set(out).size).toBe(out.length);
  });

  it("returns [] on any surprise shape instead of throwing", () => {
    expect(parseAddressSuggestions(null)).toEqual([]);
    expect(parseAddressSuggestions("nope")).toEqual([]);
    expect(parseAddressSuggestions({})).toEqual([]);
    expect(parseAddressSuggestions({ features: "nope" })).toEqual([]);
    expect(parseAddressSuggestions({ features: [null, { properties: null }, 7] })).toEqual([]);
    expect(parseAddressSuggestions({ features: [{ properties: { countrycode: "AU" } }] })).toEqual([]);
  });
});

describe("mergePickedAddress", () => {
  const streetPick = { label: "Magill Road, Stepney SA 5069", street: true };

  it("keeps the typed house number when the street pick has none", () => {
    expect(mergePickedAddress("12 magill rd stepney", streetPick)).toBe(
      "12 Magill Road, Stepney SA 5069"
    );
  });

  it("keeps unit and range numbers — 3/12, 12a, 12-14", () => {
    expect(mergePickedAddress("3/12 magill rd", streetPick)).toBe("3/12 Magill Road, Stepney SA 5069");
    expect(mergePickedAddress("12a magill rd", streetPick)).toBe("12a Magill Road, Stepney SA 5069");
    expect(mergePickedAddress("12-14 magill rd", streetPick)).toBe(
      "12-14 Magill Road, Stepney SA 5069"
    );
  });

  it("takes a numbered pick as-is — the geocoder matched the exact house", () => {
    const numbered = { label: "12 Magill Road, Stepney SA 5069", street: true };
    expect(mergePickedAddress("12 magill rd", numbered)).toBe("12 Magill Road, Stepney SA 5069");
  });

  it("never bolts a number onto a suburb pick", () => {
    const suburb = { label: "Stepney, SA 5069", street: false };
    expect(mergePickedAddress("12 magill rd", suburb)).toBe("Stepney, SA 5069");
  });

  it("leaves the pick alone when nothing number-like was typed", () => {
    expect(mergePickedAddress("magill road", streetPick)).toBe("Magill Road, Stepney SA 5069");
  });
});
