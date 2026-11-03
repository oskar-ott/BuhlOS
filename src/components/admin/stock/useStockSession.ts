"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cleanBarcode, findByBarcode } from "@/domains/workshop-stock/barcode";
import { addIdentifier, createItem, editItem, fetchItem, fetchLocationMatrix, fetchStockList, newOperationKey, recordMove, storePhoto, undoMovement } from "@/domains/workshop-stock/client";
import { errorCopy, parseTypedQuantity, toQuantityString } from "@/domains/workshop-stock/format";
import { itemWords, placedAmount, productWords, sameProduct, type NewItemDraft } from "@/domains/workshop-stock/intake";
import { ruleFor, type LocationMatrix } from "@/domains/workshop-stock/location-matrix";
import type { StockItem } from "@/domains/workshop-stock/schema";
import { specsForType } from "@/domains/workshop-stock/types";
import { useBarcodeScanner } from "@/components/stock/useBarcodeScanner";
import type { Placed } from "./IntakeCards";
import { playCue } from "./intake-overlay";

/**
 * One office logging session — shared by the camera table (/stock/intake) and
 * the scanner display (/stock/scan). It holds what's been placed or scanned this
 * session and does the writing: log an amount to an item, give it its location
 * from the matrix, add a new item, pick between candidates, change an amount,
 * undo one. Each placement is its own movement with its own idempotency key, so
 * a lost answer retried is never counted twice and Undo takes back that one.
 */

export const NEEDS_YOU = new Set<string>(["pick", "several", "new", "amount", "problem"]);

export interface SessionWording {
  /** written on every movement, so the history says where it came from */
  note: string;
  undoReason: string;
  amountReason: string;
}

/** A placement with nothing known about it yet. */
export function blankPlaced(fields: Pick<Placed, "id" | "status"> & Partial<Placed>): Placed {
  return {
    at: Date.now(), box: { x: 0, y: 0, w: 0, h: 0 }, onTable: false, crop: "", thumb: null,
    barcode: null, product: null, readResult: null, choices: [], problem: null, note: null, busy: false, itemId: null, itemName: null, unit: null, location: null,
    amountMilli: null, fromLabel: false, recordedMilli: null, movementId: null, moveKey: null, photoId: null, retryMilli: null,
    ...fields,
  };
}

