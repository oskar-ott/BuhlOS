import { describe, expect, it } from "vitest";
import { clientNameSuggestions, canonicalClientName } from "./client-names";

describe("clientNameSuggestions", () => {
  it("lists distinct clients, most-used first, ties A→Z, blanks skipped", () => {
    expect(
      clientNameSuggestions([
        { clientName: "Kane Constructions" },
        { clientName: "Hutchinson Builders" },
        { clientName: "Hutchinson Builders" },
        { clientName: "" },
        { clientName: null },
        {},
        { clientName: "Built" },
      ])
    ).toEqual(["Hutchinson Builders", "Built", "Kane Constructions"]);
  });

  it("collapses case/spacing variants to the spelling used most", () => {
    expect(
      clientNameSuggestions([
        { clientName: "hutchinson builders" },
        { clientName: "Hutchinson Builders" },
        { clientName: " Hutchinson  Builders " },
      ])
    ).toEqual(["Hutchinson Builders"]);
  });
});

describe("canonicalClientName", () => {
  const known = ["Hutchinson Builders", "Built"];
  it("snaps a same-client spelling onto the existing one", () => {
    expect(canonicalClientName("  hutchinson   BUILDERS ", known)).toBe("Hutchinson Builders");
  });
  it("keeps a new client as typed (tidied), and blank as blank", () => {
    expect(canonicalClientName(" Kane  Constructions ", known)).toBe("Kane Constructions");
    expect(canonicalClientName("   ", known)).toBe("");
  });
});
