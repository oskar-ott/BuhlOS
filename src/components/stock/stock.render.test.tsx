import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }), usePathname: () => "/phil/stock" }));

import { StockItemRow } from "./StockItemRow";
import { MoveConfirm } from "./MoveConfirm";
import { LookupCard } from "./LookupCard";
import { QuantityStepper } from "./QuantityStepper";
import { StockReceipt } from "./StockReceipt";
import { NewItemForm } from "./NewItemForm";
import { LocationPhoto } from "./LocationPhoto";
import { PhilWorkshopStock } from "@/components/phil/PhilWorkshopStock";

/**
 * SSR smoke for the Workshop Stock screens. Interaction flows (code read →
 * confirm → undo) are driven end-to-end in the browser harness
 * (docs/workshop-stock.md "Testing"); these pin the static promises of the
 * redesign: one decision per level, the quantity the largest thing on a row,
 * the receipt in the ledger's words, nothing invented.
 */
/** Drop React's SSR text-boundary markers so assertions read like the screen. */
const flat = (html: string) => html.replace(/<!-- -->/g, "");

const base = {
  id: "i1", name: "Clipsal double GPO", brand: "Clipsal", manufacturerCode: "2025WE", supplierSku: "CLI-2025WE", supplierName: "Rexel",
  colourFinish: "white", variant: "10A", location: "Shelf A2, Bin 4", baseUnit: "each" as const, balanceMilli: 42_000, estimated: false, version: 3, photoId: null,
  defaultPack: null, identifiers: [],
};

describe("StockItemRow", () => {
  it("shows name, identity, where it lives and the recorded quantity with its unit", () => {
    const html = renderToString(createElement(StockItemRow, { item: base, onClick: () => undefined }));
    expect(html).toContain("Clipsal double GPO");
    expect(html).toContain("Shelf A2, Bin 4");
    expect(html).toContain(">42<");
    expect(html).toContain("each");
  });
  it("under its shelf header the row shows only the bin; zero reads 'None recorded'; an estimate is marked; no shelf is said", () => {
    const grouped = renderToString(createElement(StockItemRow, { item: base, inGroup: true, marker: "just now", onClick: () => undefined }));
    expect(grouped).toContain("Bin 4 · just now");
    expect(grouped).not.toContain("Shelf A2, Bin 4");
    expect(renderToString(createElement(StockItemRow, { item: { ...base, balanceMilli: 0 }, onClick: () => undefined }))).toContain("None recorded");
    const est = renderToString(createElement(StockItemRow, { item: { ...base, baseUnit: "metre", balanceMilli: 40_000, estimated: true, location: null }, onClick: () => undefined }));
    expect(est).toContain("≈ ");
    expect(est).toContain("estimate");
    expect(est).toContain("No shelf set");
  });
});

describe("MoveConfirm", () => {
  it("is the explicit confirmation: item, codes kept apart, shelf, what's recorded, how many, and a button that says what it writes", () => {
    const html = flat(renderToString(createElement(MoveConfirm, { item: base, kind: "take", matchedBy: "Matched in workshop · code 2025WE", onSaved: () => undefined, onClose: () => undefined })));
    expect(html).toContain("Clipsal double GPO");
    expect(html).toContain("Clipsal · 2025WE · white · 10A");
    expect(html).toContain("Supplier SKU CLI-2025WE (Rexel)");
    expect(html).toContain("Shelf A2, Bin 4");
    expect(html).toContain("Recorded on the shelf");
    expect(html).toContain("How many are you taking?");
    expect(html).toContain("Confirm take · 1 each");
    expect(html).toContain("Saves: Taken 1 each · 41 each recorded after this");
    expect(html).toContain("Matched in workshop · code 2025WE");
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain("Note a job");
    expect(html).toContain("not a charge");
  });
  it("says plainly when a take is more than recorded — and only blocks it on a balance read just now", () => {
    const html = flat(renderToString(createElement(MoveConfirm, { item: { ...base, balanceMilli: 0 }, kind: "take", onSaved: () => undefined, onClose: () => undefined })));
    expect(html).toContain("None recorded.");
    expect(html).toContain("If there&#x27;s some on the shelf, ask the office to correct the count.");
    // the list's copy may be stale: until the screen has re-read the item, the server decides
    expect(html).toContain('data-fresh="0"');
    // (match the disabled ATTRIBUTE — the class list always mentions "disabled:")
    expect(html).toMatch(/<button[^>]*data-testid="stock-move-submit"/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*data-testid="stock-move-submit"/);
  });
  it("offers a defined pack conversion explicitly, never silently; adds and returns may be estimates", () => {
    const html = flat(renderToString(createElement(MoveConfirm, { item: { ...base, defaultPack: { unit: "box", sizeMilli: 10_000 } }, kind: "add", onSaved: () => undefined, onClose: () => undefined })));
    expect(html).toContain("Count in boxes (1 box = 10 each)");
    expect(html).toContain("save as an estimate");
    expect(html).toContain("Add to stock · 1 each");
  });
});

