'use strict';

// Material categories for supplier-invoice line items (owner pull 2026-09-24:
// "see all the materials used on a job and a breakdown — cable, fixings,
// lights…"). A fixed, small taxonomy in site language; every line lands in
// exactly one bucket, `other` when nothing matches. Rules are keyword tests in
// priority order (first hit wins) over the printed description; the office can
// re-file a line, and that choice is REMEMBERED per supplier + description so
// the next invoice files itself (category_source 'learned').

const CATEGORIES = [
  'cable', 'conduit', 'fixings', 'switchgear', 'boards', 'lighting', 'accessories',
  'data', 'consumables', 'tools', 'testing', 'freight', 'other',
];

const CATEGORY_LABELS = {
  cable: 'Cable',
  conduit: 'Conduit & ducting',
  fixings: 'Fixings & fasteners',
  switchgear: 'Switchgear & protection',
  boards: 'Boards & enclosures',
  lighting: 'Lighting',
  accessories: 'Power points & switches',
  data: 'Data & comms',
  consumables: 'Consumables',
  tools: 'Tools',
  testing: 'Testing & safety',
  freight: 'Freight & delivery',
  other: 'Other',
};

// Priority order matters: "cable tie" is a fixing, "cable" alone is cable;
// "conduit saddle" is conduit, "saddle" alone is fixings; "LED downlight" is
// lighting even though "LED" also appears on indicator accessories.
const RULES = [
  { category: 'freight', re: /\b(?:freight|delivery\s*(?:fee|charge)|shipping|courier|postage|handling)\b/i },
  { category: 'testing', re: /\b(?:test\s*(?:&|and)\s*tag|test\s*tag|tag\s*label|multimeter|tester|clamp\s*meter|lockout|lock\s*out|safety\s*(?:sign|tape|vest|glasses|barrier)|hi[\s-]?vis|first\s*aid|ppe|earth\s*leakage\s*tester|insulation\s*tester|megger)\b/i },
  { category: 'tools', re: /\b(?:drill(?!\s*bit)|driver|impact|crimper|crimping\s*tool|stripper|pliers|cutters?|hacksaw|hole\s*saw|screwdriver|spanner|knife|torch|ladder|tool\s*bag|tool\s*box|level|hammer|chisel|punch|fish\s*tape|cable\s*puller|conduit\s*bender|bender)\b/i },
  { category: 'fixings', re: /\b(?:cable\s*ties?|zip\s*ties?|screws?|anchors?|dyna\s*bolts?|dynabolt|wall\s*plugs?|nails?|bolts?|nuts?|washers?|rivets?|brackets?|straps?|clips?|hanger|threaded\s*rod|all\s*thread|unistrut|channel\s*nut|masonry|fixings?|fasteners?|toggles?)\b/i },
  { category: 'conduit', re: /\b(?:conduit|corrugated|corro|corflo|duct(?:ing)?|trunking|elbows?|couplings?|adaptors?|saddles?|inspection\s*(?:bend|tee|elbow)|junction\s*box|j-?box|draw\s*box|adaptable\s*box|bend|glands?|cable\s*tray|catenary|slotted\s*duct)\b/i },
  { category: 'data', re: /\b(?:cat\s*[56]a?e?|cat6|cat5|utp|rj45|patch\s*(?:lead|panel|cord)|data\s*(?:point|outlet|cable|jack)|keystone|fibre|fiber|coax(?:ial)?|rg6|hdmi|ethernet|network|modular\s*plug|krone)\b/i },
  { category: 'lighting', re: /\b(?:down\s*lights?|downlights?|led\s*(?:panel|batten|strip|flood|high\s*bay|oyster|tube|lamp|globe|bulb|driver)|battens?|flood\s*lights?|floodlights?|high\s*bay|oyster|lamps?|globes?|bulbs?|luminaires?|fittings?\s*light|light\s*fittings?|emergency\s*(?:light|exit)|exit\s*sign|spotlights?|track\s*light|pendant|wall\s*light|sensor\s*light|bollard|lighting|troffer|highbay|led\s*\d+w)\b/i },
  { category: 'switchgear', re: /\b(?:mcbs?|rcds?|rcbos?|circuit\s*breakers?|breakers?|main\s*switch|isolators?|contactors?|relays?|timers?|surge\s*(?:protect|diverter|arrester)|spd|fuses?|fuse\s*(?:link|holder|carrier)|busbar|neutral\s*(?:bar|link)|earth\s*(?:bar|link)|din\s*rail|residual\s*current|chassis|safety\s*switch|motor\s*starter|overload|soft\s*starter|vsd|variable\s*speed)\b/i },
  { category: 'boards', re: /\b(?:switchboard|switch\s*board|distribution\s*board|db\s*board|enclosure|meter\s*(?:box|panel|board)|load\s*centre|load\s*center|sub\s*board|sub-?board|panel\s*board|escutcheon|pole\s*fillers?|blanking\s*plates?)\b/i },
  { category: 'accessories', re: /\b(?:gpos?|power\s*points?|powerpoints?|double\s*(?:power|gpo)|single\s*(?:power|gpo)|sockets?|switch\s*(?:mech|mechanism|plate)|mechs?|wall\s*plates?|cover\s*plates?|grid\s*plates?|dimmers?|fan\s*controllers?|isolating\s*switch|weatherproof\s*(?:switch|gpo|socket|outlet)|architrave\s*switch|push\s*button|switches?|light\s*switch|plug\s*tops?|plug\s*base|extension\s*lead|iec\s*lead|usb\s*charger|outlets?)\b/i },
  // (brand names — Clipsal, HPM, PDL, Legrand — are deliberately NOT rules: they make cable and switchgear too)
  { category: 'cable', re: /\b(?:tps|twin\s*(?:&|and)\s*earth|flat\s*(?:twin|cable)|flex(?:ible)?\s*(?:cable|cord)?|orange\s*(?:circ|circular)|circular\s*cable|earth\s*(?:cable|wire)|building\s*wire|single\s*core|multi\s*core|\d+\s*core|xlpe|swa|armoured|armored|neutral\s*screen|ns\s*cable|submain|sub-?main|mains\s*cable|welding\s*cable|cable|wire|conductor|lead\s*\d+m|cord)\b/i },
  { category: 'consumables', re: /\b(?:tape|silicone|sealant|glue|adhesive|lubricant|marker|pen|blades?|drill\s*bits?|bits?|hole\s*saw\s*blade|cutting\s*disc|grinding\s*disc|abrasive|sandpaper|labels?|heat\s*shrink|heatshrink|insulation\s*tape|sleeving|ferrules?|terminals?|lugs?|connectors?|bp\s*connectors?|joiners?|junction|wago|scotch\s*lock|gloves?|rag|cleaner|degreaser|spray|batteries|battery|fasteners\s*kit|screw\s*kit)\b/i },
];

/** @returns {{ category: string, confidence: 'high'|'medium'|'low' }} */
function categorise(description) {
  const d = String(description || '');
  if (!d.trim()) return { category: 'other', confidence: 'low' };
  for (const r of RULES) {
    if (r.re.test(d)) return { category: r.category, confidence: 'medium' };
  }
  return { category: 'other', confidence: 'low' };
}

/** Stable key for "the same product from the same supplier": lower-case
 *  letters/digits, single spaces, bounded. Pure. */
function descriptionKey(description) {
  const k = String(description || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ').slice(0, 120);
  return k || null;
}

function isCategory(v) {
  return CATEGORIES.includes(v);
}

module.exports = { CATEGORIES, CATEGORY_LABELS, RULES, categorise, descriptionKey, isCategory };
