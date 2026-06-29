/* admin-data.js — BuhlOS Admin: the live office surface.
   Supplements window.OPS (ops-data.js) + window.WS (ws-data.js) with the
   registers the modern admin shell exposes that the old Workspace didn't:
   the Needs-Attention exceptions inbox, the cross-job Defects / Observations /
   Material-requests / Expenses / Dayworks inboxes, QA status, ITP templates,
   the owner-numbers Reports board, and per-job hub sections.

   Everything stays in the same world — anchor job 100 Arthur (P25-014,
   dwg 25275N), real bühl crew, status language words-first. Grounded in the
   birdwood route-ownership + needs-attention + owner-dashboard docs. */

window.BX = {
  /* ── Needs Attention — the Command Centre exceptions inbox ──────────────────
     A deterministic projection of the source registers (hours, observations,
     job evidence/snags/ITP, crew, drafts, materials). Each item:
     what happened · which job · why it matters · the next action.
     severity: critical → warning → info.  state: available | fallback.        */
  exceptions: [
    { id: "e1", sev: "critical", source: "Crew", job: "Marion clinic · stage 2", jobId: "MAR-018",
      title: "Active but no field workers assigned", why: "Won Tue, published this morning — nobody can start until a crew is on it.",
      age: "3h", action: "Assign workers", state: "available" },
    { id: "e2", sev: "critical", source: "Materials", job: "100 Arthur", jobId: "P25-014",
      title: "Cat6a × 2 boxes — requested, urgent", why: "L3 comms rough is behind program; MM Electrical cut-off is 14:00 for next-day.",
      age: "4h", action: "Approve & order", state: "available", money: "$1,240" },
    { id: "e3", sev: "warning", source: "Hours", job: "Carlton Hotel · stage 3", jobId: "CRH-2026-03",
      title: "Kane Bell — Wk20 hours awaiting approval", why: "Two 10.5h days flagged; blocks the clean week-20 payroll export Thursday.",
      age: "1d", action: "Open approvals", state: "available" },
    { id: "e4", sev: "warning", source: "Hours", job: "Plympton clinic", jobId: "PLY-016",
      title: "Ruth Strauss — rejected hours need correction", why: "Thursday entry returned for a missing job; she needs to resubmit on Phil.",
      age: "1d", action: "Open approvals", state: "fallback", reason: "no rejected-hours review surface yet — opens the approver queue" },
    { id: "e5", sev: "warning", source: "Observations", job: "100 Arthur", jobId: "P25-014",
      title: "RCP rev C vs site set-out — 6 light points clash", why: "Kane Bell flagged from site with 2 photos; L2 fix crew on hold pending RFI.",
      age: "18m", action: "Open observation", state: "available" },
    { id: "e6", sev: "warning", source: "Evidence", job: "100 Arthur", jobId: "P25-014",
      title: "11 evidence captures to review", why: "Auto-uploaded from Phil, uncategorised; 4 look like L2 ITP evidence.",
      age: "5h", action: "Review evidence", state: "available", count: 11 },
    { id: "e7", sev: "warning", source: "ITP", job: "100 Arthur", jobId: "P25-014",
      title: "L2 ceiling rough-in ITP needs sign-off", why: "All 14 rows marked pass on site; one row carries a note (cable support spacing).",
      age: "3h", action: "Review & countersign", state: "available" },
    { id: "e8", sev: "warning", source: "Snags", job: "Birdwood subdivision", jobId: "BWD-009",
      title: "2 open snags", why: "Switchboard clash with hydraulic riser (lot 14) still open 1 day.",
      age: "1d", action: "Open defects", state: "available", count: 2 },
    { id: "e9", sev: "warning", source: "Observations", job: "Glenelg primary fit-out", jobId: "GLN-011",
      title: "Cable tray clash — unclassified, unassigned", why: "Photographed by Jordan Pham 2 days ago; still no owner or classification.",
      age: "2d", action: "Open observation", state: "available" },
    { id: "e10", sev: "info", source: "Materials", job: "Birdwood subdivision", jobId: "BWD-009",
      title: "25 mm conduit × 10 lengths — approved", why: "Approved yesterday; place the order with the supplier to keep lot 14 moving.",
      age: "1d", action: "Place order", state: "available", money: "$310" },
    { id: "e11", sev: "info", source: "Drafts", job: "Prospect townhouses × 6", jobId: "PRO-021",
      title: "Draft — not published", why: "Won quote converted to a draft job; field can't see it until you publish.",
      age: "2d", action: "Open builder", state: "available" },
  ],

  /* ── Defects register (/defects) — cross-job snags, both stores normalised ── */
  defects: [
    { id: "SNG-014-04", what: "Pendant runs foul new bulkhead, grid F-H", job: "100 Arthur", area: "L2", priority: ["red", "urgent"], status: "open", who: "Kane Bell", age: "18m", photos: 2 },
    { id: "SNG-CRH-07", what: "Water ingress near MSB cupboard after rain", job: "Carlton Hotel · stage 3", area: "GF", priority: ["red", "high"], status: "open", who: "Jordan Pham", age: "2h", photos: 1 },
    { id: "SNG-009-11", what: "Switchboard position clashes hydraulic riser", job: "Birdwood subdivision", area: "Lot 14", priority: ["amber", "high"], status: "open", who: "Tom Reed", age: "1d", photos: 1 },
    { id: "SNG-011-18", what: "Cable tray clash, L3 — unclassified", job: "Glenelg primary fit-out", area: "L3", priority: ["amber", "medium"], status: "open", who: "Unassigned", age: "2d", photos: 1 },
    { id: "SNG-014-03", what: "Conduit penetration unsealed, riser 2", job: "100 Arthur", area: "L3", priority: ["amber", "medium"], status: "open", who: "An Bui", age: "1d", photos: 0 },
    { id: "SNG-014-02", what: "Scuffed switch plate, reception", job: "100 Arthur", area: "GF", priority: ["grey", "low"], status: "open", who: "Jordan Pham", age: "3d", photos: 1 },
    { id: "SNG-016-01", what: "Cracked GPO faceplate, consult room 3", job: "Plympton clinic", area: "Rough-in", priority: ["grey", "low"], status: "open", who: "Ruth Strauss", age: "4d", photos: 1 },
    { id: "SNG-004-09", what: "Mislabelled circuit at DB-2", job: "Norwood depot", area: "Plant", priority: ["green", "closed"], status: "closed", who: "Sara Park", age: "closed 2d", photos: 2 },
    { id: "SNG-011-15", what: "Missing blank plate, corridor", job: "Glenelg primary fit-out", area: "L1", priority: ["green", "closed"], status: "closed", who: "An Bui", age: "closed 3d", photos: 1 },
  ],

  /* ── Observations inbox (/observations) — field-to-office triage ───────────── */
  observations: [
    { id: "OBS-014-22", type: "Plan mismatch", what: "Ceiling grid 240mm off RCP rev C — pendants foul bulkhead", job: "100 Arthur", area: "L2", who: "Kane Bell", age: "18m", priority: ["red", "needs action"], photo: true },
    { id: "OBS-CRH-08", type: "Blocker", what: "No power to site — temp board tripped overnight, tools dead", job: "Carlton Hotel · stage 3", area: "GF", who: "Jordan Pham", age: "22m", priority: ["red", "needs action"], photo: true },
    { id: "OBS-009-05", type: "RFI", what: "Switchboard location query — clash with hydraulic riser", job: "Birdwood subdivision", area: "Lot 14", who: "Tom Reed", age: "1d", priority: ["amber", "needs action"], photo: true },
    { id: "OBS-011-12", type: "Variation", what: "Client rep asked for 4 extra data points at reception", job: "Glenelg primary fit-out", area: "GF", who: "An Bui", age: "6h", priority: ["amber", "open"], photo: false },
    { id: "OBS-014-19", type: "Material need", what: "Site 1.5 boxes short for L3 comms rough", job: "100 Arthur", area: "L3", who: "An Bui", age: "4h", priority: ["amber", "open"], photo: true },
    { id: "OBS-016-03", type: "Site instruction", what: "Builder wants consult rooms isolated for paint Mon", job: "Plympton clinic", area: "Rough-in", who: "Ruth Strauss", age: "1d", priority: ["grey", "open"], photo: false },
    { id: "OBS-004-07", type: "Defect", what: "Mislabelled circuit at DB-2 — corrected, logging it", job: "Norwood depot", area: "Plant", who: "Sara Park", age: "2d", priority: ["green", "resolved"], photo: true },
  ],

  /* ── Material Requests inbox (/material-requests) — the procurement loop ────── */
  materials: [
    { id: "REQ-014-22", item: "Cat6a U/UTP — 305m box × 2", job: "100 Arthur", who: "An Bui", supplier: "MM Electrical", value: "$1,240", status: ["amber", "requested"], age: "4h", priority: "urgent" },
    { id: "REQ-009-14", item: "25 mm HD conduit × 10 lengths", job: "Birdwood subdivision", who: "Tom Reed", supplier: "Rexel", value: "$310", status: ["navy", "approved"], age: "1d", priority: "normal" },
    { id: "REQ-CRH-06", item: "SWA 4c 16mm² cable + glands", job: "Carlton Hotel · stage 3", who: "Kane Bell", supplier: "MM Electrical", value: "$6,140", status: ["amber", "requested"], age: "3h", priority: "high" },
    { id: "REQ-014-20", item: "LED downlights 90mm × 24", job: "100 Arthur", who: "An Bui", supplier: "Rexel", value: "$1,008", status: ["green", "ordered"], age: "2d", priority: "normal" },
    { id: "REQ-011-09", item: "Cable tray 150mm × 6m × 8", job: "Glenelg primary fit-out", who: "An Bui", supplier: "MM Electrical", value: "$1,470", status: ["green", "delivered"], age: "3d", priority: "normal" },
    { id: "REQ-016-04", item: "Final fix plates — white × 40", job: "Plympton clinic", who: "Ruth Strauss", supplier: "Rexel", value: "$420", status: ["navy", "approved"], age: "1d", priority: "normal" },
    { id: "REQ-009-11", item: "Earth stakes + clamps × 24", job: "Birdwood subdivision", who: "Tom Reed", supplier: "Rexel", value: "$288", status: ["grey", "cancelled"], age: "4d", priority: "normal" },
  ],

  /* ── Expenses / reimbursements (/expenses) — field receipts, integer cents ── */
  expenses: [
    { id: "EXP-2031", who: "Kane Bell", cat: "Parking", amount: "$28.50", job: "100 Arthur", status: ["amber", "submitted"], age: "2h", receipt: true },
    { id: "EXP-2030", who: "Tom Reed", cat: "Consumables", amount: "$142.00", job: "Birdwood subdivision", status: ["amber", "submitted"], age: "5h", receipt: true },
    { id: "EXP-2029", who: "An Bui", cat: "Fuel", amount: "$96.40", job: "100 Arthur", status: ["navy", "approved"], age: "1d", receipt: true },
    { id: "EXP-2028", who: "Jordan Pham", cat: "Tools", amount: "$54.00", job: "Carlton Hotel · stage 3", status: ["amber", "submitted"], age: "1d", receipt: true },
    { id: "EXP-2027", who: "Ruth Strauss", cat: "PPE", amount: "$38.90", job: "Plympton clinic", status: ["green", "reimbursed"], age: "3d", receipt: true },
    { id: "EXP-2026", who: "Kane Bell", cat: "Parking", amount: "$22.00", job: "Carlton Hotel · stage 3", status: ["green", "reimbursed"], age: "4d", receipt: true },
    { id: "EXP-2025", who: "An Bui", cat: "Meals", amount: "$31.00", job: "100 Arthur", status: ["grey", "declined"], age: "5d", receipt: false },
  ],

  /* ── Dayworks rollup (/v2/dayworks) — unsigned-aging payment risk ───────────── */
  dayworks: [
    { id: "DW-014-12", job: "100 Arthur", desc: "Extra GPOs + data, L4 conference rooms", hours: "14.0h", value: "$1,840", status: ["red", "unsigned"], age: "6d", risk: "high" },
    { id: "DW-CRH-05", job: "Carlton Hotel · stage 3", desc: "Make-safe after temp board trip", hours: "5.5h", value: "$720", status: ["amber", "unsigned"], age: "3d", risk: "med" },
    { id: "DW-009-08", job: "Birdwood subdivision", desc: "Hand-dig around unmarked services, lot 9", hours: "8.0h", value: "$928", status: ["amber", "unsigned"], age: "2d", risk: "med" },
    { id: "DW-011-03", job: "Glenelg primary fit-out", desc: "After-hours isolation for builder paint", hours: "3.0h", value: "$392", status: ["green", "signed"], age: "signed 1d", risk: "low" },
    { id: "DW-014-10", job: "100 Arthur", desc: "Standby — crane lift access GF", hours: "4.0h", value: "$524", status: ["green", "signed"], age: "signed 4d", risk: "low" },
  ],

  /* ── QA status (/qa) — cross-job ITP / inspection rollup, read-only ─────────── */
  qa: [
    { job: "100 Arthur", jobId: "P25-014", total: 8, signed: 3, review: 1, open: 4, pct: 0.38 },
    { job: "Carlton Hotel · stage 3", jobId: "CRH-2026-03", total: 5, signed: 2, review: 1, open: 2, pct: 0.40 },
    { job: "Birdwood subdivision", jobId: "BWD-009", total: 6, signed: 2, review: 0, open: 4, pct: 0.33 },
    { job: "Glenelg primary fit-out", jobId: "GLN-011", total: 4, signed: 3, review: 1, open: 0, pct: 0.75 },
    { job: "Plympton clinic", jobId: "PLY-016", total: 3, signed: 0, review: 0, open: 3, pct: 0.00 },
    { job: "Norwood depot", jobId: "NRW-004", total: 5, signed: 5, review: 0, open: 0, pct: 1.00 },
  ],

  /* ── ITP templates (/itp-templates) — the library jobs draw from ───────────── */
  itpTemplates: [
    { id: "TPL-CEIL", name: "Ceiling rough-in", discipline: "Rough-in", rows: 14, usedOn: 6, updated: "Apr 2026" },
    { id: "TPL-FITOFF", name: "Final fit-off", discipline: "Fit-off", rows: 22, usedOn: 9, updated: "Mar 2026" },
    { id: "TPL-COMMS", name: "Comms + data rough", discipline: "Rough-in", rows: 18, usedOn: 4, updated: "May 2026" },
    { id: "TPL-MSB", name: "Main switchboard install", discipline: "Switchboard", rows: 16, usedOn: 7, updated: "Feb 2026" },
    { id: "TPL-TEST", name: "Test & commission", discipline: "Commissioning", rows: 11, usedOn: 8, updated: "May 2026" },
    { id: "TPL-HV", name: "HV / supply authority", discipline: "Switchboard", rows: 9, usedOn: 2, updated: "Jan 2026" },
  ],

  /* ── Reports — the six owner numbers (#316). value · trend · state · drill. ── */
  ownerNumbers: [
    { id: "n1", label: "Hours this week", value: "412h", trend: "▲ 6% vs last wk", state: "ok", note: "submitted + approved · week in progress", drill: "hours" },
    { id: "n2", label: "Approvals waiting", value: "5", trend: "▼ 3 vs last wk", state: "warn", note: "submitted entries · same source as Today", drill: "hours" },
    { id: "n3", label: "On the clock today", value: "14", trend: "of 21 roster", state: "ok", note: "distinct workers with logged hours", drill: "hours" },
    { id: "n4", label: "Open defects · priority/stale", value: "6", trend: "▲ 1 vs last wk", state: "warn", note: "urgent/high or past stale threshold", drill: "defects" },
    { id: "n5", label: "Active quotes", value: "3", trend: "1 stale > 7d", state: "warn", note: "in the register · $257k pipeline", drill: "quotes" },
    { id: "n6", label: "Jobs forecast over contract", value: "1", trend: "Carlton · +$6.4k", state: "danger", note: "cash-watch overrun alert", drill: "jobs" },
  ],

  /* ── Notification settings (/settings/notifications) — per-type toggles ────── */
  notifPrefs: [
    { k: "hours", label: "Hours awaiting approval", desc: "When a worker submits a week for approval", on: true },
    { k: "defects", label: "New urgent defect", desc: "Urgent or high-priority snag raised from site", on: true },
    { k: "observations", label: "Field observation needs action", desc: "Blocker, plan mismatch or RFI flagged on a job", on: true },
    { k: "materials", label: "Material request", desc: "A site request enters the procurement queue", on: true },
    { k: "expenses", label: "Expense submitted", desc: "A worker submits a receipt for reimbursement", on: false },
    { k: "overrun", label: "Cash-watch overrun", desc: "A job is forecast over contract value", on: true },
    { k: "digest", label: "Daily office digest", desc: "One 7:00am summary of what needs you today", on: true },
  ],

  /* ── Per-job hub sections — evidence, plans, materials, activity ─────────────
     Keyed by jobId. The hub reuses WS.arthur for the anchor job's stages/itps/snags. */
  hub: {
    "P25-014": {
      sections: { evidence: 11, snags: 3, itps: 1, plans: 2, materials: 3, dayworks: 2, hours: 9 },
      evidence: [
        { id: "CAP-014-31", what: "L2 ceiling rough-in — bay 4 complete", who: "Kane Bell", age: "3h", tag: ["amber", "untagged"] },
        { id: "CAP-014-30", what: "Riser 2 penetration before seal", who: "An Bui", age: "5h", tag: ["green", "itp evidence"] },
        { id: "CAP-014-29", what: "Reception GPO rough — grid A", who: "Jordan Pham", age: "1d", tag: ["green", "progress"] },
      ],
      plans: [
        { id: "DWG 25275N", name: "Electrical services — rev C", status: ["navy", "current"], date: "Issued 14 May" },
        { id: "DWG 25275M", name: "Electrical services — rev B", status: ["grey", "superseded"], date: "Issued 28 Apr" },
      ],
      materials: [
        { id: "REQ-014-22", item: "Cat6a × 2 boxes", status: ["amber", "requested"], who: "An Bui" },
        { id: "REQ-014-20", item: "LED downlights × 24", status: ["green", "ordered"], who: "An Bui" },
      ],
      activity: [
        { who: "Kane Bell", what: "flagged a plan mismatch on L2", age: "18m" },
        { who: "An Bui", what: "marked 14 ITP rows pass on L2 ceiling", age: "3h" },
        { who: "Sara Park", what: "priced variation VAR-014-07 ($1,840)", age: "2h" },
        { who: "An Bui", what: "requested Cat6a × 2 boxes", age: "4h" },
      ],
    },
  },

  /* ── New jobs referenced by exceptions (so the inbox links resolve) ─────────── */
  extraJobs: [
    { id: "MAR-018", name: "Marion clinic · stage 2", client: "SA Health", type: "Healthcare rough-in",
      stage: "Mobilising", pm: "S. Park", value: "$132k", billed: 0, status: ["amber", "no crew"],
      crew: 0, addr: "Marion Rd, Marion", program: "Day 0 of 50", risk: 44,
      drawing: "MAR-EL-01", margin: "—", invoiced: "$0", retention: "$0",
      next: "Active but no field workers assigned — assign a crew to start" },
    { id: "PRO-021", name: "Prospect townhouses × 6", client: "Devine Homes", type: "Residential · 6 units",
      stage: "Draft", pm: "S. Park", value: "$214k", billed: 0, status: ["grey", "draft"],
      crew: 0, addr: "Prospect Rd, Prospect", program: "Not published", risk: 12,
      drawing: "PRO-SET", margin: "—", invoiced: "$0", retention: "$0",
      next: "Draft job from won quote — publish to make it visible to the field" },
  ],
};

