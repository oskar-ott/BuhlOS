import { barcodeKey } from "./barcode";
import { suggestName } from "./flow";
import { ruleFor, type LocationMatrix } from "./location-matrix";
import { guessSpecs, guessType } from "./types";
import type { ReadProduct, StockItem, StockUnit } from "./schema";

/**
 * Workshop Stock, camera table — what a placed object adds and where it goes.
 * Pure; the server re-checks every quantity.
 */

/** Two printed codes compared without their punctuation or case ("30M-WE" = "30mwe"). */
function codeKeyForCompare(code: string | null | undefined): string | null {
  const key = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return key || null;
}

const DISCRETE_CONTAINERS: readonly StockUnit[] = ["box", "pack", "bag", "roll", "length"];

export interface PlacedAmount {
  milli: number;
  /** the amount came from a pack size printed on the label — the screen says so */
  fromLabel: boolean;
}

/**
 * How much one placed object adds. A loose item is 1; a box printed "Pack of 10"
 * of something counted each is 10; an item counted in boxes is 1 box. Metres
 * can't be seen from above: only a printed length counts, otherwise null and the
 * screen asks.
 */
export function placedAmount(unit: StockUnit, product: Pick<ReadProduct, "packQuantity" | "packUnit"> | null | undefined): PlacedAmount | null {
  if (DISCRETE_CONTAINERS.includes(unit)) return { milli: 1000, fromLabel: false };
  const printed = product?.packQuantity && product.packQuantity > 1 ? product.packQuantity : null;
  if (unit === "metre") return printed && product?.packUnit === "metre" ? { milli: printed * 1000, fromLabel: true } : null;
  if (printed && (product?.packUnit === "each" || !product?.packUnit)) return { milli: printed * 1000, fromLabel: true };
  return { milli: 1000, fromLabel: false };
}

/** The text a location rule is matched against. */
export function productWords(p: Pick<ReadProduct, "brand" | "description" | "colourFinish" | "variantDetails" | "labelText" | "manufacturerCode"> | null | undefined): string {
  if (!p) return "";
  return [p.brand, p.description, p.colourFinish, p.manufacturerCode, ...(p.variantDetails || []), ...(p.labelText || [])].filter(Boolean).join(" ");
}

export function itemWords(i: Pick<StockItem, "name" | "brand" | "variant" | "colourFinish" | "manufacturerCode">): string {
  return [i.name, i.brand, i.variant, i.colourFinish, i.manufacturerCode].filter(Boolean).join(" ");
}

export interface NewItemDraft {
  name: string;
  unit: StockUnit;
  /** typed amount, as the field shows it */
  amount: string;
  location: string;
  /** the words of the matrix rule that placed it, when one did */
  locationFrom: string | null;
  /** the item type guessed from the label, for a person to check; null = not sorted */
  category: string | null;
  specs: Record<string, string>;
}

/** The label's words, as the type guesser reads them. */
export function labelTexts(p: Pick<ReadProduct, "brand" | "description" | "colourFinish" | "variantDetails" | "labelText"> | null | undefined): string[] {
  if (!p) return [];
  return [p.brand, p.description, p.colourFinish, ...(p.variantDetails || []), ...(p.labelText || [])].filter((t): t is string => Boolean(t));
}

export function draftFor(product: ReadProduct | null, matrix: LocationMatrix | null): NewItemDraft {
  const unit: StockUnit = product?.packUnit === "metre" ? "metre" : "each";
  const amount = placedAmount(unit, product);
  const match = ruleFor(productWords(product), matrix);
  const texts = labelTexts(product);
  const category = texts.length ? guessType(texts) : null;
  return {
    name: suggestName(product),
    unit,
    amount: amount ? String(amount.milli / 1000) : "",
    location: match?.location ?? "",
    locationFrom: match?.rule.words ?? null,
    category,
    specs: category ? guessSpecs(category, texts) : {},
  };
}

/** The same product, on printed evidence only: same barcode, or the same maker's or supplier's code. */
export function sameProduct(a: { barcode?: string | null; product?: Pick<ReadProduct, "barcode" | "manufacturerCode" | "supplierSku"> | null }, b: { barcode?: string | null; product?: Pick<ReadProduct, "barcode" | "manufacturerCode" | "supplierSku"> | null }): boolean {
  const barcodeA = barcodeKey(a.barcode ?? a.product?.barcode);
  const barcodeB = barcodeKey(b.barcode ?? b.product?.barcode);
  if (barcodeA && barcodeB) return barcodeA === barcodeB;
  const code = (p: typeof a.product, k: "manufacturerCode" | "supplierSku") => codeKeyForCompare(p?.[k]);
  const mfrA = code(a.product, "manufacturerCode");
  if (mfrA && mfrA === code(b.product, "manufacturerCode")) return true;
  const skuA = code(a.product, "supplierSku");
  return Boolean(skuA && skuA === code(b.product, "supplierSku"));
}

export interface SessionLine {
  itemId: string;
  name: string;
  unit: StockUnit;
  location: string | null;
  milli: number;
  placements: number;
}

/** What this session has logged, by item, biggest first. */
export function sessionTotals(placed: ReadonlyArray<{ status: string; itemId: string | null; itemName: string | null; unit: StockUnit | null; location: string | null; amountMilli: number | null }>): SessionLine[] {
  const lines = new Map<string, SessionLine>();
  for (const p of placed) {
    if (p.status !== "logged" || !p.itemId || !p.unit || p.amountMilli === null) continue;
    const line = lines.get(p.itemId);
    if (line) {
      line.milli += p.amountMilli;
      line.placements += 1;
      line.location = p.location ?? line.location;
    } else {
      lines.set(p.itemId, { itemId: p.itemId, name: p.itemName ?? "", unit: p.unit, location: p.location, milli: p.amountMilli, placements: 1 });
    }
  }
  return [...lines.values()].sort((a, b) => b.placements - a.placements || a.name.localeCompare(b.name, "en-AU", { numeric: true, sensitivity: "base" }));
}
