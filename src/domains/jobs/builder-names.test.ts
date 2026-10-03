import { describe, expect, it } from "vitest";
import { builderNameSuggestions, canonicalBuilderName } from "./builder-names";

describe("builderNameSuggestions", () => {
  it("lists distinct builders, most-used first, ties A→Z, blanks skipped", () => {
    expect(
      builderNameSuggestions([
        { builderName: "Kane Constructions" },
        { builderName: "Hutchinson Builders" },
        { builderName: "Hutchinson Builders" },
        { builderName: "" },
        { builderName: null },
        {},
        { builderName: "Built" },
      ])
    ).toEqual(["Hutchinson Builders", "Built", "Kane Constructions"]);
  });

  it("collapses case/spacing variants to the spelling used most", () => {
    expect(
      builderNameSuggestions([
        { builderName: "hutchinson builders" },
        { builderName: "Hutchinson Builders" },
        { builderName: " Hutchinson  Builders " },
      ])
    ).toEqual(["Hutchinson Builders"]);
  });
});

describe("canonicalBuilderName", () => {
  const known = ["Hutchinson Builders", "Built"];
  it("snaps a same-builder spelling onto the existing one", () => {
    expect(canonicalBuilderName("  hutchinson   BUILDERS ", known)).toBe("Hutchinson Builders");
  });
  it("keeps a new builder as typed (tidied), and blank as blank", () => {
    expect(canonicalBuilderName(" Kane  Constructions ", known)).toBe("Kane Constructions");
    expect(canonicalBuilderName("   ", known)).toBe("");
  });
});