/* ── Per-job hub detail (modern Job Interface). The anchor + a couple of jobs
   carry rich overrides; the hub derives sensible defaults for the rest.
   Grounded in birdwood /v2/jobs/[jobId] render order: build & publish, pre-start
   readiness, labour, evidence, recent activity (audit), induction, site. ───── */
window.BX.jobHub = {
  "P25-014": {
    published: true, fromQuote: "QTE-019", created: "14 Apr 2026",
    structure: { areaGroups: 5, areas: 18, roughIn: 142, fitOff: 96 },
    readiness: { state: "blocked", items: [
      { label: "Site induction", ok: false, note: "8 of 9 crew inducted · Liam Marriott outstanding" },
      { label: "Electrical licences", ok: true, note: "All 6 field crew current — checked 12 May" },
      { label: "Safety docs · SWMS", ok: true, note: "SWMS + JSA signed 12 May" },
      { label: "Pre-start checklist", ok: false, note: "RCP rev C clash open — L2 RFI pending" },
    ] },
    labour: { pending: 1, pendingHrs: "47.0h", pendingVal: "$2,726", week: "Wk20", who: "Kane Bell", approved: "$7,872" },
    evidence: [ ["amber", "untagged", 4], ["navy", "in review", 3], ["green", "accepted", 4] ],
    induction: { required: true, inducted: 8, total: 9, missing: "Liam Marriott" },
    site: {
      contact: "Mark Thomas", role: "Builder · Thomas Bros", phone: "+61 419 882 110",
      access: "Site key + swipe from the builder's container at Gate B, Arthur St. Sign in on arrival.",
      parking: "Contractor bays on L1 of the deck — permit on the dash.",
      safety: "Hard hat, hi-vis & glasses site-wide. Live board on L5 — lock-out / tag-out in force.",
    },
    activity: [
      { who: "Kane Bell", what: "flagged a plan mismatch on L2", age: "18m" },
      { who: "An Bui", what: "marked 14 ITP rows pass on L2 ceiling", age: "3h" },
      { who: "Sara Park", what: "priced variation VAR-014-07 ($1,840)", age: "2h" },
      { who: "An Bui", what: "requested Cat6a × 2 boxes", age: "4h" },
    ],
  },
  "CRH-2026-03": {
    published: true, created: "21 Apr 2026",
    structure: { areaGroups: 3, areas: 9, roughIn: 64, fitOff: 0 },
    readiness: { state: "caution", items: [
      { label: "Site induction", ok: true, note: "All 6 crew inducted" },
      { label: "Electrical licences", ok: true, note: "Current" },
      { label: "Safety docs · SWMS", ok: false, note: "Wet-weather SWMS needs re-sign after ingress" },
      { label: "Pre-start checklist", ok: true, note: "Cleared 19 May" },
    ] },
    labour: { pending: 1, pendingHrs: "47.0h", pendingVal: "$2,726", week: "Wk20", who: "Kane Bell", approved: "$5,310" },
    evidence: [ ["amber", "untagged", 2], ["green", "accepted", 3] ],
    induction: { required: true, inducted: 6, total: 6, missing: null },
    site: {
      contact: "Dana Reyes", role: "Carlton Group PM", phone: "+61 402 551 778",
      access: "North Tce loading dock, 6am–2pm only. Builder escort to basement.",
      parking: "Street metered — no on-site parking.",
      safety: "Confined-space permit for the riser. Temp power only after the make-safe.",
    },
    activity: [
      { who: "Jordan Pham", what: "reported no power to site", age: "22m" },
      { who: "Sara Park", what: "raised daywork DW-CRH-05 (make-safe)", age: "3h" },
    ],
  },
  "PRO-021": {
    published: false, fromQuote: "QTE-024", created: "22 May 2026",
    structure: { areaGroups: 6, areas: 6, roughIn: 0, fitOff: 0 },
    readiness: { state: "blocked", items: [
      { label: "Site induction", ok: false, note: "No crew assigned yet" },
      { label: "Electrical licences", ok: false, note: "Pending crew assignment" },
      { label: "Safety docs · SWMS", ok: false, note: "Not started" },
      { label: "Pre-start checklist", ok: false, note: "Draft — not published to the field" },
    ] },
    labour: { pending: 0 },
    evidence: [],
    induction: { required: true, inducted: 0, total: 0, missing: null },
    site: {
      contact: "Devine Homes", role: "Builder", phone: "",
      access: "Access details to be confirmed at handover from estimating.",
      parking: "", safety: "Standard PPE — site controls TBC.",
    },
    activity: [],
  },
};

