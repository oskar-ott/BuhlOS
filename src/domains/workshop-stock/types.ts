import type { StockItem, StockUnit } from "./schema";

/**
 * Workshop Stock — item TYPES and the fields each one needs. Pure.
 *
 * Owner pull 2026-11-01: "Switches aren't interchangeable. A Clipsal Iconic 2
 * gang plate is not a Classic one — the range tells me the style, the gang what
 * it is, the colour the colour. Today all of that is shoved in the name. LED
 * strip needs its colour temperature, width, length, brand, voltage." So an
 * item carries a type (`category`) and that type's fields (`specs`), and the
 * phone browses by type with each field as a filter.
 *
 * The catalogue lives here, in the app; the database only keeps the shape (a
 * key, an object of short texts). Brand and colour are the item's own columns
 * (matching and the online check use them) — a type just names them among its
 * fields. Options are the common values offered as one-tap chips; the shop's
 * own values (what's already in stock) are offered first, and anything can be
 * typed. Values are kept the way a sparky writes them ("2 gang", "4000K",
 * "24V", "2.5mm²") — `normaliseValue` tidies what was typed into that form, so
 * "2g" and "2 Gang" filter together.
 *
 * Guessing (from a label photo or an item's name) only ever FILLS a form for a
 * person to check — it never sorts or changes a saved item by itself.
 */

export type FieldFormat = "text" | "gang" | "kelvin" | "volt" | "mm" | "mm2" | "amp" | "watt" | "wattPerMetre" | "metre" | "ip" | "poles" | "cores";

export interface SpecField {
  /** the specs key — or, for `column` fields, the item column it shows */
  key: string;
  label: string;
  /** brand and colour live in the item's own columns */
  column?: "brand" | "colourFinish";
  format?: FieldFormat;
  /** common values, offered as chips (the shop's own come first) */
  options: readonly string[];
  /** shown as a filter when browsing the type */
  facet?: boolean;
  placeholder?: string;
  /** label words that mean an option, when the option's own words aren't on the label */
  aliases?: ReadonlyArray<readonly [RegExp, string]>;
}

export interface StockType {
  key: string;
  label: string;
  /** what most of them are counted in */
  unit: StockUnit;
  fields: readonly SpecField[];
  /** a suggested name from the fields ("Clipsal Iconic 2 gang switch"), or null */
  name: (v: Record<string, string>) => string | null;
}

const BRAND = (options: readonly string[]): SpecField => ({ key: "brand", label: "Brand", column: "brand", options, facet: true });
const COLOUR = (options: readonly string[], label = "Colour"): SpecField => ({ key: "colourFinish", label, column: "colourFinish", options, facet: true });

/** "Switch" → "switch", but GPO / RCBO / TPS / DALI stay as they are. */
function noun(s: string | undefined): string | null {
  if (!s) return null;
  return /[A-Z]{2,}|\d/.test(s) ? s : s.toLowerCase();
}

function join(parts: Array<string | null | undefined>): string | null {
  const out = parts.filter((p): p is string => Boolean(p && p.trim())).join(" ").replace(/\s+/g, " ").trim();
  return out || null;
}

