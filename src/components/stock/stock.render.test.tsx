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
import { AddOutcome } from "./AddFlow";
import { PhilWorkshopStock } from "@/components/phil/PhilWorkshopStock";
import { BrowseSheet } from "./BrowseSheet";
import { LocationPhotoPrompt } from "./LocationPhotoPrompt";
import { PhotoCapture } from "./PhotoCapture";

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

/** a whole StockItem (the list's shape) */
const full = {
  ...base, supplierSku: null, supplierName: null, locationPhotoId: null, category: null, specs: {}, metaRevision: 1, verificationStatus: "unverified" as const, verification: null,
  lastMovementAt: null, lastCountedAt: null, lastCountedByName: null, archivedAt: null, createdAt: null, createdByName: null, updatedAt: null,
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
  const form = (locationPhotoEnabled: boolean, extra: Record<string, unknown> = {}) => flat(renderToString(createElement(NewItemForm, { seed, items: [], lookupEnabled: false, locationPhotoEnabled, onSaved: () => undefined, onUseExisting: () => undefined, ...extra })));

  it("the add form makes it a step of its own — once the server can keep it", () => {
    const on = form(true);
    expect(on).toContain("Photo of where it&rsquo;s going".replace("&rsquo;", "’"));
    expect(on).toContain("Photograph where it&#x27;s going");
    expect(on).toContain("shown to whoever comes to take it");
    expect(on).toContain('data-testid="stock-new-location-photo-camera"');
    expect(on).not.toContain("Hard to find?");
    expect(form(false)).not.toContain("where it&#x27;s going");
  });

  it("setting up a shelf: the last item's photo is offered again for the same shelf — not for another", () => {
    const last = { itemId: "i9", photoId: LOC, itemName: "Iconic 1 gang switch", location: "Shelf B, Bin 1" };
    const same = form(true, { defaultLocation: "Shelf B, Bin 2", lastLocationPhoto: last });
    expect(same).toContain("Same spot as the last item");
    expect(same).toContain("Different spot");
    expect(same).toContain(`action=photo&amp;id=${LOC}&amp;size=thumb`);
    const other = form(true, { defaultLocation: "Cable bay", lastLocationPhoto: last });
    expect(other).not.toContain("Same spot as the last item");
    expect(other).toContain("Photograph where it&#x27;s going");
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

describe("several products from one photo", () => {
  const product = (description: string, code: string) => ({ brand: "Clipsal", manufacturerCode: code, supplierSku: null, supplierName: null, description, colourFinish: "White", variantDetails: [], barcode: null, packQuantity: null, packUnit: null, labelText: [], position: null });
  const outcome = { kind: "pick-product" as const, products: [product("Double GPO", "2025WE"), product("Single GPO", "2015WE"), product("Blank plate", "30BP")] };
  const props = { outcome, read: null, dataUrl: null, note: null, onClose: () => undefined, onBack: () => undefined, onProduct: () => undefined, onExisting: () => undefined, onNew: () => undefined, onPhoto: () => undefined };

  it("offers to add them all, one at a time, before anything is saved", () => {
    const html = flat(renderToString(createElement(AddOutcome, props)));
    expect(html).toContain("There are 3 products in the photo");
    expect(html).toContain("Add all 3 from this photo");
    expect(html).toContain("nothing is saved until you confirm each");
    expect(html).toContain('data-testid="stock-batch-start"');
    expect(html).toContain("Clipsal Double GPO");
  });

  it("partway through, the list shows what's added and skipped and carries on from where you are", () => {
    const html = flat(renderToString(createElement(AddOutcome, { ...props, batch: { total: 3, current: 2, added: [0], skipped: [1] } })));
    expect(html).toContain("From your photo");
    expect(html).toContain("Carry on · item 3 of 3");
    expect(html).toContain("1 still to add or skip");
    expect(html).toContain(">Added<");
    expect(html).toContain(">Skipped<");
    expect(html).not.toContain("Add all 3");
    const done = flat(renderToString(createElement(AddOutcome, { ...props, batch: { total: 3, current: -1, added: [0, 2], skipped: [1] } })));
    expect(done).not.toContain("Carry on");
    expect(done).toContain("See what was added");
  });
});

describe("item types", () => {
  const seed = { product: null, photoId: null, dataUrl: null };
  it("the new-item form asks what it is once the server keeps types — and not before", () => {
    const on = flat(renderToString(createElement(NewItemForm, { seed, items: [], lookupEnabled: false, typesEnabled: true, onSaved: () => undefined, onUseExisting: () => undefined })));
    expect(on).toContain("What is it?");
    expect(on).toContain("Switches &amp; GPOs");
    expect(on).toContain("LED strip");
    const off = flat(renderToString(createElement(NewItemForm, { seed, items: [], lookupEnabled: false, onSaved: () => undefined, onUseExisting: () => undefined })));
    expect(off).not.toContain("What is it?");
  });
  it("a label photo of an Iconic switch fills the type and its fields, tagged as read from the photo", () => {
    const product = { brand: "Clipsal", manufacturerCode: "3042WE", supplierSku: null, supplierName: null, description: "ICONIC 2 GANG SWITCH", colourFinish: "Vivid white", variantDetails: ["10A"], barcode: null, packQuantity: null, packUnit: null, labelText: ["CLIPSAL", "ICONIC 2 GANG SWITCH 10A"], position: null };
    const html = flat(renderToString(createElement(NewItemForm, { seed: { product, photoId: null, dataUrl: null }, items: [], lookupEnabled: false, typesEnabled: true, onSaved: () => undefined, onUseExisting: () => undefined })));
    expect(html).toMatch(/aria-pressed="true"[^>]*data-testid="stock-type-switches"/);
    expect(html).toContain('data-testid="stock-spec-range" value="Iconic"');
    expect(html).toContain('data-testid="stock-spec-gang" value="2 gang"');
    expect(html).toContain('data-testid="stock-spec-kind" value="Switch"');
    expect(html).toContain("Read from photo");
  });
  it("a typed item's row reads in its fields", () => {
    const row = flat(renderToString(createElement(StockItemRow, { item: { ...base, name: "Iconic 2 gang switch", category: "switches", specs: { range: "Iconic", gang: "2 gang", kind: "Switch" }, manufacturerCode: "3042WE" } as never, onClick: () => undefined })));
    expect(row).toContain("Clipsal · Iconic · Switch · 2 gang · white · 10A · 3042WE");
  });
  it("browsing a type shows its fields as filter chips with counts, and the rows", () => {
    const items = [
      { ...full, id: "a", name: "Iconic 2 gang switch", category: "switches", specs: { range: "Iconic", gang: "2 gang" } },
      { ...full, id: "b", name: "Classic 2 gang switch", category: "switches", specs: { range: "Classic", gang: "2 gang" } },
      { ...full, id: "c", name: "Iconic 1 gang switch", category: "switches", specs: { range: "Iconic", gang: "1 gang" } },
    ];
    const html = flat(renderToString(createElement(BrowseSheet, { mode: { kind: "type", key: "switches" }, items, choice: { range: "iconic" }, onChoice: () => undefined, onPick: () => undefined, onClose: () => undefined })));
    expect(html).toContain("Switches &amp; GPOs");
    expect(html).toContain("2 of 3");
    expect(html).toContain("Clear filters");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Iconic<span[^>]*>2</);
    expect(html).toContain("Iconic 1 gang switch");
    expect(html).not.toContain("Classic 2 gang switch");
  });
});

describe("shopping lists", () => {
  it("a take from a list starts at what it needs and says it ticks the line off", () => {
    const html = flat(renderToString(createElement(MoveConfirm, { item: base, kind: "take", initialQtyMilli: 4000, listLineId: "l1", onSaved: () => undefined, onClose: () => undefined })));
    expect(html).toContain("Confirm take · 4 each");
    expect(html).toContain("ticks it off the list");
  });
  it("putting stock away doesn't prompt for a photo until the item has been read fresh — and never on a take", () => {
    const add = flat(renderToString(createElement(MoveConfirm, { item: base, kind: "add", locationPhotoEnabled: true, onSaved: () => undefined, onClose: () => undefined })));
    expect(add).not.toContain("No photo of where it lives yet");
  });
  it("the prompt itself says what it does", () => {
    const html = flat(renderToString(createElement(LocationPhotoPrompt, { itemId: "i1", onSaved: () => undefined })));
    expect(html).toContain("No photo of where it lives yet");
    expect(html).toContain("Photograph where it&#x27;s going");
  });
});

describe("photos from the camera roll", () => {
  it("every phone photo button has a full camera-roll button under it, not only the camera", () => {
    const html = flat(renderToString(createElement(PhotoCapture, { variant: "single", label: "Take photo of the item", onPhoto: () => undefined })));
    expect(html).toContain("Take photo of the item");
    expect(html).toContain("Use a photo from your camera roll");
    // the camera button opens the camera; the camera-roll one must not force it
    const inputs = html.match(/<input[^>]*>/g) ?? [];
    expect(inputs).toHaveLength(2);
    expect(inputs.filter((i) => i.includes('capture="environment"'))).toHaveLength(1);
  });
});

describe("office categories panel (2026-11-03)", () => {
  it("lists the office's categories with their fields and use, then the built-in ones", async () => {
    const { StockCategories } = await import("@/components/admin/stock/StockCategories");
    const html = flat(renderToString(createElement(StockCategories, {
      customTypes: [{ key: "c_solar_inverters", label: "Solar inverters", unit: "each", fields: [{ key: "power", label: "Power" }, { key: "phase", label: "Phase" }] }],
      items: [{ ...full, category: "c_solar_inverters" }],
      onSaved: () => undefined,
      onClose: () => undefined,
    })));
    expect(html).toContain("New category");
    expect(html).toContain("Solar inverters");
    expect(html).toContain("Brand, Power, Phase");
    expect(html).toContain("1 item");
    expect(html).toContain("Switches &amp; GPOs");
  });
});