/* ── Confidential cost rates (Employees drawer, admin-only). Effective-dated
   history of internal cost/hr + charge-out. NEVER shown in general lists. ──── */
window.BX.costRates = {
  "Kane Bell": [
    { from: "1 Jul 2025", cost: "$58.00", charge: "$112", reason: "EBA increase + leading-hand allowance" },
    { from: "1 Jul 2024", cost: "$54.50", charge: "$104", reason: "Annual review" },
    { from: "1 Mar 2024", cost: "$52.00", charge: "$99",  reason: "Promotion to leading hand" },
  ],
  "An Bui": [
    { from: "1 Jul 2025", cost: "$52.00", charge: "$98", reason: "EBA increase" },
    { from: "1 Jul 2024", cost: "$49.50", charge: "$94", reason: "Annual review" },
  ],
  "Ruth Strauss": [
    { from: "1 Jan 2026", cost: "$34.00", charge: "$66", reason: "Year-3 apprentice step-up" },
    { from: "1 Jul 2025", cost: "$31.50", charge: "$62", reason: "Year-2 → progression" },
  ],
  "Tom Reed": [
    { from: "1 Jul 2025", cost: "$58.00", charge: "$112", reason: "EBA increase + LH allowance" },
    { from: "1 Jul 2024", cost: "$55.00", charge: "$105", reason: "Annual review" },
  ],
};