export const STOCK_TYPES: readonly StockType[] = [
  {
    key: "switches",
    label: "Switches & GPOs",
    unit: "each",
    fields: [
      BRAND(["Clipsal", "HPM", "Legrand", "Hager"]),
      { key: "range", label: "Range", options: ["Iconic", "Classic", "Saturn", "Saturn Zen", "Pro Series", "Linea", "Excel Life", "Arteor"], facet: true, placeholder: "e.g. Iconic",
        aliases: [[/\b(c\s?2000|2000 series)\b/i, "Classic"]] },
      { key: "kind", label: "What it is", options: ["Switch", "GPO", "Dimmer", "USB GPO", "Blank plate", "Grid & mechs", "Fan controller", "Data / TV"], facet: true,
        aliases: [[/\busb\b/i, "USB GPO"], [/\b(gpo|power ?point|socket(?: outlet)?|outlet)\b/i, "GPO"], [/\bdimmer\b/i, "Dimmer"], [/\bblank\b/i, "Blank plate"], [/\b(grid|mech(?:anism)?s?)\b/i, "Grid & mechs"], [/\bfan (?:controller|speed)\b/i, "Fan controller"], [/\b(data|rj45|tv|coax)\b/i, "Data / TV"], [/\bswitch\b/i, "Switch"]] },
      { key: "gang", label: "Gang", format: "gang", options: ["1 gang", "2 gang", "3 gang", "4 gang", "5 gang", "6 gang"], facet: true },
      COLOUR(["White", "Vivid white", "Black", "Grey", "Silver"]),
    ],
    name: (v) => join([v.brand, v.range, v.gang, noun(v.kind) ?? "switch plate"]),
  },
  {
    key: "led_strip",
    label: "LED strip",
    unit: "each",
    fields: [
      BRAND([]),
      { key: "cct", label: "Colour temp", format: "kelvin", options: ["2700K", "3000K", "4000K", "5000K", "6000K", "RGB", "RGBW", "Tunable white"], facet: true,
        aliases: [[/\brgbw\b/i, "RGBW"], [/\brgb\b/i, "RGB"], [/\btunable\b/i, "Tunable white"]] },
      { key: "voltage", label: "Voltage", format: "volt", options: ["12V", "24V", "48V"], facet: true },
      { key: "width", label: "Width", format: "mm", options: ["8mm", "10mm", "12mm"], facet: true },
      { key: "length", label: "Length", format: "metre", options: ["5m", "10m", "20m"], facet: true },
      { key: "watts_per_m", label: "Watts per metre", format: "wattPerMetre", options: ["4.8W/m", "9.6W/m", "14.4W/m", "19.2W/m"] },
      { key: "ip", label: "IP rating", format: "ip", options: ["IP20", "IP54", "IP65", "IP67", "IP68"], facet: true },
    ],
    name: (v) => join([v.brand, "LED strip", v.cct, v.voltage, v.length]),
  },
  {
    key: "led_driver",
    label: "LED drivers",
    unit: "each",
    fields: [
      BRAND([]),
      { key: "voltage", label: "Output", format: "volt", options: ["12V", "24V", "48V"], facet: true },
      { key: "watts", label: "Wattage", format: "watt", options: ["30W", "60W", "100W", "150W", "200W", "320W"], facet: true },
      { key: "dimming", label: "Dimming", options: ["Non-dim", "Trailing edge", "DALI", "0–10V", "Push dim"], facet: true,
        aliases: [[/\bdali\b/i, "DALI"], [/\b0\s*[-–]\s*10\s*v\b/i, "0–10V"], [/\b(trailing edge|phase dim)/i, "Trailing edge"], [/\bpush ?dim\b/i, "Push dim"], [/\bnon[- ]?dim/i, "Non-dim"]] },
      { key: "ip", label: "IP rating", format: "ip", options: ["IP20", "IP67"], facet: true },
    ],
    name: (v) => join([v.brand, v.voltage, v.watts, "LED driver"]),
  },
  {
    key: "lights",
    label: "Lights & downlights",
    unit: "each",
    fields: [
      BRAND(["SAL", "Clipsal", "Brilliant", "Domus", "Martec"]),
      { key: "kind", label: "What it is", options: ["Downlight", "Batten", "Oyster", "Panel", "Floodlight", "Spotlight", "Wall light", "Pendant"], facet: true,
        aliases: [[/\bdown ?light\b/i, "Downlight"], [/\bflood ?light\b/i, "Floodlight"], [/\bspot ?light\b/i, "Spotlight"]] },
      { key: "watts", label: "Wattage", format: "watt", options: ["7W", "9W", "10W", "13W", "20W"] },
      { key: "cct", label: "Colour temp", format: "kelvin", options: ["3000K", "4000K", "5000K", "Tri-colour"], facet: true,
        aliases: [[/\b(tri-?colou?r|cct|colour select(?:able)?)\b/i, "Tri-colour"]] },
      { key: "cutout", label: "Cut-out", format: "mm", options: ["70mm", "90mm", "92mm"], facet: true },
      COLOUR(["White", "Black", "Satin chrome", "Brushed chrome"]),
      { key: "dimmable", label: "Dimmable", options: ["Dimmable", "Non-dim"], aliases: [[/\bnon[- ]?dim/i, "Non-dim"], [/\bdimmable\b/i, "Dimmable"]] },
      { key: "ip", label: "IP rating", format: "ip", options: ["IP20", "IP44", "IP54", "IP65"] },
    ],
    name: (v) => join([v.brand, v.watts, v.cct, noun(v.kind) ?? "light"]),
  },
  {
    key: "cable",
    label: "Cable",
    unit: "metre",
    fields: [
      { key: "cable_type", label: "Cable type", options: ["TPS", "Orange circular", "Building wire", "Flex", "Data (Cat6)", "Earth", "Fire rated", "SDI"], facet: true,
        aliases: [[/\b(twin and earth|t\s?&\s?e|tps)\b/i, "TPS"], [/\bcat\s?6/i, "Data (Cat6)"], [/\borange circ/i, "Orange circular"], [/\bfire ?(rated|resist)/i, "Fire rated"], [/\bflex\b/i, "Flex"], [/\bbuilding wire\b/i, "Building wire"]] },
      { key: "size", label: "Size", format: "mm2", options: ["1mm²", "1.5mm²", "2.5mm²", "4mm²", "6mm²", "10mm²", "16mm²"], facet: true },
      { key: "cores", label: "Cores", format: "cores", options: ["1C", "2C", "2C+E", "3C", "3C+E", "4C+E"], facet: true },
      COLOUR(["White", "Grey", "Orange", "Red", "Black", "Green/yellow"], "Sheath colour"),
      BRAND(["Olex", "Prysmian", "Electra"]),
    ],
    name: (v) => join([v.size, v.cores, v.cable_type ?? "cable"]),
  },
  {
    key: "breakers",
    label: "Breakers & RCDs",
    unit: "each",
    fields: [
      BRAND(["Clipsal", "Hager", "NHP", "ABB", "HPM"]),
      { key: "kind", label: "What it is", options: ["MCB", "RCBO", "RCD", "Isolator", "Surge diverter", "Main switch"], facet: true,
        aliases: [[/\brcbo\b/i, "RCBO"], [/\b(rcd|safety switch)\b/i, "RCD"], [/\b(mcb|circuit breaker)\b/i, "MCB"], [/\bisolator\b/i, "Isolator"], [/\bsurge\b/i, "Surge diverter"], [/\bmain switch\b/i, "Main switch"]] },
      { key: "rating", label: "Rating", format: "amp", options: ["6A", "10A", "16A", "20A", "25A", "32A", "40A", "63A"], facet: true },
      { key: "poles", label: "Poles", format: "poles", options: ["1P", "2P", "3P", "4P"], facet: true },
      { key: "curve", label: "Curve", options: ["B", "C", "D"] },
    ],
    name: (v) => join([v.brand, v.rating, v.poles, v.kind ?? "breaker"]),
  },
  {
    key: "conduit",
    label: "Conduit & fittings",
    unit: "each",
    fields: [
      { key: "kind", label: "What it is", options: ["Rigid conduit", "Corrugated", "Saddle", "Coupling", "Bend", "Junction box", "Adaptor", "Clip"], facet: true,
        aliases: [[/\b(junction box|jb)\b/i, "Junction box"], [/\bcorrugated|\bflexible conduit/i, "Corrugated"], [/\b(elbow|bend)\b/i, "Bend"], [/\brigid\b|\bconduit\b/i, "Rigid conduit"]] },
      { key: "size", label: "Size", format: "mm", options: ["16mm", "20mm", "25mm", "32mm", "40mm", "50mm"], facet: true },
      COLOUR(["Grey", "Orange", "White", "Black"]),
      BRAND(["Clipsal", "HPM"]),
    ],
    name: (v) => join([v.size, noun(v.kind) ?? "conduit fitting"]),
  },
  {
    key: "fixings",
    label: "Fixings & consumables",
    unit: "each",
    fields: [
      { key: "kind", label: "What it is", options: ["Screws", "Wall plugs", "Anchors", "Cable ties", "Insulation tape", "Glands", "Lugs", "Connectors", "Heat shrink", "Labels"], facet: true,
        aliases: [[/\b(cable|zip) ties?\b/i, "Cable ties"], [/\bwall ?plugs?\b/i, "Wall plugs"], [/\binsulation tape|\belectrical tape/i, "Insulation tape"], [/\bheat ?shrink\b/i, "Heat shrink"], [/\b(wago|connector)s?\b/i, "Connectors"], [/\bglands?\b/i, "Glands"], [/\blugs?\b/i, "Lugs"], [/\bscrews?\b/i, "Screws"], [/\banchors?\b/i, "Anchors"]] },
      { key: "size", label: "Size", options: [], facet: true, placeholder: "e.g. 8g × 25mm" },
      BRAND(["Wago"]),
    ],
    name: (v) => join([v.size, noun(v.kind)]),
  },
  {
    key: "other",
    label: "Other",
    unit: "each",
    fields: [BRAND([]), COLOUR([])],
    name: () => null,
  },
];