describe("StockReceipt", () => {
  const result = {
    item: { ...base, balanceMilli: 40_000, verificationStatus: "manufacturer_code_matched" as const, verification: null, metaRevision: 1, lastMovementAt: null, lastCountedAt: null, lastCountedByName: null, archivedAt: null, createdAt: null, createdByName: null, updatedAt: null },
    movement: { id: "m1", itemId: "i1", kind: "take" as const, quantityMilli: -2000, balanceAfterMilli: 40_000, itemVersionAfter: 4, countedMilli: null, pack: null, estimated: false, jobId: null, jobLabel: null, reason: null, note: null, reversesMovementId: null, actorId: "u1", actorName: "Dan", createdAt: "2026-10-26T07:42:00+11:00", reversedBy: null, undo: { allowed: true, until: "2026-10-26T08:12:00+11:00" } },
  };
  it("reads in the ledger's words, with the new recorded quantity, where, how long it can be undone, and Undo on the receipt", () => {
    const html = flat(renderToString(createElement(StockReceipt, { result, onUndone: () => undefined })));
    expect(html).toContain("Taken 2 each · Clipsal double GPO");
    expect(html).toContain("40 each recorded now");
    expect(html).toContain("· Shelf A2, Bin 4");
    expect(html).toContain("You can undo this until 8:12am.");
    expect(html).toContain("Undo take");
  });
  it("without the server's permission there is no Undo and no promise", () => {
    const html = flat(renderToString(createElement(StockReceipt, { result: { ...result, movement: { ...result.movement, undo: { allowed: false } } }, onUndone: () => undefined })));
    expect(html).not.toContain("Undo take");
    expect(html).not.toContain("You can undo this");
  });
});

describe("QuantityStepper", () => {
  it("uses the decimal keypad for metres, labels the − / + buttons, and says why it is locked", () => {
    const html = renderToString(createElement(QuantityStepper, { label: "How many are you taking?", valueMilli: 2500, onChange: () => undefined, unit: "metre" }));
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain('value="2.5"');
    expect(html).toContain("One less m");
    expect(html).toContain("One more m");
    const locked = renderToString(createElement(QuantityStepper, { label: "How many are you taking?", valueMilli: 2000, onChange: () => undefined, unit: "each", disabled: true, lockedNote: "Locked so it can't record twice" }));
    expect(locked).toContain("Locked so it can&#x27;t record twice");
  });
});