/* ── Quote builder lines — per-line cost + internal margin (admin-only).
   Surfaces on /v2/quotes/[quoteId]; margins are private. ────────────────────── */
window.BX.quoteLines = {
  "QTE-031": {
    summary: { sell: "$48,200", cost: "$36,150", marginVal: "$12,050", marginPct: "25.0%" },
    lines: [
      { item: "Ballroom GP & lighting rough-in", qty: "1 lot", sell: "$14,800", cost: "$11,100", margin: "25%" },
      { item: "Dimmable LED fit-off — 86 fittings", qty: "86 ea", sell: "$12,400", cost: "$9,920",  margin: "20%" },
      { item: "DB upgrade + sub-main", qty: "1 ea",  sell: "$9,600",  cost: "$6,720",  margin: "30%" },
      { item: "Data & AV containment", qty: "1 lot",  sell: "$5,900",  cost: "$4,425",  margin: "25%" },
      { item: "Test, commission & certify", qty: "1 lot", sell: "$3,200", cost: "$2,240", margin: "30%" },
      { item: "Site allowances + access", qty: "1 lot",  sell: "$2,300",  cost: "$1,745",  margin: "24%" },
    ],
  },
};

/* ── Job Builder cockpit — a self-contained DEMO job (fictional) so the builder
   reads clearly as "building a fresh job", independent of the live portfolio.
   Drives the rail readiness, each section canvas, the live Phil preview and the
   publish gate. ──────────────────────────────────────────────────────────────── */
