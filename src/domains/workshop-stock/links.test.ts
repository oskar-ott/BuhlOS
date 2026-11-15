import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { itemLinks, linkSite } from "./format";

/**
 * Product links on a workshop item: the wholesaler's page and the maker's spec
 * page. Only http(s) links are kept or shown; the online check contributes only
 * pages whose code matched, or the listing the person accepted.
 */
const requireFromHere = createRequire(import.meta.url);
const { cleanLink, linksFromLookup } = requireFromHere("../../../api/_lib/workshop-stock/links.js");

describe("cleanLink", () => {
  it("keeps web pages, adds https to a pasted bare address", () => {
    expect(cleanLink("https://www.rexel.com.au/p/2025WE?x=1")).toBe("https://www.rexel.com.au/p/2025WE?x=1");
    expect(cleanLink("  www.clipsal.com/p/2025WE ")).toBe("https://www.clipsal.com/p/2025WE");
    expect(cleanLink("http://middys.com.au/a")).toBe("http://middys.com.au/a");
  });
  it("refuses anything else", () => {
    for (const bad of [null, "", "javascript:alert(1)", "data:text/html,x", "ftp://a.com/x", "https://u:p@a.com/", "http://localhost/x", "http://10.0.0.1/", "https://[::1]/", "https://intranet/x", "words with spaces", `https://a.com/${"x".repeat(700)}`]) {
      expect(cleanLink(bad), String(bad)).toBeNull();
    }
  });
});

describe("linksFromLookup", () => {
  const base = { status: "manufacturer_code_matched", candidate: { sourceUrl: "https://www.clipsal.com/p", sourceKind: "manufacturer", evidence: "page" } };

  it("takes the matched wholesaler page and the maker's page", () => {
    const r = linksFromLookup({ ...base, sources: [
      { url: "https://www.jrt.com.au/p", kind: "supplier", opened: false, verdict: "possible_match" },
      { url: "https://www.clipsal.com/p", kind: "manufacturer", opened: true, verdict: "manufacturer_code_matched" },
      { url: "https://www.rexel.com.au/p", kind: "supplier", opened: true, verdict: "manufacturer_code_matched" },
    ] });
    expect(r).toEqual({ productUrl: "https://www.rexel.com.au/p", specUrl: "https://www.clipsal.com/p" });
  });

  it("a possible match from another site is not used; the accepted listing is", () => {
    const r = linksFromLookup({ status: "possible_match", candidate: { sourceUrl: "https://www.middys.com.au/p", sourceKind: "supplier" }, sources: [
      { url: "https://www.middys.com.au/p", kind: "supplier", opened: true, verdict: "possible_match" },
      { url: "https://www.hpm.com.au/p", kind: "manufacturer", opened: false, verdict: "possible_match" },
    ] });
    expect(r).toEqual({ productUrl: "https://www.middys.com.au/p", specUrl: null });
  });

  it("nothing from a check that found nothing", () => {
    expect(linksFromLookup({ status: "no_match", candidate: null, sources: [{ url: "https://www.rexel.com.au/p", kind: "supplier", verdict: "manufacturer_code_matched" }] })).toEqual({ productUrl: null, specUrl: null });
    expect(linksFromLookup(null)).toEqual({ productUrl: null, specUrl: null });
  });
});

describe("itemLinks / linkSite", () => {
  it("wholesaler first, then the maker's specs; only web links", () => {
    expect(itemLinks({ productUrl: "https://www.rexel.com.au/p", specUrl: "https://www.clipsal.com/p" }).map((l) => [l.kind, l.site])).toEqual([["product", "rexel.com.au"], ["spec", "clipsal.com"]]);
    expect(itemLinks({ productUrl: "javascript:alert(1)", specUrl: null })).toEqual([]);
    expect(itemLinks({})).toEqual([]);
    expect(linkSite("https://WWW.Middys.com.au/x")).toBe("middys.com.au");
  });
});
