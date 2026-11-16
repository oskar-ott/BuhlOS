import { describe, expect, it } from "vitest";
import { itemHeading } from "./format";

const atom = {
  name: "atom LIGHTING 10W Dimmable LED Surface Mount Downlight — White LED 10W",
  brand: "atom LIGHTING",
  manufacturerCode: "AT9064/WH/60/WW",
  colourFinish: "White",
  variant: "LED 10W 60° IP54 3 YEAR 3000K 760LM WARM WHITE",
};

describe("the office drawer's heading says each thing once", () => {
  it("drops a dash tail that only repeats the details, and the brand the name starts with", () => {
    expect(itemHeading(atom)).toEqual({
      title: "atom LIGHTING 10W Dimmable LED Surface Mount Downlight",
      code: "AT9064/WH/60/WW",
      details: "White · LED 10W 60° IP54 3 YEAR 3000K 760LM WARM WHITE",
    });
  });

  it("keeps a dash tail that says something the details don't", () => {
    expect(itemHeading({ ...atom, name: "Downlight — spare for the Smith job" }).title).toBe("Downlight — spare for the Smith job");
  });

  it("keeps the brand when the name doesn't start with it", () => {
    expect(itemHeading({ ...atom, name: "Surface downlight" }).details).toBe("atom LIGHTING · White · LED 10W 60° IP54 3 YEAR 3000K 760LM WARM WHITE");
  });

  it("reads a typed item in its fields, without the code twice", () => {
    const typed = { name: "Clipsal Iconic 2 gang switch", brand: "Clipsal", manufacturerCode: "3042WE", variant: null, colourFinish: "White", category: "switches", specs: { range: "Iconic", kind: "Switch", gang: "2 gang" } };
    expect(itemHeading(typed)).toEqual({ title: "Clipsal Iconic 2 gang switch", code: "3042WE", details: "Iconic · Switch · 2 gang · White" });
  });

  it("copes with nothing but a name", () => {
    expect(itemHeading({ name: "Cable ties", brand: null, manufacturerCode: null, colourFinish: null, variant: null })).toEqual({ title: "Cable ties", code: null, details: "" });
  });
});