const BY_KEY = new Map(STOCK_TYPES.map((t) => [t.key, t]));
export const OTHER_TYPE = BY_KEY.get("other")!;

/** The type for a saved key: an unknown key reads as Other; none is null (not sorted yet). */
export function typeOf(key: string | null | undefined): StockType | null {
  if (!key) return null;
  return BY_KEY.get(key) ?? OTHER_TYPE;
}

export function typeLabel(key: string | null | undefined): string | null {
  return typeOf(key)?.label ?? null;
}

export const NOT_SORTED_LABEL = "Not sorted yet";

type Typed = Pick<StockItem, "brand" | "colourFinish"> & { category?: string | null; specs?: Record<string, string> };

/** A field's value on an item (column fields read the column). */
export function fieldValue(item: Typed, field: SpecField): string | null {
  const v = field.column ? item[field.column] : item.specs?.[field.key];
  return v && v.trim() ? v : null;
}

/** The type's fields (in order) that have a value on this item. */
export function filledFields(item: Typed): Array<{ field: SpecField; value: string }> {
  const t = typeOf(item.category);
  if (!t) return [];
  const out: Array<{ field: SpecField; value: string }> = [];
  for (const f of t.fields) {
    const v = fieldValue(item, f);
    if (v) out.push({ field: f, value: v });
  }
  return out;
}

