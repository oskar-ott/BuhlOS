import { itemWords } from "./intake";
import type { MapItem } from "./location-map";
import { binAt, binKey, binsOn, locationText, ruleFor, type LocationMatrix, type MatrixRack, type MatrixRule } from "./location-matrix";
import { canonicalWords } from "./trade-terms";

/**
 * Workshop Stock — a recommended layout for the racks once they exist: related
 * stock beside each other, so GPOs sit by the switches and patch leads by the data
 * jacks. Pure. A plan is only a set of ordinary matrix rules plus what they'd mean
 * for recorded stock; saving it never moves anything (a person does that, under
 * "Needs a place").
 *
 * The neighbours are trade judgement written down here, not anything measured. It
 * knows nothing of how big an item is or how often it's taken, so it never claims
 * the "best" or "fastest" spot: only that these things sit together.
 *
 * Groups go along the racks in one path that turns back at the end of each shelf
 * (shelf A left to right, shelf B right to left), so the end of one shelf sits
 * directly over the start of the next and neighbours in the list stay neighbours.
 */

export interface LayoutGroup {
  key: string;
  label: string;
  /** each is one matrix rule, in the same words a person would write */
  words: readonly string[];
}

export interface LayoutFamily {
  key: string;
  label: string;
  why: string;
  groups: readonly LayoutGroup[];
}

/** In the order they go along the racks: neighbours in this list end up beside each other. */
export const LAYOUT_FAMILIES: readonly LayoutFamily[] = [
  {
    key: "fitoff",
    label: "Switches & GPOs",
    why: "Fit-off gear from the same ranges, so plates, GPOs and mechs sit together.",
    groups: [
      { key: "dimmer", label: "Dimmers", words: ["dimmer"] },
      { key: "fan", label: "Fan controllers", words: ["fan controller", "fan speed"] },
      { key: "switch", label: "Switches", words: ["switch"] },
      { key: "gpo", label: "GPOs", words: ["gpo"] },
      { key: "usb", label: "USB GPOs", words: ["usb gpo", "usb"] },
      { key: "blank", label: "Blank plates", words: ["blank plate", "blank"] },
      { key: "mech", label: "Grids & mechs", words: ["grid", "mech", "mechanism"] },
    ],
  },
  {
    key: "data",
    label: "Data & TV",
    why: "Follows the switches because jacks go on the same plates, with patch leads beside the jacks.",
    groups: [
      { key: "data_jack", label: "Data jacks", words: ["data jack", "data outlet", "data point", "rj45", "keystone", "cat6 jack"] },
      { key: "patch_lead", label: "Patch leads", words: ["patch lead", "patch cord", "patch cable"] },
      { key: "patch_panel", label: "Patch panels", words: ["patch panel"] },
      { key: "data_cable", label: "Data cable", words: ["cat6", "cat 6", "cat5e", "data cable"] },
      { key: "tv", label: "TV & coax", words: ["coax", "tv outlet", "tv point", "antenna"] },
    ],
  },
  {
    key: "boards",
    label: "Breakers & boards",
    why: "Everything for a switchboard in one run.",
    groups: [
      { key: "mcb", label: "Breakers", words: ["mcb"] },
      { key: "rcbo", label: "RCBOs", words: ["rcbo"] },
      { key: "rcd", label: "RCDs", words: ["rcd"] },
      { key: "isolator", label: "Isolators", words: ["isolator", "isolating switch"] },
      { key: "main_switch", label: "Main switches", words: ["main switch"] },
      { key: "surge", label: "Surge diverters", words: ["surge"] },
      { key: "enclosure", label: "Enclosures", words: ["enclosure", "switchboard", "din rail", "meter box"] },
    ],
  },
  {
    key: "lights",
    label: "Lights",
    why: "Light fittings together, downlights first.",
    groups: [
      { key: "downlight", label: "Downlights", words: ["downlight", "down light"] },
      { key: "batten", label: "Battens", words: ["batten"] },
      { key: "oyster", label: "Oysters", words: ["oyster"] },
      { key: "panel", label: "Panel lights", words: ["panel light", "led panel"] },
      { key: "flood", label: "Flood & spot lights", words: ["floodlight", "flood light", "spotlight", "spot light"] },
      { key: "wall", label: "Wall lights & pendants", words: ["wall light", "pendant"] },
    ],
  },
  {
    key: "led",
    label: "LED strip",
    why: "Strip beside its drivers and channel, because a strip job needs all three.",
    groups: [
      { key: "strip", label: "LED strip", words: ["led strip", "led tape", "strip light", "tape light", "neon flex"] },
      { key: "driver", label: "LED drivers", words: ["driver", "power supply", "psu", "led transformer"] },
      { key: "channel", label: "LED channel", words: ["led channel", "led profile", "aluminium channel"] },
    ],
  },
  {
    key: "conduit",
    label: "Conduit & fittings",
    why: "Conduit with its saddles, bends and junction boxes.",
    groups: [
      { key: "conduit", label: "Conduit", words: ["conduit", "corrugated"] },
      { key: "fitting", label: "Bends & couplings", words: ["conduit bend", "conduit elbow", "conduit coupling", "conduit adaptor", "bend", "elbow", "coupling", "adaptor"] },
      { key: "saddle", label: "Saddles & clips", words: ["conduit saddle", "conduit clip", "saddle"] },
      { key: "jb", label: "Junction boxes", words: ["jb"] },
    ],
  },
  {
    key: "cable",
    label: "Cable",
    why: "Power cable together, away from the data cable.",
    groups: [
      { key: "tps", label: "TPS", words: ["tps"] },
      { key: "circular", label: "Orange circular", words: ["orange circular"] },
      { key: "wire", label: "Building wire & SDI", words: ["building wire", "sdi"] },
      { key: "flex", label: "Flex", words: ["flex"] },
      { key: "fire", label: "Fire rated", words: ["fire rated"] },
    ],
  },
  {
    key: "fixings",
    label: "Fixings & consumables",
    why: "Small consumables together.",
    groups: [
      { key: "tie", label: "Cable ties", words: ["cable tie", "zip tie"] },
      { key: "clip", label: "Cable clips", words: ["cable clip"] },
      { key: "screw", label: "Screws", words: ["screw"] },
      { key: "plug", label: "Wall plugs & anchors", words: ["wall plug", "wallplug", "anchor"] },
      { key: "connector", label: "Connectors", words: ["connector", "wago"] },
      { key: "lug", label: "Lugs & ferrules", words: ["lug", "ferrule"] },
      { key: "gland", label: "Glands", words: ["gland"] },
      { key: "tape", label: "Tape & heat shrink", words: ["tape", "heat shrink"] },
      { key: "label", label: "Labels", words: ["label"] },
    ],
  },
];