export function useStockSession(wording: SessionWording, options: { scanner?: boolean } = {}) {
  const [placed, setPlacedState] = useState<Placed[]>([]);
  const [items, setItemsState] = useState<StockItem[]>([]);
  const [matrix, setMatrix] = useState<LocationMatrix | null>(null);
  const [matrixAvailable, setMatrixAvailable] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [typesEnabled, setTypesEnabled] = useState(false);

  const placedRef = useRef<Placed[]>([]);
  const itemsRef = useRef<StockItem[]>([]);
  const matrixRef = useRef<LocationMatrix | null>(null);
  const assigning = useRef(new Set<string>());
  const words = useRef(wording);
  words.current = wording;

  const setPlaced = useCallback((update: (prev: Placed[]) => Placed[]) => {
    placedRef.current = update(placedRef.current);
    setPlacedState(placedRef.current);
  }, []);
  const patch = useCallback((id: number, change: Partial<Placed>) => {
    setPlaced((prev) => prev.map((p) => (p.id === id ? { ...p, ...change } : p)));
  }, [setPlaced]);
  const placedById = (id: number) => placedRef.current.find((p) => p.id === id);
  const mergeItem = useCallback((item: StockItem) => {
    const known = itemsRef.current.some((i) => i.id === item.id);
    itemsRef.current = known ? itemsRef.current.map((i) => (i.id === item.id ? item : i)) : [...itemsRef.current, item];
    setItemsState(itemsRef.current);
  }, []);

  // ── what's on the list, and where things go ─────────────────────────────────

  const load = useCallback(async () => {
    setLoadError(null);
    const [list, locations] = await Promise.all([fetchStockList(), fetchLocationMatrix()]);
    if (!list.ok) {
      setLoadError(errorCopy(list.error.status, list.error.body, "The server didn't answer, so nothing can be matched yet."));
      return;
    }
    itemsRef.current = list.data.items;
    setItemsState(list.data.items);
    setTypesEnabled(list.data.capabilities.types === true);
    if (!locations.ok) {
      // Starting without it would log everything with no location and no warning.
      setLoadError(errorCopy(locations.error.status, locations.error.body, "The location matrix didn't load, so items couldn't be given a location."));
      return;
    }
    setMatrixAvailable(locations.data.available);
    matrixRef.current = locations.data.matrix;
    setMatrix(locations.data.matrix);
    setLoaded(true);
  }, []);
  useEffect(() => { void load(); }, [load]);

  // ── logging ─────────────────────────────────────────────────────────────────

  async function fullItem(id: string): Promise<StockItem | null> {
    const known = itemsRef.current.find((i) => i.id === id);
    if (known) return known;
    const r = await fetchItem(id);
    if (!r.ok) return null;
    mergeItem(r.data.item);
    return r.data.item;
  }

  /** An item with no location yet takes the matrix's. One that has one keeps it. */
  async function assignLocation(id: number, item: StockItem) {
    if (item.location || assigning.current.has(item.id)) return;
    const match = ruleFor(`${itemWords(item)} ${productWords(placedById(id)?.product)}`, matrixRef.current);
    if (!match) return;
    assigning.current.add(item.id);
    const r = await editItem(item.id, { expectedRevision: item.metaRevision, location: match.location });
    assigning.current.delete(item.id);
    if (!r.ok) {
      patch(id, { note: `Logged, but the location didn't save: ${errorCopy(r.error.status, r.error.body, "try it on the item")}` });
      return;
    }
    mergeItem(r.data.item);
    setPlaced((prev) => prev.map((p) => (p.itemId === item.id ? { ...p, location: match.location } : p)));
  }

  async function logTo(id: number, item: StockItem, chosenMilli: number | null = null) {
    const p = placedById(id);
    if (!p) return;
    const printed = chosenMilli === null ? placedAmount(item.baseUnit, p.product) : null;
    const milli = chosenMilli ?? printed?.milli ?? null;
    const named = { itemId: item.id, itemName: item.name, unit: item.baseUnit, location: item.location };
    if (milli === null) {
      patch(id, { ...named, status: "amount", problem: null });
      return;
    }
    const key = p.moveKey ?? newOperationKey();
    patch(id, { ...named, status: "saving", moveKey: key, amountMilli: milli, fromLabel: Boolean(printed?.fromLabel), problem: null });
    const r = await recordMove({ itemId: item.id, kind: "add", quantity: toQuantityString(milli), note: words.current.note }, key);
    if (!r.ok) {
      patch(id, { status: "problem", problem: errorCopy(r.error.status, r.error.body, "That didn't save. Try again.") });
      return;
    }
    mergeItem(r.data.item);
    patch(id, { status: "logged", movementId: r.data.movement.id, moveKey: null, location: r.data.item.location, recordedMilli: r.data.item.balanceMilli });
    void assignLocation(id, r.data.item);
  }

  /** "One tap, then automatic": anything waiting with the same code goes to the item just settled on. */
  function settleWaiting(from: number, item: StockItem) {
    const source = placedById(from);
    if (!source) return;
    for (const other of placedRef.current) {
      if (other.id === from || (other.status !== "new" && other.status !== "pick")) continue;
      if (sameProduct(source, other)) void logTo(other.id, item);
    }
  }

  async function pickItem(id: number, picked: Pick<StockItem, "id">) {
    const item = await fullItem(picked.id);
    if (!item) {
      patch(id, { status: "problem", problem: "That item isn't in the workshop list any more." });
      return;
    }
    const barcode = placedById(id)?.barcode;
    let current = item;
    if (barcode && !findByBarcode([item], barcode).length) {
      // Teach it the barcode, so the next one logs itself. Not vital if it can't.
      const taught = await addIdentifier({ itemId: item.id, kind: "barcode", value: barcode });
      if (taught.ok) {
        current = taught.data.item;
        mergeItem(current);
      }
    }
    await logTo(id, current);
    settleWaiting(id, current);
  }

  async function createFromDraft(id: number, draft: NewItemDraft) {
    const p = placedById(id);
    if (!p) return;
    const milli = parseTypedQuantity(draft.amount, draft.unit);
    if (!draft.name.trim() || milli === null) {
      patch(id, { problem: !draft.name.trim() ? "Give it a name." : "Enter how many to add." });
      return;
    }
    const key = p.moveKey ?? newOperationKey();
    patch(id, { busy: true, problem: null, moveKey: key });
    let photoId = p.photoId;
    if (!photoId && p.crop) {
      const stored = await storePhoto(p.crop, p.thumb);
      if (stored.ok) {
        photoId = stored.data.photoId;
        patch(id, { photoId });
      }
    }
    const product = p.product;
    const r = await createItem({
      name: draft.name.trim(),
      brand: product?.brand ?? null,
      manufacturerCode: product?.manufacturerCode ?? null,
      supplierSku: product?.supplierSku ?? null,
      supplierName: product?.supplierName ?? null,
      barcode: p.barcode ?? product?.barcode ?? null,
      variant: product?.variantDetails.join(" ").slice(0, 160) || null,
      colourFinish: product?.colourFinish ?? null,
      baseUnit: draft.unit,
      location: draft.location.trim() || null,
      photoId,
      category: draft.category,
      specs: draft.category ? specsForType(draft.category, draft.specs) : undefined,
      openingQuantity: toQuantityString(milli),
      note: words.current.note,
    }, key);
    if (!r.ok) {
      patch(id, { busy: false, problem: errorCopy(r.error.status, r.error.body, "That didn't save. Try again.") });
      return;
    }
    mergeItem(r.data.item);
    patch(id, { busy: false, status: "logged", itemId: r.data.item.id, itemName: r.data.item.name, unit: r.data.item.baseUnit, location: r.data.item.location, amountMilli: milli, fromLabel: false, movementId: r.data.movement.id, moveKey: null, recordedMilli: r.data.item.balanceMilli, problem: null });
    settleWaiting(id, r.data.item);
  }

  /** A logged item no rule placed: the row sets its location, and every row of that item follows. */
  async function setLocation(id: number, location: string) {
    const p = placedById(id);
    if (!p || !p.itemId) return;
    const item = await fullItem(p.itemId);
    if (!item) return;
    patch(id, { busy: true, problem: null });
    const r = await editItem(item.id, { expectedRevision: item.metaRevision, location });
    if (!r.ok) {
      patch(id, { busy: false, problem: errorCopy(r.error.status, r.error.body, "The location didn't save. Try again.") });
      return;
    }
    mergeItem(r.data.item);
    patch(id, { busy: false });
    setPlaced((prev) => prev.map((x) => (x.itemId === item.id ? { ...x, location: r.data.item.location } : x)));
  }

  async function changeAmount(id: number, milli: number) {
    const p = placedById(id);
    if (!p || !p.movementId || !p.itemId) return;
    patch(id, { busy: true, problem: null });
    const undone = await undoMovement({ movementId: p.movementId, reason: words.current.amountReason }, newOperationKey());
    if (!undone.ok) {
      patch(id, { busy: false, problem: errorCopy(undone.error.status, undone.error.body, "The amount wasn't changed. Try again.") });
      return;
    }
    mergeItem(undone.data.item);
    patch(id, { busy: false, movementId: null });
    await logTo(id, undone.data.item, milli);
    if (placedById(id)?.status === "problem") patch(id, { retryMilli: milli });
  }

  async function undoPlaced(id: number) {
    const p = placedById(id);
    if (!p || !p.movementId) return;
    patch(id, { busy: true, problem: null });
    const r = await undoMovement({ movementId: p.movementId, reason: words.current.undoReason }, newOperationKey());
    if (!r.ok) {
      patch(id, { busy: false, problem: errorCopy(r.error.status, r.error.body, "That wasn't undone. Try again.") });
      return;
    }
    mergeItem(r.data.item);
    patch(id, { busy: false, status: "undone", movementId: null, recordedMilli: r.data.item.balanceMilli });
  }

  /** Undo the newest logged one (the U key). */
  function undoLast() {
    const last = placedRef.current.find((p) => p.status === "logged");
    if (last) void undoPlaced(last.id);
  }

  // ── a scan ──────────────────────────────────────────────────────────────────

  // Each scan is one placement, no camera needed: a listed code logs at once (a
  // box's barcode adds a box's worth), several items with it ask which, an
  // unknown one opens the new-item card with it kept. A code that isn't a shop
  // barcode (EAN / UPC) can't be saved as one, so it asks for a search instead.
  // Ids count down from -1, so they never meet the camera tracker's.
  const scanIdRef = useRef(0);
  function scan(code: string) {
    const id = --scanIdRef.current;
    if (!cleanBarcode(code)) {
      setPlaced((prev) => [blankPlaced({
        id, status: "problem",
        problem: `“${code.slice(0, 40)}” isn't a product barcode (EAN or UPC), so it can't be matched or saved. Search for the item instead.`,
      }), ...prev]);
      return;
    }
    const hits = findByBarcode(itemsRef.current, code);
    const one = hits.length === 1 ? hits[0]! : null;
    setPlaced((prev) => [blankPlaced({
      id, status: one ? "saving" : hits.length ? "pick" : "new", barcode: code,
      choices: hits.length > 1 ? hits.map((h) => h.item) : [],
    }), ...prev]);
    if (one) void logTo(id, one.item, one.identifier.packSizeMilli ?? null);
  }

  // A USB / keyboard-style barcode scanner: listened for once the list has
  // loaded (before that every code would look new).
  useBarcodeScanner(scan, loaded && (options.scanner ?? true));

  return {
    placed, items, matrix, matrixAvailable, loadError, loaded, typesEnabled, load,
    placedRef, itemsRef, setPlaced, patch, placedById, mergeItem,
    fullItem, logTo, settleWaiting, pickItem, createFromDraft, setLocation, changeAmount, undoPlaced, undoLast, scan,
  };
}