// ── tidying what was typed ───────────────────────────────────────────────────

const NUM = "(\\d+(?:[.,]\\d+)?)";
const n = (s: string) => s.replace(",", ".");

/**
 * "2g" → "2 gang", "4000k" → "4000K", "24 v" → "24V", "10 MM" → "10mm",
 * "2.5mm2" → "2.5mm²", "ip65" → "IP65", "2c+e" → "2C+E" — and a value that is
 * an option in other letters takes the option's spelling ("iconic" → "Iconic").
 * Anything else is kept as typed (whitespace tidied).
 */
export function normaliseValue(field: Pick<SpecField, "format" | "options">, raw: string): string {
  let v = raw.replace(/\s+/g, " ").trim();
  if (!v) return "";
  const m = (re: RegExp) => re.exec(v);
  let r: RegExpExecArray | null;
  switch (field.format) {
    case "gang": {
      const words: Record<string, number> = { single: 1, one: 1, double: 2, twin: 2, two: 2, triple: 3, three: 3, quad: 4, four: 4 };
      if ((r = m(/^(\d)\s*-?\s*(?:g|gang|gng)?$/i))) v = `${r[1]} gang`;
      else if ((r = m(/^(single|one|double|twin|two|triple|three|quad|four)(?:\s*gang)?$/i))) v = `${words[r[1]!.toLowerCase()]} gang`;
      break;
    }
    case "kelvin":
      if ((r = m(/^(\d{4})\s*(?:k|kelvin)?$/i))) v = `${r[1]}K`;
      break;
    case "volt":
      if ((r = m(new RegExp(`^${NUM}\\s*(?:v|volts?)?\\s*(dc|ac)?$`, "i")))) v = `${n(r[1]!)}V${r[2] ? ` ${r[2].toUpperCase()}` : ""}`;
      break;
    case "mm":
      if ((r = m(new RegExp(`^${NUM}\\s*(?:mm)?$`, "i")))) v = `${n(r[1]!)}mm`;
      break;
    case "mm2":
      if ((r = m(new RegExp(`^${NUM}\\s*(?:mm2|mm²|mm\\^2|sq\\.?\\s?mm|mm sq|mm)?$`, "i")))) v = `${n(r[1]!)}mm²`;
      break;
    case "amp":
      if ((r = m(new RegExp(`^${NUM}\\s*(?:a|amps?)?$`, "i")))) v = `${n(r[1]!)}A`;
      break;
    case "watt":
      if ((r = m(new RegExp(`^${NUM}\\s*(?:w|watts?)?$`, "i")))) v = `${n(r[1]!)}W`;
      break;
    case "wattPerMetre":
      if ((r = m(new RegExp(`^${NUM}\\s*(?:w)?\\s*(?:/|per)?\\s*(?:m|metre|meter)?$`, "i")))) v = `${n(r[1]!)}W/m`;
      break;
    case "metre":
      if ((r = m(new RegExp(`^${NUM}\\s*(?:m|metres?|meters?)?$`, "i")))) v = `${n(r[1]!)}m`;
      break;
    case "ip":
      if ((r = m(/^(?:ip)?\s*(\d{2})$/i))) v = `IP${r[1]}`;
      break;
    case "poles":
      if ((r = m(/^(\d)\s*(?:p|pole|poles)?$/i))) v = `${r[1]}P`;
      break;
    case "cores":
      if ((r = m(/^(\d)\s*(?:c|core|cores)?\s*(\+\s*e(?:arth)?)?$/i))) v = `${r[1]}C${r[2] ? "+E" : ""}`;
      else if (/^(twin and earth|t\s?&\s?e)$/i.test(v)) v = "2C+E";
      break;
    default:
      break;
  }
  const same = field.options.find((o) => valueKey(o) === valueKey(v));
  return same ?? v;
}