const MAX_RULE_WORDS = 80;

function wordsKey(words: string): string {
  return [...new Set(canonicalWords(words))].sort().join(" ");
}

interface GroupMatch {
  family: LayoutFamily;
  group: LayoutGroup;
  words: string;
}

/** The group this text belongs to, the same way a rule would match it: all the words, most words wins. */
export function layoutGroupFor(text: string | null | undefined): GroupMatch | null {
  const have = new Set(canonicalWords(text));
  let best: { match: GroupMatch; size: number } | null = null;
  for (const family of LAYOUT_FAMILIES) {
    for (const group of family.groups) {
      for (const words of group.words) {
        const want = new Set(canonicalWords(words));
        if ([...want].every((w) => have.has(w)) && (!best || want.size > best.size)) best = { match: { family, group, words }, size: want.size };
      }
    }
  }
  return best?.match ?? null;
}

type LayoutItem = MapItem & { specs?: Record<string, string> };

/** What splits a group into its own bins: the range if it's on the label, else the brand. */
function lineName(item: LayoutItem): string | null {
  const have = new Set(canonicalWords(itemWords(item)));
  for (const candidate of [item.specs?.range, item.brand]) {
    const text = candidate?.trim();
    if (text && canonicalWords(text).every((w) => have.has(w))) return text;
  }
  return null;
}

/** One bin's worth: a group, or one range or brand of a group that has several. */
interface Line {
  family: LayoutFamily;
  group: LayoutGroup;
  label: string;
  words: string[];
  stock: number;
}

function linesFor(items: readonly LayoutItem[], matrix: LocationMatrix): { lines: Line[]; usual: Line[] } {
  const taken = new Set(matrix.rules.map((r) => wordsKey(r.words)));
  const fresh = (words: readonly string[]) => [...new Set(words)].filter((w) => !taken.has(wordsKey(w)));
  const byGroup = new Map<string, Array<{ item: LayoutItem; words: string }>>();
  for (const item of items) {
    const text = itemWords(item);
    const match = layoutGroupFor(text);
    if (!match || ruleFor(text, matrix)) continue;
    const here = byGroup.get(match.group.key);
    if (here) here.push({ item, words: match.words });
    else byGroup.set(match.group.key, [{ item, words: match.words }]);
  }
  const lines: Line[] = [];
  const usual: Line[] = [];
  for (const family of LAYOUT_FAMILIES) {
    for (const group of family.groups) {
      const stocked = byGroup.get(group.key);
      const words = fresh(group.words);
      const named = new Map<string, { label: string; words: string[]; stock: number }>();
      for (const { item, words: matched } of stocked ?? []) {
        const name = lineName(item);
        if (!name) continue;
        const key = name.toLowerCase();
        const line = named.get(key) ?? { label: name, words: [], stock: 0 };
        line.words.push(`${name} ${matched}`);
        line.stock += 1;
        named.set(key, line);
      }
      const split = named.size >= 2 ? [...named.values()].sort((a, b) => b.stock - a.stock || a.label.localeCompare(b.label, "en-AU")) : [];
      const inLines = split.reduce((n, l) => n + l.stock, 0);
      const out: Line[] = [];
      if (words.length) out.push({ family, group, label: group.label, words, stock: (stocked?.length ?? 0) - inLines });
      for (const line of split) {
        const ruled = fresh(line.words).filter((w) => w.length <= MAX_RULE_WORDS);
        if (ruled.length) out.push({ family, group, label: `${line.label} ${group.label}`, words: ruled, stock: line.stock });
      }
      if (stocked) lines.push(...out);
      usual.push(...out);
    }
  }
  return { lines, usual };
}