/** Sound, so nobody has to look up: a rising pair when logged, a low pair when it needs them. */
export function useStatusCues(placed: Placed[], sound: boolean) {
  const seen = useRef(new Map<number, string>());
  const soundRef = useRef(sound);
  soundRef.current = sound;
  useEffect(() => {
    for (const p of placed) {
      const before = seen.current.get(p.id);
      if (before === p.status) continue;
      seen.current.set(p.id, p.status);
      if (!soundRef.current) continue;
      if (p.status === "logged") playCue("logged");
      else if (NEEDS_YOU.has(p.status) && !NEEDS_YOU.has(before ?? "")) playCue("needs");
    }
  }, [placed]);
}

/**
 * Single-key shortcuts that a USB scanner can't set off. A scanner types its code
 * as keys a few ms apart, and a code can hold a U, F, M or space. So a shortcut
 * waits a moment: another key that quick means a scan, and the shortcut is
 * dropped (a person never notices 70 ms).
 */
export function useScanSafeShortcuts(onShortcut: (e: KeyboardEvent) => void) {
  const ref = useRef(onShortcut);
  ref.current = onShortcut;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        return; // the second key of a burst: not a shortcut, and neither was the first
      }
      if (e.key === "Enter" || e.key === "Tab" || e.key.length !== 1) { ref.current(e); return; }
      const tag = (e.target as HTMLElement | null)?.tagName ?? "";
      if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
      if (e.key === " " && !["BUTTON", "SUMMARY", "A"].includes(tag)) e.preventDefault(); // don't scroll while we wait
      timer.current = setTimeout(() => { timer.current = null; ref.current(e); }, 70);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
}