/**
 * What to save as an item's `specs`: only the type's own fields (brand and
 * colour are columns; another type's leftovers are dropped), tidied, empty
 * ones left out.
 */
export function specsForType(category: string | null | undefined, values: Record<string, string>): Record<string, string> {
  const t = typeOf(category);
  const out: Record<string, string> = {};
  if (!t) return out;
  for (const f of t.fields) {
    if (f.column) continue;
    const v = normaliseValue(f, values[f.key] ?? "");
    if (v) out[f.key] = v;
  }
  return out;
}

/** How two values compare: "2 Gang" and "2 gang" are one filter. */
export function valueKey(v: string): string {
  return v.toLowerCase().replace(/\s+/g, " ").trim();
}

// ── guessing from a label or a name (fills a form; never saves) ──────────────

const TYPE_WORDS: ReadonlyArray<readonly [string, RegExp]> = [
  ["led_driver", /\b(led driver|driver|power supply|psu|led transformer)\b/i],
  ["led_strip", /\b(led ?(strip|tape)|strip ?light|tape ?light|neon flex)\b/i],
  ["fixings", /\b(cable ties?|zip ties?|cable clips?)\b/i],
  ["breakers", /\b(mcb|rcbo|rcd|circuit breaker|breaker|safety switch|isolator|surge (diverter|protect\w*)|main switch)\b/i],
  ["cable", /\b(tps|twin and earth|t\s?&\s?e|cable|flex|cat\s?6|cat\s?5e?|building wire|orange circular)\b|\d(\.\d)?\s*(mm2|mm²)/i],
  ["conduit", /\b(conduit|saddles?|couplings?|junction box|corrugated|adaptors?)\b/i],
  ["lights", /\b(down ?lights?|battens?|oyster|flood ?lights?|spot ?lights?|panel light|pendant|wall light|light fitting)\b/i],
  ["switches", /\b(switch(es)?|gpo|power ?points?|sockets?|outlets?|dimmers?|switch ?plates?|mechs?|grid|blank plate|iconic|saturn|c2000|2000 series)\b/i],
  ["fixings", /\b(screws?|wall ?plugs?|anchors?|insulation tape|glands?|lugs?|connectors?|wago|heat ?shrink|staples?)\b/i],
];