interface Slot {
  rack: MatrixRack;
  rackIndex: number;
  shelf: number;
  bin: number;
  index: number;
}

/** Every bin along the path: each shelf turns back at its end, so the path never jumps along a shelf. */
function path(matrix: LocationMatrix): Slot[] {
  const out: Slot[] = [];
  matrix.racks.forEach((rack, rackIndex) => {
    for (let shelf = 1; shelf <= rack.shelves; shelf += 1) {
      const bins = binsOn(rack, shelf);
      for (let n = 1; n <= bins; n += 1) {
        out.push({ rack, rackIndex, shelf, bin: shelf % 2 ? n : bins + 1 - n, index: out.length });
      }
    }
  });
  return out;
}

export interface PlannedBin {
  family: LayoutFamily;
  /** what goes here; empty on a bin left free for the group before it to grow into */
  labels: string[];
  /** recorded stock that would be here under this plan */
  stock: number;
}

export interface PlannedFamily {
  family: LayoutFamily;
  bins: number;
  stock: number;
  from: string;
  to: string;
}

export interface PlannedMove<T> {
  item: T;
  from: string | null;
  to: string;
}

export interface LayoutPlan<T> {
  /** the new rules, to go after the ones kept (a kept rule wins a tie) */
  rules: Array<Omit<MatrixRule, "id">>;
  kept: MatrixRule[];
  bins: Map<string, PlannedBin>;
  families: PlannedFamily[];
  moves: Array<PlannedMove<T>>;
  stays: number;
  /** stock no rule would catch: its name doesn't say what it is. It stays where it is. */
  unsorted: T[];
  /** more groups than bins, so neighbours share */
  shared: boolean;
  /** bins with nothing planned */
  spare: number;
}

/**
 * The layout for these racks and this stock, or null with no racks. Bins that hold
 * stock no group covers, and bins with a kept rule, are left alone. A family that
 * already has a kept rule grows out from it; one that wouldn't fit in what's left of
 * a rack starts on the next, when there's room to spare. Groups in a family sit
 * touching; any free bins go after the family.
 */
