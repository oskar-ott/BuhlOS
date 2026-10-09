import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }), usePathname: () => "/phil/stock" }));

import { StockItemRow } from "./StockItemRow";
import { MoveConfirm } from "./MoveConfirm";
import { LookupCard } from "./LookupCard";
import { QuantityStepper } from "./QuantityStepper";
import { PhilWorkshopStock } from "@/components/phil/PhilWorkshopStock";

/**
 * SSR smoke for the Workshop Stock screens. Interaction flows (photo → read →
 * confirm → undo) are driven end-to-end in the browser harness
 * (docs/workshop-stock.md "Testing"); these pin the static promises.
 */
/** Drop React's SSR text-boundary markers so assertions read like the screen. */
const flat = (html: string) => html.replace(/<!-- -->/g, "");

const base = {
  id: "i1", name: "Clipsal double GPO", brand: "Clipsal", manufacturerCode: "2025WE", supplierSku: "CLI-2025WE", supplierName: "Rexel",
  colourFinish: "white", variant: "10A", location: "Shelf A2", baseUnit: "each" as const, balanceMilli: 42_000, estimated: false, photoId: null,
  defaultPack: null, identifiers: [],
};

describe("StockItemRow", () => {
  it("shows name, identity, where it lives and the recorded quantity with its unit", () => {
    const html = renderToString(createElement(StockItemRow, { item: base, onClick: () => undefined }));
    expect(html).toContain("Clipsal double GPO");
    expect(html).toContain("Shelf A2");
    expect(html).toContain(">42<");
    expect(html).toContain("each");
  });
  it("zero reads 'None recorded'; an estimate is marked; a missing location is said", () => {
    expect(renderToString(createElement(StockItemRow, { item: { ...base, balanceMilli: 0 }, onClick: () => undefined }))).toContain("None recorded");
    const est = renderToString(createElement(StockItemRow, { item: { ...base, baseUnit: "metre", balanceMilli: 40_000, estimated: true, location: null }, onClick: () => undefined }));
    expect(est).toContain("≈");
    expect(est).toContain("(est.)");
    expect(est).toContain("No location set");
  });
});

describe("MoveConfirm", () => {
  it("is the explicit confirmation: item, codes kept apart, location, recorded stock, quantity with unit", () => {
    const html = flat(renderToString(createElement(MoveConfirm, { item: base, kind: "take", matchedBy: "Matched in workshop · code 2025WE", onSaved: () => undefined, onClose: () => undefined })));
    expect(html).toContain("Clipsal double GPO");
    expect(html).toContain("Code 2025WE");
    expect(html).toContain("Supplier SKU CLI-2025WE (Rexel)");
    expect(html).toContain("Workshop: Shelf A2");
    expect(html).toContain("Recorded stock: 42 each");
    expect(html).toContain("Taking");
    expect(html).toContain("Confirm take");
    expect(html).toContain("Matched in workshop · code 2025WE");
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain("Note a job (optional)");
  });
  it("won't let a take go below what's recorded, and says so plainly", () => {
    const html = renderToString(createElement(MoveConfirm, { item: { ...base, balanceMilli: 0 }, kind: "take", onSaved: () => undefined, onClose: () => undefined }));
    expect(html).toContain("None recorded. If there&#x27;s some on the shelf, ask the office to correct the count.");
    expect(html).toMatch(/data-testid="stock-move-submit"[^>]*disabled|disabled[^>]*data-testid="stock-move-submit"/);
  });
  it("offers a defined pack conversion explicitly, never silently", () => {
    const html = flat(renderToString(createElement(MoveConfirm, { item: { ...base, defaultPack: { unit: "box", sizeMilli: 10_000 } }, kind: "add", onSaved: () => undefined, onClose: () => undefined })));
    expect(html).toContain("Count in boxes (1 box = 10 each)");
    expect(html).toContain("This is an estimate");
  });
});

describe("QuantityStepper", () => {
  it("uses the decimal keypad for metres and labels the − / + buttons", () => {
    const html = renderToString(createElement(QuantityStepper, { label: "Taking", valueMilli: 2500, onChange: () => undefined, unit: "metre" }));
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain('value="2.5"');
    expect(html).toContain("One less m");
    expect(html).toContain("One more m");
  });
});

describe("LookupCard", () => {
  it("shows a match as evidence with its source, never as a certificate", () => {
    const html = renderToString(createElement(LookupCard, {
      state: "done", accepted: null, onAccept: () => undefined, onReject: () => undefined,
      result: { status: "possible_match", reasons: ["The page doesn't confirm the brand"], candidate: { name: "Double Power Point", codeAsWritten: "2025WE", sourceUrl: "https://www.rexel.com.au/p", sourceDomain: "rexel.com.au" }, sources: [] },
    }));
    expect(html).toContain("Possible match");
    expect(html).toContain("rexel.com.au");
    expect(html).toContain("The page doesn&#x27;t confirm the brand");
    expect(html).toContain("not a certification");
    expect(html).toContain("Use these details");
  });
  it("an unavailable check is said plainly with nothing to accept", () => {
    const html = renderToString(createElement(LookupCard, { state: "done", accepted: null, onAccept: () => undefined, onReject: () => undefined, result: { status: "unavailable", reasons: ["Couldn't search online right now"], candidate: null, sources: [] } }));
    expect(html).toContain("Couldn&#x27;t check online");
    expect(html).not.toContain("Use these details");
  });
});

describe("PhilWorkshopStock", () => {
  it("first paint: title, the two big actions, search, and an honest loading state", () => {
    const html = renderToString(createElement(PhilWorkshopStock));
    expect(html).toContain("Workshop stock");
    expect(html).toContain("Take stock");
    expect(html).toContain("Add stock");
    expect(html).toContain("Search name, code or shelf");
    expect(html).toContain("Loading workshop stock");
    expect(html).not.toMatch(/\b\d+ items\b/); // no invented count before the list loads
  });
});