window.BX.builder = {
  jobId: "P25-014",

  /* ── Job identity + pre-start (Overview · becomes the Phil header card) ── */
  overview: {
    name: "100 Arthur St", shortName: "100 Arthur St",
    ref: "P25-014", dwg: "P25-014-EL rev C",
    type: "Commercial fit-out — Level 1 + East Gym",
    client: "Richard Crookes Constructions", contact: "Dee Walsh", phone: "+61 412 660 049",
    address: "100 Arthur St, North Sydney NSW 2060",
    start: "8 Jun 2026", finish: "21 Aug 2026", days: 54, day: 14,
    induction: true, inductionVia: "Builder portal · HammerTech",
    siteHours: "6:30am–2:30pm · Mon–Fri",
    parking: "Loading dock B2 — 2 contractor bays, book the night before",
    safety: "Hard hat, hi-vis, glasses site-wide · live L1 switchboard until energise · asbestos register on the L1 ceiling void",
    philLevel: "Level 1 + East Gym",
    source: "Converted from won quote QTE-019", fromQuote: "QTE-019",
  },

  /* ── Scope intake — SOW lines read from the docs, each carrying a certainty
     state. NEVER auto-applied; confirm is a human act. ──────────────────────── */
  scope: {
    source: "SOW rev C · P25-014-EL rev C · RCP rev B · fire services rev A",
    docs: ["SOW rev C", "P25-014-EL rev C", "P25-014-RCP rev B", "P25-014-FIRE rev A"],
    items: [
      { id: "s1", ref: "§2.1", system: "power",  text: "Supply & install dedicated 20A circuit to East Gym ZIP unit", cert: "converted", drives: "1 task", plan: "EL rev C", proof: "Photo + circuit test" },
      { id: "s2", ref: "§2.2", system: "power",  text: "Power rough-in & fit-off to Level 1 GPO layout", cert: "confirmed", drives: "6 tasks", plan: "EL rev C" },
      { id: "s3", ref: "§2.4", system: "power",  text: "Terminate & energise sub-board SB-1 (Switchroom)", cert: "confirmed", drives: "2 tasks", plan: "SLD rev A", proof: "Torque tag + thermal" },
      { id: "s4", ref: "§3.0", system: "data",   text: "Unit 1 data — Cat6a to workstation outlets", cert: "review", drives: "3 tasks", note: "Outlet count not confirmed — RFI-014-01 raised, don't guess", plan: "EL rev C" },
      { id: "s5", ref: "§4.1", system: "lighting",text: "Fit RCP downlights to Level 1 corridor + East Gym", cert: "confirmed", drives: "4 tasks", plan: "RCP rev B", note: "Set out to reflected ceiling plan, not the EL" },
      { id: "s6", ref: "§5.0", system: "fire",   text: "Fire detection rough-in to Level 1", cert: "rfi", drives: "—", note: "Addressable vs conventional not confirmed — RFI-014-02. Raised, not guessed.", plan: "FIRE rev A" },
      { id: "s7", ref: "§5.2", system: "fire",   text: "Emergency & exit lighting + 90-min discharge test", cert: "confirmed", drives: "3 tasks", proof: "90-min discharge ITP" },
      { id: "s8", ref: "§6.1", system: "power",  text: "Make safe & remove redundant L1 GPOs and cabling", cert: "review", drives: "—", note: "Excluded on price but still owed on site — the disposal trap. Check before publish." },
      { id: "s9", ref: "§7.0", system: "power",  text: "Tenant metering at main switchboard", cert: "suggested", drives: "—", note: "Just read from SOW rev C — nobody has looked at it yet" },
      { id: "s10",ref: "§8.0", system: "data",   text: "CCTV containment — cabling only, hardware by others", cert: "ignored", drives: "—", note: "A/V by others; we run conduit only. Dismissed from our scope." },
    ],
  },

  /* ── Products / requirements extracted from the schedules ─────────────────── */
  products: {
    items: [
      { id: "p1", code: "ZIP-20", name: "ZIP HydroTap 20A unit", type: "Appliance circuit", area: "East Gym", system: "power", cert: "confirmed", ref: "Spec note 4" },
      { id: "p2", code: "RCP-DL", name: "RCP downlight 90mm — 4000K", type: "Luminaire", area: "L1 corridor + Gym", system: "lighting", cert: "confirmed", ref: "RCP rev B" },
      { id: "p3", code: "DAT-6", name: "Cat6a RJ45 outlet — workstation", type: "Data", area: "Unit 1", system: "data", cert: "review", ref: "Comms sched", note: "Count unconfirmed (RFI-014-01)" },
      { id: "p4", code: "FP-AD", name: "Fire panel — addressable", type: "Fire", area: "Switchroom", system: "fire", cert: "rfi", ref: "—", note: "Type unresolved — RFI-014-02; 5-week lead once confirmed" },
      { id: "p5", code: "EXIT", name: "Emergency / exit luminaire", type: "Emergency", area: "all", system: "fire", cert: "confirmed", ref: "§5.2" },
      { id: "p6", code: "MTR-2", name: "Tenant meter — Form 2 EM1200", type: "Metering", area: "Switchroom", system: "power", cert: "suggested", ref: "RFI-014-03 answer", note: "Builder confirmed type — not yet pulled into scope" },
    ],
  },

  /* ── Areas — a facet of every task; here the place-first view ──────────────── */
  areaGroups: [
    { id: "g-gym", name: "East Gym", areas: [
      { id: "a-gym", name: "East Gym", level: "GF", cert: "confirmed", roughIn: 5, fitOff: 6, systems: ["power","lighting"] } ] },
    { id: "g-l1", name: "Level 1", areas: [
      { id: "a-cor", name: "Level 1 corridor", level: "L1", cert: "confirmed", roughIn: 6, fitOff: 7, systems: ["lighting","fire","power"] },
      { id: "a-u1", name: "Unit 1", level: "L1", cert: "confirmed", roughIn: 5, fitOff: 4, systems: ["power","data"] },
      { id: "a-off", name: "Level 1 office", level: "L1", cert: "suggested", roughIn: 3, fitOff: 3, systems: ["power","data"], note: "Extracted from EL rev C — not confirmed as our scope" } ] },
    { id: "g-svc", name: "Services", areas: [
      { id: "a-sw", name: "Switchroom", level: "GF", cert: "confirmed", roughIn: 3, fitOff: 2, systems: ["power","fire"] } ] },
  ],

  /* ── Stages — each enabled stage carries a close GATE of conditions ───────── */
  stages: [
    { id: "st-pre", name: "Pre-start & set-up", enabled: true, gate: null },
    { id: "st-rough", name: "Rough-in", enabled: true, gate: {
      conditions: [
        { label: "All rough-in tasks complete", met: false, detail: "9 of 14 done" },
        { label: "Pre-close photos before ceilings shut", met: false, detail: "4 outstanding" },
        { label: "RCP set-out checked against rev B", met: true } ] } },
    { id: "st-fit", name: "Fit-off", enabled: true, gate: {
      conditions: [
        { label: "All fit-off tasks complete", met: false, detail: "blocked behind rough-in" },
        { label: "GPO + lighting fit photos captured", met: false } ] } },
    { id: "st-test", name: "Test & commission", enabled: true, gate: {
      conditions: [
        { label: "RCD trip-time ITP signed", met: false },
        { label: "Circuit test sheets complete", met: false },
        { label: "Test-and-tag entries recorded", met: false } ] } },
    { id: "st-hand", name: "Handover & QA", enabled: true, gate: {
      conditions: [
        { label: "Final-fix ITP signed", met: false },
        { label: "Emergency 90-min discharge passed", met: false },
        { label: "As-builts + cert uploaded", met: false },
        { label: "Builder sign-off", met: false } ] } },
    { id: "st-pack", name: "Pack-up", enabled: false, gate: null },
  ],

  /* ── Tasks — the operational spine. Each row is one task instance with its
     facets (area · stage · system · worker · proof) and a certainty state. ───── */
  tasks: [
    { id: "PWR-014-01", name: "Install dedicated 20A circuit", area: "East Gym", stage: "Rough-in", system: "power", worker: "An Bui", cert: "converted", vis: true, proof: 1, scopeRef: "§2.1", planRef: "EL rev C",
      instruction: "Run a dedicated 20A circuit from SB-1 to the East Gym ZIP unit position. Label at board and outlet.",
      steps: ["Confirm ZIP position against EL rev C", "Run 2.5mm² on its own 20A breaker", "Terminate at board, label both ends", "Photo the run before the ceiling closes"],
      evidence: [ { type: "Photo — run before ceiling close", required: true }, { type: "Circuit test result", required: true } ] },
    { id: "MSB-014-02", name: "Terminate sub-board SB-1", area: "Switchroom", stage: "Test & commission", system: "power", worker: "Kane Bell", cert: "confirmed", vis: true, proof: 3, scopeRef: "§2.4", planRef: "SLD rev A",
      instruction: "Terminate and label SB-1 to the single-line diagram. Torque to spec, thermal scan under load before sign-off.",
      steps: ["Land sub-main, torque to spec", "Terminate & label all final subs", "Thermal scan under load", "Torque-tag photo + test sheet"],
      evidence: [ { type: "Torque-tag photo", required: true }, { type: "Thermal scan", required: true }, { type: "Test sheet", required: true } ] },
    { id: "LGT-014-03", name: "Fit RCP downlights", area: "Level 1 corridor", stage: "Fit-off", system: "lighting", worker: "An Bui", cert: "confirmed", vis: true, proof: 1, scopeRef: "§4.1", planRef: "RCP rev B",
      instruction: "Set out and fit RCP downlights to the reflected ceiling plan rev B — NOT the EL. Confirm spacing before cutting.",
      evidence: [ { type: "Photo — completed run", required: true } ] },
    { id: "LGT-014-04", name: "Fit RCP downlights", area: "East Gym", stage: "Fit-off", system: "lighting", worker: null, cert: "confirmed", vis: true, proof: 1, scopeRef: "§4.1", planRef: "RCP rev B",
      instruction: "Fit RCP downlights to gym ceiling grid per RCP rev B." },
    { id: "PWR-014-05", name: "Power rough-in to L1 GPO layout", area: "Level 1 corridor", stage: "Rough-in", system: "power", worker: "Kane Bell", cert: "confirmed", vis: true, proof: 1, scopeRef: "§2.2", planRef: "EL rev C",
      instruction: "Rough in power to the L1 GPO layout on EL rev C." },
    { id: "PWR-014-06", name: "Fit GPOs to gym wall", area: "East Gym", stage: "Fit-off", system: "power", worker: "Jordan Pham", cert: "confirmed", vis: true, proof: 0, scopeRef: "§2.2", planRef: "EL rev C",
      instruction: "Fit and test GPOs to the gym wall set-out." },
    { id: "COM-014-07", name: "Pull Cat6a to Unit 1 outlets", area: "Unit 1", stage: "Rough-in", system: "data", worker: null, cert: "review", vis: true, proof: 1, scopeRef: "§3.0", planRef: "EL rev C",
      instruction: "Pull Cat6a to Unit 1 workstation outlets.", note: "Outlet count unconfirmed — don't pull until RFI-014-01 is answered.",
      evidence: [ { type: "Photo — outlet positions", required: true } ] },
    { id: "FIR-014-08", name: "Rough-in fire detection loop", area: "Level 1 corridor", stage: "Rough-in", system: "fire", worker: null, cert: "review", vis: false, proof: 0, scopeRef: "§5.0", planRef: "FIRE rev A",
      instruction: "Rough in the fire detection loop to L1.", note: "Held on RFI-014-02 — addressable vs conventional changes the cable. Not field-visible yet." },
    { id: "EME-014-09", name: "Emergency & exit light fit-off", area: "Level 1 corridor", stage: "Fit-off", system: "fire", worker: "An Bui", cert: "confirmed", vis: true, proof: 1, scopeRef: "§5.2", planRef: "EL rev C",
      instruction: "Fit emergency & exit luminaires to L1, ready for 90-min discharge." },
    { id: "TST-014-10", name: "Test & tag final circuits", area: "all areas", stage: "Test & commission", system: "power", worker: null, cert: "confirmed", vis: true, proof: 2, scopeRef: "§2.2", planRef: "SLD rev A",
      instruction: "Test and tag all final circuits; record RCD trip times." },
    { id: "DAT-014-11", name: "Data rack patch & label", area: "Unit 1", stage: "Fit-off", system: "data", worker: null, cert: "suggested", vis: false, proof: 0, scopeRef: "§3.0", planRef: "EL rev C",
      instruction: "Patch and label the Unit 1 data rack.", note: "Proposed from scope — not yet reviewed." },
    { id: "TSK-014-12", name: "Make good penetrations", area: null, stage: "Rough-in", system: null, worker: null, cert: "review", vis: false, proof: 0, scopeRef: "—", planRef: "—",
      instruction: null, note: "No area and no instruction — the field won't know WHERE or WHAT. Fix before publish." },
  ],

  /* ── Plans & documents — one current rev, re-ack on supersede ───────────────── */
  plans: [
    { id: "P25-014-EL", name: "Electrical services layout", rev: "C", current: true, date: "12 Jun", pages: 8, linked: 24 },
    { id: "P25-014-EL", name: "Electrical services layout", rev: "B", current: false, date: "28 May", pages: 8, linked: 0 },
    { id: "P25-014-RCP", name: "Reflected ceiling plan", rev: "B", current: true, date: "5 Jun", pages: 4, linked: 9 },
    { id: "P25-014-SLD", name: "Single line diagram", rev: "A", current: true, date: "20 May", pages: 2, linked: 5 },
    { id: "P25-014-FIRE", name: "Fire services layout", rev: "A", current: true, date: "20 May", pages: 3, linked: 0, note: "Held — RFI-014-02 open" },
  ],
  planAlert: { msg: "EL rev C supersedes rev B — 4 Level 1 tasks need re-ack", detail: "Kane Bell & An Bui acknowledged rev B · re-ack required before they continue" },

  /* ── Materials & equipment — planned → ordered → delivered, by stage ────────── */
  materials: {
    counts: { lines: 22, longLead: 1, scopeGap: 1 },
    alert: "Fire panel long-lead can't be ordered until RFI-014-02 is answered",
    rows: [
      { id: "m1", item: "Sub-board SB-1 — 24-way", stage: "Test & commission", status: "ordered", lead: "3 wk", value: "$1,640", risk: false },
      { id: "m2", item: "RCP downlights 90mm ×60", stage: "Fit-off", status: "ordered", lead: "2 wk", value: "$2,520", risk: false },
      { id: "m3", item: "Cat6a U/UTP 305m ×3", stage: "Rough-in", status: "delivered", lead: "stock", value: "$1,860", risk: false },
      { id: "m4", item: "ZIP HydroTap 20A unit", stage: "Fit-off", status: "planned", lead: "TBC", value: "—", risk: true, note: "Scope gap — confirmed (§2.1) but not on order" },
      { id: "m5", item: "Fire panel + detectors", stage: "Rough-in", status: "planned", lead: "5 wk", value: "—", risk: true, note: "Long-lead — blocked on RFI-014-02" },
      { id: "m6", item: "Emergency / exit luminaires ×18", stage: "Fit-off", status: "ordered", lead: "2 wk", value: "$1,980", risk: false },
    ],
  },

  /* ── Gear & site setup ────────────────────────────────────────────────────── */
  gear: {
    assigned: [
      { id: "GEAR-MFT-007", label: "Fluke 1663 multifunction tester", to: "Oskar Bühl", scope: "worker" },
      { id: "GEAR-CRT-204", label: "Cable certifier · DSX-5000", to: "Unit 1", scope: "area" },
      { id: "GEAR-TB-002", label: "Temp board 32A", to: "100 Arthur St", scope: "job" },
    ],
    needed: ["RCD test set (Test & commission)", "Temp lighting leads ×4", "L1 swipe + dock B2 booking"],
  },

  /* ── ITPs / QA — inspection & test points, hold/witness/record ───────────────── */
  itps: [
    { id: "ITP-01", name: "RCD trip-time test record", stage: "Test & commission", type: "record", status: "todo", area: "all areas" },
    { id: "ITP-02", name: "SB-1 termination — torque + thermal", stage: "Test & commission", type: "hold", status: "todo", area: "Switchroom" },
    { id: "ITP-03", name: "Emergency lighting 90-min discharge", stage: "Handover & QA", type: "witness", status: "todo", area: "Level 1 corridor" },
    { id: "ITP-04", name: "Final-fix lighting ITP", stage: "Fit-off", type: "record", status: "todo", area: "East Gym" },
  ],

  /* ── Risks & RFIs — unknowns are raised as questions, never guessed ──────────── */
  rfis: [
    { id: "RFI-014-01", system: "data", q: "Unit 1: 4 or 6 data outlets per workstation?", raisedBy: "An Bui", age: "2d", status: "open", links: "§3.0 · COM-014-07", blocks: false },
    { id: "RFI-014-02", system: "fire", q: "Level 1 fire: addressable or conventional panel?", raisedBy: "Oskar Bühl", age: "4d", status: "open", links: "§5.0 · FIR-014-08 · fire panel order", blocks: true },
    { id: "RFI-014-03", system: "power", q: "Tenant meter type at main board?", raisedBy: "Dee Walsh", age: "8d", status: "answered", links: "§7.0", answer: "Form 2, EM1200 — confirmed by builder" },
  ],
  risks: [
    { id: "rk1", text: "Live L1 switchboard during fit-off", sev: "high", control: "Isolation permit + lock-out/tag-out before any board work" },
    { id: "rk2", text: "Asbestos register flags the L1 ceiling void", sev: "high", control: "Clearance cert sighted before any ceiling access" },
    { id: "rk3", text: "Energise date depends on Ausgrid metering", sev: "med", control: "Booked — confirm one week out" },
  ],

  /* ── Crew — pre-start readiness per worker (drives the start gate) ───────────── */
  crew: [
    { id: "c1", name: "Oskar Bühl", role: "Leading hand", induction: "ok", licences: "ok" },
    { id: "c2", name: "An Bui", role: "Electrician", induction: "ok", licences: "ok" },
    { id: "c3", name: "Kane Bell", role: "Electrician", induction: "missing", licences: "ok" },
    { id: "c4", name: "Jordan Pham", role: "Apprentice", induction: "ok", licences: "na" },
    { id: "c5", name: "Sam Rai", role: "Electrician", induction: "ok", licences: "expiring" },
  ],

  /* ── Field lint — confusing-for-site issues flagged on the Phil preview ──────── */
  fieldLint: [
    { sev: "err", msg: "1 task has no area or instruction", detail: "“Make good penetrations” — the crew won't know where or what. Won't publish." },
    { sev: "warn", msg: "2 field-visible tasks have no required proof", detail: "Fit GPOs to gym wall · Fit RCP downlights (gym) — nothing to capture before sign-off." },
    { sev: "warn", msg: "EL rev C re-ack outstanding for 2 crew", detail: "Kane Bell & An Bui are still on rev B." },
    { sev: "info", msg: "3 items still Suggested / Needs review", detail: "They stay office-only until confirmed — the field won't see them." },
  ],
};