export function recommendLayout<T extends LayoutItem>(allItems: readonly T[], matrix: LocationMatrix | null | undefined, options: { keepRules: boolean }): LayoutPlan<T> | null {
  if (!matrix?.racks.length) return null;
  const items = allItems.filter((i) => !i.archivedAt);
  const kept = options.keepRules ? matrix.rules : [];
  const base: LocationMatrix = { racks: matrix.racks, rules: kept };

  const pinned = new Set(kept.map((r) => binKey(r.rackId, r.shelf, r.bin)));
  for (const item of items) {
    const at = binAt(item.location, matrix);
    if (at && !layoutGroupFor(itemWords(item)) && !ruleFor(itemWords(item), base)) pinned.add(binKey(at.rack.id, at.shelf, at.bin));
  }
  const slots = path(matrix);
  const free = slots.filter((s) => !pinned.has(binKey(s.rack.id, s.shelf, s.bin)));

  const { lines: stocked, usual } = linesFor(items, base);
  // The usual groups too when there's no stock to go by or room for all of them, so their rules are ready.
  const lines = !items.length || usual.length <= free.length ? usual : stocked;

  const placed = new Map<string, { slot: Slot; family: LayoutFamily; lines: Line[] }>();
  const put = (slot: Slot, family: LayoutFamily, line: Line | null) => {
    const key = binKey(slot.rack.id, slot.shelf, slot.bin);
    const at = placed.get(key) ?? { slot, family, lines: [] };
    if (line) at.lines.push(line);
    placed.set(key, at);
  };

  const shared = lines.length > free.length;
  if (shared) {
    if (free.length) lines.forEach((line, i) => put(free[Math.floor((i * free.length) / lines.length)]!, line.family, line));
  } else {
    const open = new Set(free);
    const nearest = (to: number): Slot => {
      let best: Slot | null = null;
      for (const slot of open) {
        const d = Math.abs(slot.index - to) - (best ? Math.abs(best.index - to) : Infinity);
        if (d < 0 || (d === 0 && slot.index > best!.index)) best = slot;
      }
      return best!;
    };
    const take = (to: number): Slot => {
      const slot = nearest(to);
      open.delete(slot);
      return slot;
    };
    let slack = free.length - lines.length;

    const anchors = new Map<string, number>();
    for (const rule of kept) {
      const family = layoutGroupFor(rule.words)?.family.key;
      const slot = slots.find((s) => s.rack.id === rule.rackId && s.shelf === rule.shelf && s.bin === rule.bin);
      if (family && slot && !anchors.has(family)) anchors.set(family, slot.index);
    }
    const present = LAYOUT_FAMILIES.filter((f) => lines.some((l) => l.family === f));
    const order = [...present.filter((f) => anchors.has(f.key)), ...present.filter((f) => !anchors.has(f.key))];
    const ends = new Map<string, number>();
    order.forEach((family, done) => {
      const own = lines.filter((l) => l.family === family);
      const before = present[present.indexOf(family) - 1];
      let cursor = anchors.get(family.key) ?? (before ? ends.get(before.key) : undefined) ?? 0;
      if (!anchors.has(family.key)) {
        const start = nearest(cursor);
        const left = [...open].filter((s) => s.rackIndex === start.rackIndex && s.index >= start.index).length;
        const next = [...open].filter((s) => s.rackIndex > start.rackIndex).sort((a, b) => a.index - b.index)[0];
        if (own.length > left && left <= slack && next) {
          slack -= left;
          cursor = next.index;
        }
      }
      for (const line of own) {
        const slot = take(cursor);
        put(slot, family, line);
        cursor = slot.index;
      }
      // Room to grow goes after the family, never between neighbours: at most a bin per group, shared out fairly.
      const groups = new Set(own.map((l) => l.group.key)).size;
      const room = Math.min(groups, Math.ceil(slack / (order.length - done)));
      for (let i = 0; i < room; i += 1) {
        const slot = take(cursor);
        put(slot, family, null);
        cursor = slot.index;
      }
      slack -= room;
      ends.set(family.key, cursor);
    });
  }

  const rules: LayoutPlan<T>["rules"] = [];
  const ordered = [...placed.values()].sort((a, b) => a.slot.index - b.slot.index);
  for (const { slot, lines: here } of ordered) {
    for (const line of here) {
      for (const words of line.words) rules.push({ words, rackId: slot.rack.id, shelf: slot.shelf, bin: slot.bin });
    }
  }

  // What stock would do comes from the rules themselves, so it can't disagree with what they do once saved.
  const proposed: LocationMatrix = { racks: matrix.racks, rules: [...kept, ...rules.map((r, i) => ({ ...r, id: `new-${i}` }))] };
  const bins = new Map<string, PlannedBin>();
  for (const { slot, family, lines: here } of ordered) bins.set(binKey(slot.rack.id, slot.shelf, slot.bin), { family, labels: here.map((l) => l.label), stock: 0 });
  const moves: Array<PlannedMove<T>> = [];
  const unsorted: T[] = [];
  let stays = 0;
  for (const item of items) {
    const rule = ruleFor(itemWords(item), proposed);
    if (!rule) {
      unsorted.push(item);
      continue;
    }
    const planned = bins.get(binKey(rule.rack.id, rule.rule.shelf, rule.rule.bin));
    if (planned) planned.stock += 1;
    if (rule.location.toLowerCase() === item.location?.trim().toLowerCase()) stays += 1;
    else moves.push({ item, from: item.location?.trim() || null, to: rule.location });
  }

  const families: PlannedFamily[] = [];
  for (const family of LAYOUT_FAMILIES) {
    const own = ordered.filter((p) => (p.lines.length ? p.lines.some((l) => l.family === family) : p.family === family));
    if (!own.length) continue;
    const first = own[0]!.slot;
    const last = own[own.length - 1]!.slot;
    families.push({
      family,
      bins: own.length,
      stock: lines.filter((l) => l.family === family).reduce((n, l) => n + l.stock, 0),
      from: locationText(first.rack, first.shelf, first.bin),
      to: locationText(last.rack, last.shelf, last.bin),
    });
  }

  return { rules, kept, bins, families, moves, stays, unsorted, shared, spare: free.length - placed.size };
}