describe("LookupCard", () => {
  it("shows a match as evidence with its source, never as a certificate", () => {
    const html = renderToString(createElement(LookupCard, {
      state: "done", accepted: null, onAccept: () => undefined, onReject: () => undefined,
      result: { status: "possible_match", reasons: ["The page doesn't confirm the brand"], candidate: { name: "Double Power Point", codeAsWritten: "2025WE", sourceUrl: "https://www.rexel.com.au/p", sourceDomain: "rexel.com.au" }, sources: [] },
    }));
    expect(html).toContain("Online check");
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
  it("first paint: title, the two doors pinned at the bottom, search, and an honest loading state", () => {
    const html = renderToString(createElement(PhilWorkshopStock));
    expect(html).toContain("Workshop stock");
    expect(html).toContain("Take stock");
    expect(html).toContain("out of the workshop");
    expect(html).toContain("Add or return");
    expect(html).toContain("into the workshop");
    expect(html).toContain("Search name, code or shelf");
    expect(html).toContain("Loading workshop stock");
    expect(html).not.toMatch(/\b\d+ items\b/); // no invented count before the list loads
    expect(html).not.toContain("Return it"); // Return is a door one level down, not a text link
  });
});

describe("a photo of where it lives", () => {
  const LOC = "55555555-5555-4555-8555-555555555555";
  const seed = { product: null, photoId: null, dataUrl: null };
  const form = (locationPhotoEnabled: boolean) => flat(renderToString(createElement(NewItemForm, { seed, items: [], lookupEnabled: false, locationPhotoEnabled, onSaved: () => undefined, onUseExisting: () => undefined })));

  it("the add form offers it only once the server can keep it", () => {
    const on = form(true);
    expect(on).toContain("Hard to find? Photograph where it lives");
    expect(on).toContain("shown to whoever comes to take it");
    expect(on).toContain('data-testid="stock-new-location-photo-camera"');
    expect(form(false)).not.toContain("Photograph where it lives");
  });

  it("whoever comes to take it sees it beside the shelf on the confirmation — and nothing when there isn't one", () => {
    const html = flat(renderToString(createElement(MoveConfirm, { item: { ...base, location: "Top of the rack, behind the door", locationPhotoId: LOC }, kind: "take", onSaved: () => undefined, onClose: () => undefined })));
    expect(html).toContain("Where to find it");
    expect(html).toContain("Tap to see the photo");
    expect(html).toContain(`action=photo&amp;id=${LOC}&amp;size=thumb`);
    const none = flat(renderToString(createElement(MoveConfirm, { item: base, kind: "take", onSaved: () => undefined, onClose: () => undefined })));
    expect(none).not.toContain("Where to find it");
  });

  it("the viewer link and the list marker say what they are in words", () => {
    const tile = flat(renderToString(createElement(LocationPhoto, { photoId: LOC, location: "Behind the door" })));
    expect(tile).toContain("Where to find it");
    expect(tile).toContain("Behind the door");
    const row = flat(renderToString(createElement(StockItemRow, { item: { ...base, locationPhotoId: LOC }, onClick: () => undefined })));
    expect(row).toContain("has a photo of where it lives");
    expect(flat(renderToString(createElement(StockItemRow, { item: base, onClick: () => undefined })))).not.toContain("photo of where it lives");
  });

  it("a receipt says so when the photo of where it lives didn't attach", () => {
    const result = {
      item: { ...base, verificationStatus: "unverified" as const, verification: null, metaRevision: 1, lastMovementAt: null, lastCountedAt: null, lastCountedByName: null, archivedAt: null, createdAt: null, createdByName: null, updatedAt: null },
      movement: { id: "m1", itemId: "i1", kind: "opening" as const, quantityMilli: 42_000, balanceAfterMilli: 42_000, itemVersionAfter: 1, countedMilli: null, pack: null, estimated: false, jobId: null, jobLabel: null, reason: null, note: null, reversesMovementId: null, actorId: "u1", actorName: "Dan", createdAt: "2026-10-26T07:42:00+11:00", reversedBy: null },
    };
    expect(flat(renderToString(createElement(StockReceipt, { result: { ...result, locationPhotoAttached: false } })))).toContain("The photo of where it lives couldn’t be attached");
    expect(flat(renderToString(createElement(StockReceipt, { result: { ...result, locationPhotoAttached: true } })))).not.toContain("couldn’t be attached");
  });
});