/** The type a label or name most likely means, or null. */
export function guessType(texts: ReadonlyArray<string | null | undefined>): string | null {
  const hay = texts.filter(Boolean).join(" \n ");
  if (!hay.trim()) return null;
  for (const [key, re] of TYPE_WORDS) if (re.test(hay)) return key;
  return null;
}

const KNOWN_BRANDS = ["Clipsal", "HPM", "Legrand", "Hager", "ABB", "NHP", "Schneider", "SAL", "Olex", "Prysmian", "Electra", "Brilliant", "Domus", "Martec", "Wago"];
const COLOURS = ["Vivid white", "White", "Black", "Grey", "Silver", "Anthracite", "Orange", "Red", "Satin chrome", "Brushed chrome", "Chrome"];

function wordRe(option: string): RegExp {
  const esc = option.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`, "i");
}

/** One field's value as printed on a label or written in a name, or null. */
function guessField(field: SpecField, hay: string, type: string): string | null {
  let r: RegExpExecArray | null;
  const fmt = field.format;
  if (fmt === "gang") {
    if ((r = /\b([1-6])\s*-?\s*g(?:ang)?\b/i.exec(hay))) return `${r[1]} gang`;
    if ((r = /\b(single|double|twin|triple|quad)\b/i.exec(hay))) return normaliseValue(field, r[1]!);
    return null;
  }
  if (fmt === "kelvin") {
    if ((r = /\b(2[2-9]|[3-6]\d)00\s*k\b/i.exec(hay))) return `${r[1]}00K`;
  } else if (fmt === "volt") {
    if ((r = /\b(5|12|24|36|48|240)\s*v(?:dc|ac)?\b/i.exec(hay))) return `${r[1]}V`;
  } else if (fmt === "mm") {
    const sizes = [...hay.matchAll(/\b(\d{1,3}(?:\.\d)?)\s*mm\b(?![2²])/gi)].map((x) => Number(x[1]));
    const [lo, hi] = field.key === "width" ? [3, 20] : field.key === "cutout" ? [45, 250] : [10, 63];
    const hit = sizes.find((s) => s >= lo && s <= hi);
    if (hit !== undefined) return `${hit}mm`;
  } else if (fmt === "mm2") {
    if ((r = /\b(\d{1,3}(?:\.\d)?)\s*(?:mm2|mm²|sq\.?\s?mm)/i.exec(hay))) return `${r[1]}mm²`;
  } else if (fmt === "amp") {
    if ((r = /\b(\d{1,3})\s*a(?:mps?)?\b/i.exec(hay))) return `${r[1]}A`;
    if ((r = /\b[bcd](\d{1,2})\b/i.exec(hay))) return `${r[1]}A`;
  } else if (fmt === "watt") {
    if ((r = /\b(\d{1,3}(?:\.\d)?)\s*w(?:atts?)?\b(?!\s*\/\s*m)/i.exec(hay))) return `${r[1]}W`;
  } else if (fmt === "wattPerMetre") {
    if ((r = /\b(\d{1,2}(?:\.\d)?)\s*w\s*\/\s*m\b/i.exec(hay))) return `${r[1]}W/m`;
  } else if (fmt === "metre") {
    if ((r = /\b(\d{1,3}(?:\.\d)?)\s*m(?:etres?|eters?)?\b/i.exec(hay))) return `${r[1]}m`;
  } else if (fmt === "ip") {
    if ((r = /\bip\s?([0-6]\d)\b/i.exec(hay))) return `IP${r[1]}`;
  } else if (fmt === "poles") {
    if ((r = /\b([1-4])\s*p(?:ole)?\b/i.exec(hay))) return `${r[1]}P`;
    if ((r = /\b(single|double|triple)\s*pole\b/i.exec(hay))) return `${{ single: 1, double: 2, triple: 3 }[r[1]!.toLowerCase() as "single"]}P`;
  } else if (fmt === "cores") {
    if (/\b(twin and earth|t\s?&\s?e)\b/i.test(hay)) return "2C+E";
    if ((r = /\b([1-5])\s*c(?:ore)?\s*(\+\s*e(?:arth)?)?\b/i.exec(hay))) return `${r[1]}C${r[2] ? "+E" : ""}`;
    if (type === "cable" && /\btps\b/i.test(hay)) return "2C+E";
  } else if (field.key === "curve") {
    if ((r = /\b([bcd])\s*-?\s*curve\b|\bcurve\s*([bcd])\b|\b([bcd])\d{1,2}\b/i.exec(hay))) return (r[1] ?? r[2] ?? r[3])!.toUpperCase();
  } else {
    // the trade's own phrases first ("twin and earth" is TPS, not Earth), then a
    // named option on the label — the longest first ("Saturn Zen" before "Saturn")
    for (const [re, o] of field.aliases ?? []) if (re.test(hay)) return o;
    for (const o of [...field.options].sort((a, b) => b.length - a.length)) if (wordRe(o).test(hay)) return o;
  }
  if (field.format && field.format !== "text") {
    for (const [re, o] of field.aliases ?? []) if (re.test(hay)) return o;
  }
  return null;
}

/**
 * The type's fields as printed on a label (or written in a name), for a person
 * to check. Brand and colour are only guessed when `columns` asks for them
 * (when the label reading didn't already say).
 */
export function guessSpecs(typeKey: string, texts: ReadonlyArray<string | null | undefined>, { columns = false } = {}): Record<string, string> {
  const t = typeOf(typeKey);
  const hay = texts.filter(Boolean).join(" \n ");
  const out: Record<string, string> = {};
  if (!t || !hay.trim()) return out;
  for (const f of t.fields) {
    if (f.column === "brand") {
      if (!columns) continue;
      const b = KNOWN_BRANDS.find((x) => wordRe(x).test(hay));
      if (b) out.brand = b;
      continue;
    }
    if (f.column === "colourFinish") {
      if (!columns) continue;
      const c = [...new Set([...f.options, ...COLOURS])].sort((a, b) => b.length - a.length).find((x) => wordRe(x).test(hay));
      if (c) out.colourFinish = c;
      continue;
    }
    const v = guessField(f, hay, t.key);
    if (v) out[f.key] = normaliseValue(f, v);
  }
  return out;
}

/** A suggested name from the fields ("Clipsal Iconic 2 gang switch"), or null. */
export function suggestTypedName(typeKey: string | null | undefined, values: Record<string, string>): string | null {
  const t = typeOf(typeKey);
  if (!t) return null;
  const any = t.fields.some((f) => f.column !== "brand" && values[f.key]?.trim());
  if (!any) return null;
  const name = t.name(values);
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

// ── browsing: tiles and filters ──────────────────────────────────────────────

export interface TypeTile {
  /** a type key, or null for "Not sorted yet" */
  key: string | null;
  label: string;
  count: number;
  /** the most common values of its first filter ("Iconic · Classic · Saturn") */
  sample: string[];
}

/** One tile per type in stock (catalogue order), then "Not sorted yet". */
export function typeTiles<T extends Typed>(items: readonly T[]): TypeTile[] {
  const by = new Map<string | null, T[]>();
  for (const i of items) {
    const k = i.category ? typeOf(i.category)!.key : null;
    by.set(k, [...(by.get(k) ?? []), i]);
  }
  const out: TypeTile[] = [];
  for (const t of STOCK_TYPES) {
    const list = by.get(t.key);
    if (!list?.length) continue;
    const facets = facetsFor(t, list, {});
    const first = facets.find((f) => f.field.key !== "brand") ?? facets[0];
    const sample = first ? [...first.values].sort((a, b) => b.count - a.count).slice(0, 3).map((v) => v.value) : [];
    out.push({ key: t.key, label: t.label, count: list.length, sample });
  }
  const none = by.get(null);
  if (none?.length) out.push({ key: null, label: NOT_SORTED_LABEL, count: none.length, sample: [] });
  return out;
}

export interface FacetValue {
  value: string;
  key: string;
  /** items with this value among those the OTHER chosen filters leave */
  count: number;
}

export interface Facet {
  field: SpecField;
  values: FacetValue[];
}

/** field key → chosen value key */
export type FacetChoice = Record<string, string>;

const natural = (a: string, b: string) => a.localeCompare(b, "en-AU", { numeric: true, sensitivity: "base" });

function passes<T extends Typed>(item: T, type: StockType, choice: FacetChoice, skip?: string): boolean {
  for (const [k, want] of Object.entries(choice)) {
    if (k === skip) continue;
    const f = type.fields.find((x) => x.key === k);
    if (!f) continue;
    const v = fieldValue(item, f);
    if (!v || valueKey(v) !== want) return false;
  }
  return true;
}

/**
 * The filters for one type, built from what is actually in stock: a field is a
 * filter once its items differ on it (two or more values) or it is chosen.
 * Counts follow the other chosen filters, so a chip never promises items that
 * aren't there.
 */
export function facetsFor<T extends Typed>(type: StockType, items: readonly T[], choice: FacetChoice): Facet[] {
  const out: Facet[] = [];
  for (const f of type.fields) {
    if (!f.facet) continue;
    const all = new Map<string, string>();
    for (const i of items) {
      const v = fieldValue(i, f);
      if (v && !all.has(valueKey(v))) all.set(valueKey(v), v);
    }
    if (all.size < 2 && !(f.key in choice)) continue;
    const counts = new Map<string, number>();
    for (const i of items) {
      if (!passes(i, type, choice, f.key)) continue;
      const v = fieldValue(i, f);
      if (v) counts.set(valueKey(v), (counts.get(valueKey(v)) ?? 0) + 1);
    }
    const order = new Map(f.options.map((o, idx) => [valueKey(o), idx]));
    const values = [...all.entries()]
      .map(([key, value]) => ({ key, value, count: counts.get(key) ?? 0 }))
      .sort((a, b) => {
        const oa = order.get(a.key);
        const ob = order.get(b.key);
        if (oa !== undefined && ob !== undefined) return oa - ob;
        if (f.format && f.format !== "text") return natural(a.value, b.value);
        if (oa !== undefined) return -1;
        if (ob !== undefined) return 1;
        return natural(a.value, b.value);
      });
    out.push({ field: f, values });
  }
  return out;
}

/** The items of a type that pass every chosen filter, in a sensible order (by their fields, then name). */
export function applyFacets<T extends Typed & { name: string }>(type: StockType, items: readonly T[], choice: FacetChoice): T[] {
  const kept = items.filter((i) => passes(i, type, choice));
  const sortKey = (i: T) => type.fields.filter((f) => f.facet).map((f) => fieldValue(i, f) ?? "~").join(" | ");
  return [...kept].sort((a, b) => natural(sortKey(a), sortKey(b)) || natural(a.name, b.name));
}

/** The items of one tile: a type's (unknown keys count as Other), or the unsorted ones (null). */
export function itemsOfType<T extends Typed>(items: readonly T[], key: string | null): T[] {
  return items.filter((i) => (key === null ? !i.category : i.category ? typeOf(i.category)!.key === key : false));
}

/**
 * What to offer as chips for a field: the shop's own values first (most used),
 * then the common ones — one of each, at most `max`.
 */
export function fieldChoices<T extends Typed>(type: StockType, field: SpecField, items: readonly T[], max = 8): string[] {
  const used = new Map<string, { value: string; n: number }>();
  for (const i of items) {
    if (i.category && typeOf(i.category)!.key !== type.key) continue;
    if (!i.category && !field.column) continue;
    const v = fieldValue(i, field);
    if (!v) continue;
    const k = valueKey(v);
    const cur = used.get(k);
    used.set(k, { value: cur?.value ?? v, n: (cur?.n ?? 0) + 1 });
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { value } of [...used.values()].sort((a, b) => b.n - a.n)) {
    if (out.length >= max) break;
    seen.add(valueKey(value));
    out.push(value);
  }
  for (const o of field.options) {
    if (out.length >= max) break;
    if (seen.has(valueKey(o))) continue;
    seen.add(valueKey(o));
    out.push(o);
  }
  return out;
}

/** The text a search looks through for an item's type: its label and its field values. */
export function typeSearchText(item: Typed): string {
  const t = typeOf(item.category);
  if (!t) return "";
  return [t.label, ...Object.values(item.specs ?? {})].join(" ");
}
