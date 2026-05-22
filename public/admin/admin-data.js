/* BuhlOS admin — mock data layer.
 *
 * Purpose: when the real API returns empty or no data is loaded yet
 * (first-run, fresh demo install, an account with no jobs), the admin
 * shell still demonstrates how the modules look populated. Real API
 * data overrides this — the shapes match what the API would return.
 *
 * Used by:
 *   - operations.html (Command Centre / Jobs / Job Builder / ITP /
 *     Plans / Materials / Assets / Variations renderers)
 *   - admin sidebar count badges
 *
 * Realism note: every job, area, ITP and variation here is shaped on
 * actual electrical-contractor scope — rough-in, fit-off, commissioning,
 * GPO/lighting/switchboard sub-stages. Not generic SaaS filler. Update
 * the data here when the field finds something that should be a default.
 */

(function (root) {
  'use strict';

  const today = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  const daysAgo = n => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };
  const hoursAgo = n => { const d = new Date(today); d.setHours(d.getHours() - n); return d; };

  // ── Jobs ──────────────────────────────────────────────────────────
  // 5 live job-shapes that demonstrate the full spectrum: on-track,
  // at-risk, behind, fitoff-stage, just-started.
  const jobs = [
    {
      id: 'BIR-IV3232', name: 'Birdwood IV3232',
      address: '19-23 Birdwood Ave, Lane Cove',
      builder: 'Hutchinson Builders', client: 'Hutchinson Builders',
      stage: 'Rough-in (lvl 2)', status: 'active', health: 'risk',
      quotedHours: 1880, actualHours: 1402,
      contractValue: 412000,
      areaGroups: ['Townhouses (7)', 'Units (15)'],
      crew: ['jake.smith', 'matt.cohen', 'pete.davis', 'sam.lee'],
      startDate: iso(daysAgo(74)), createdAt: daysAgo(74).toISOString(),
      lastFieldUpdate: hoursAgo(2).toISOString(),
    },
    {
      id: 'ART-WST', name: 'Arthur St Warehouse',
      address: '88 Arthur St, Bondi Junction',
      builder: 'ICON Construction', client: 'Westfield Group',
      stage: 'Commissioning', status: 'active', health: 'ok',
      quotedHours: 920, actualHours: 887,
      contractValue: 198000,
      areaGroups: ['Ground floor', 'Mezzanine'],
      crew: ['jake.smith', 'matt.cohen'],
      startDate: iso(daysAgo(120)), createdAt: daysAgo(120).toISOString(),
      lastFieldUpdate: hoursAgo(6).toISOString(),
    },
    {
      id: 'PAR-CFO', name: 'Parramatta Commercial Fitout',
      address: '12 Macquarie St, Parramatta',
      builder: 'Built NSW', client: 'PwC Australia',
      stage: 'Fit-off', status: 'active', health: 'over',
      quotedHours: 1240, actualHours: 1391,
      contractValue: 305000,
      areaGroups: ['Level 4 — Open plan', 'Level 4 — Boardrooms'],
      crew: ['matt.cohen', 'pete.davis'],
      startDate: iso(daysAgo(58)), createdAt: daysAgo(58).toISOString(),
      lastFieldUpdate: hoursAgo(1).toISOString(),
    },
    {
      id: 'SPS-LHD', name: 'St Peters Logistics Hub',
      address: '4 Burrows Rd, St Peters',
      builder: 'Multiplex', client: 'Goodman Group',
      stage: 'Switchboard install', status: 'active', health: 'ok',
      quotedHours: 2150, actualHours: 612,
      contractValue: 488000,
      areaGroups: ['Substation', 'Distribution boards (12)'],
      crew: ['sam.lee', 'jake.smith', 'tom.kerr'],
      startDate: iso(daysAgo(31)), createdAt: daysAgo(31).toISOString(),
      lastFieldUpdate: hoursAgo(12).toISOString(),
    },
    {
      id: 'NWH-RES', name: 'North Wahroonga Residence',
      address: '23 Burns Rd, Wahroonga',
      builder: 'Stannic Homes', client: 'Private — Singh',
      stage: 'Rough-in', status: 'active', health: 'ok',
      quotedHours: 480, actualHours: 162,
      contractValue: 92000,
      areaGroups: ['Ground floor', 'Upper floor'],
      crew: ['pete.davis'],
      startDate: iso(daysAgo(11)), createdAt: daysAgo(11).toISOString(),
      lastFieldUpdate: hoursAgo(4).toISOString(),
    },
  ];

  // ── Workers ───────────────────────────────────────────────────────
  const workers = [
    { id: 'jake.smith', username: 'jake.smith', name: 'Jake Smith', role: 'leadingHand', hourlyRate: 78, currentJob: 'BIR-IV3232' },
    { id: 'matt.cohen', username: 'matt.cohen', name: 'Matt Cohen', role: 'tradie', hourlyRate: 62, currentJob: 'PAR-CFO' },
    { id: 'pete.davis', username: 'pete.davis', name: 'Pete Davis', role: 'tradie', hourlyRate: 62, currentJob: 'NWH-RES' },
    { id: 'sam.lee',    username: 'sam.lee',    name: 'Sam Lee',    role: 'tradie', hourlyRate: 58, currentJob: 'SPS-LHD' },
    { id: 'tom.kerr',   username: 'tom.kerr',   name: 'Tom Kerr',   role: 'apprentice', hourlyRate: 38, currentJob: 'SPS-LHD' },
    { id: 'liam.brown', username: 'liam.brown', name: 'Liam Brown', role: 'apprentice', hourlyRate: 38, currentJob: 'BIR-IV3232' },
  ];

  // ── Timesheets (hoursByJob shape) ─────────────────────────────────
  // Hours pipeline status values: submitted (pending) / approved / rejected.
  // Standard day = 7.6h (7h36m one-tap from Phil).
  function ts(workerId, hours, status, daysAgoN, jobName) {
    const d = daysAgo(daysAgoN);
    return {
      id: 'ts-' + workerId + '-' + iso(d),
      userId: workerId, username: workerId,
      workerName: (workers.find(w => w.id === workerId) || {}).name || workerId,
      date: iso(d),
      submittedAt: d.toISOString(),
      hours, type: hours > 7.6 ? 'overtime' : 'ordinary',
      status,
      ...(status === 'approved' ? { approvedAt: hoursAgo(2).toISOString(), approvedBy: 'admin' } : {}),
      ...(status === 'rejected' ? { rejectedAt: hoursAgo(1).toISOString(), rejectedBy: 'admin', rejectReason: 'Hours don\'t match site sign-in' } : {}),
    };
  }
  const hoursByJob = {
    'BIR-IV3232': { entries: [
      ts('jake.smith',  7.6, 'submitted', 0),
      ts('matt.cohen',  7.6, 'submitted', 0),
      ts('liam.brown',  7.6, 'submitted', 0),
      ts('jake.smith',  8.5, 'submitted', 1),
      ts('matt.cohen',  7.6, 'approved',  1),
      ts('jake.smith',  7.6, 'approved',  2),
      ts('matt.cohen',  9.0, 'rejected',  2),
      ts('jake.smith',  7.6, 'approved',  3),
      ts('liam.brown',  7.6, 'approved',  3),
    ]},
    'ART-WST':    { entries: [
      ts('jake.smith',  7.6, 'approved',  0),
      ts('matt.cohen',  4.0, 'submitted', 0),
    ]},
    'PAR-CFO':    { entries: [
      ts('matt.cohen',  7.6, 'submitted', 0),
      ts('pete.davis',  7.6, 'submitted', 0),
      ts('matt.cohen',  10.0,'submitted', 1),
      ts('pete.davis',  7.6, 'approved',  1),
      ts('matt.cohen',  7.6, 'approved',  2),
      ts('pete.davis',  7.6, 'approved',  2),
    ]},
    'SPS-LHD':    { entries: [
      ts('sam.lee',     7.6, 'approved',  0),
      ts('tom.kerr',    7.6, 'approved',  0),
      ts('jake.smith',  4.0, 'submitted', 0),
    ]},
    'NWH-RES':    { entries: [
      ts('pete.davis',  7.6, 'approved',  0),
      ts('pete.davis',  7.6, 'approved',  1),
    ]},
  };

  // ── Materials (materialsByJob shape) ──────────────────────────────
  const materialsByJob = {
    'BIR-IV3232': {
      materials: [
        { id: 'm1',  name: '20A RCBO — 1P+N',      quantity: 84, unit: 'ea', status: 'pending', urgency: 'urgent', requestedBy: 'jake.smith', stage: 'Rough-in', wholesalerName: 'CEF' },
        { id: 'm2',  name: '4mm² TPS cable',        quantity: 5,  unit: 'reel', status: 'ordered', urgency: 'normal', requestedBy: 'matt.cohen', stage: 'Rough-in', wholesalerName: 'Lawrence & Hanson' },
        { id: 'm3',  name: 'Conduit 25mm grey',     quantity: 50, unit: 'm',  status: 'delivered', urgency: 'normal', requestedBy: 'jake.smith', stage: 'Rough-in', wholesalerName: 'Reece' },
      ],
      invoices: [
        { id: 'inv1', fileName: 'CEF-2026-04-12.pdf', amount: 4820, status: 'pending_review', uploadedAt: hoursAgo(20).toISOString() },
      ],
    },
    'ART-WST': {
      materials: [
        { id: 'm4', name: 'LED panel 600x600 4000K', quantity: 28, unit: 'ea', status: 'delivered', urgency: 'normal', requestedBy: 'jake.smith', stage: 'Fit-off', wholesalerName: 'Sparky Direct' },
      ],
      invoices: [],
    },
    'PAR-CFO': {
      materials: [
        { id: 'm5', name: 'GPO double — white',     quantity: 64, unit: 'ea', status: 'needed', urgency: 'urgent', requestedBy: 'matt.cohen', stage: 'Fit-off', wholesalerName: 'CEF' },
        { id: 'm6', name: 'Boardroom dimmers DALI', quantity: 6,  unit: 'ea', status: 'pending', urgency: 'normal', requestedBy: 'pete.davis', stage: 'Fit-off', wholesalerName: 'Schneider' },
      ],
      invoices: [
        { id: 'inv2', fileName: 'Schneider-PO-441.pdf', amount: 2310, status: 'needs_info', uploadedAt: hoursAgo(48).toISOString() },
      ],
    },
    'SPS-LHD': {
      materials: [
        { id: 'm7', name: '630A ACB — 4P',    quantity: 1, unit: 'ea', status: 'ordered',  urgency: 'urgent', requestedBy: 'sam.lee',    stage: 'Switchboard install', wholesalerName: 'NHP' },
        { id: 'm8', name: 'Earth strap 70mm²',quantity: 18,unit: 'm',  status: 'delivered',urgency: 'normal', requestedBy: 'sam.lee',    stage: 'Switchboard install', wholesalerName: 'NHP' },
      ],
      invoices: [],
    },
    'NWH-RES': {
      materials: [],
      invoices: [],
    },
  };

  // ── Assets (assetsByJob shape — overdue gear surfacing) ───────────
  const assetsByJob = {
    'BIR-IV3232': { assets: [
      { id: 'A-001', name: 'Hilti TE 6-A36', kind: 'tool',     currentHolderId: 'jake.smith', expectedReturn: iso(daysAgo(3)) },
      { id: 'A-002', name: 'Megger MFT1741',  kind: 'tester',  currentHolderId: 'jake.smith', expectedReturn: iso(daysAgo(0)), calibrationDue: iso(daysAgo(-25)) },
    ]},
    'PAR-CFO': { assets: [
      { id: 'A-014', name: 'Fluke 1664 FC',    kind: 'tester', currentHolderId: 'matt.cohen', expectedReturn: iso(daysAgo(-10)), calibrationDue: iso(daysAgo(-180)) },
    ]},
    'SPS-LHD': { assets: [
      { id: 'A-022', name: 'EWP scissor lift 19ft', kind: 'plant', currentHolderId: 'sam.lee',   expectedReturn: iso(daysAgo(-3)) },
      { id: 'A-007', name: 'Cable jack 2T',         kind: 'tool',  currentHolderId: 'tom.kerr',  expectedReturn: iso(daysAgo(7)) },
    ]},
  };

  // ── ITPs (one per job, with checkpoints) ──────────────────────────
  // Status values: complete / evidence-missing / pending / blocked.
  const itps = [
    {
      id: 'ITP-BIR-RI', jobId: 'BIR-IV3232', stage: 'Rough-in', title: 'Rough-in ITP — lvl 2',
      checkpoints: [
        { id: 'cp1', name: 'GPO box positions verified to plan', status: 'complete',          photoCount: 12, reviewer: 'jake.smith', reviewedAt: hoursAgo(48).toISOString() },
        { id: 'cp2', name: 'Light points to set-out',            status: 'complete',          photoCount: 18, reviewer: 'jake.smith', reviewedAt: hoursAgo(40).toISOString() },
        { id: 'cp3', name: 'Switchboard penetrations sealed',    status: 'evidence-missing',  photoCount: 0,  reviewer: null, blocked: true },
        { id: 'cp4', name: 'Cable supports per AS3000',          status: 'pending',           photoCount: 4,  reviewer: null },
      ],
    },
    {
      id: 'ITP-ART-COM', jobId: 'ART-WST', stage: 'Commissioning', title: 'Commissioning ITP',
      checkpoints: [
        { id: 'cp1', name: 'Insulation resistance ≥1MΩ',         status: 'complete',          photoCount: 6,  reviewer: 'jake.smith', reviewedAt: hoursAgo(8).toISOString() },
        { id: 'cp2', name: 'RCD operation under load',           status: 'complete',          photoCount: 4,  reviewer: 'matt.cohen', reviewedAt: hoursAgo(8).toISOString() },
        { id: 'cp3', name: 'Earth fault loop impedance',         status: 'pending',           photoCount: 2,  reviewer: null },
      ],
    },
    {
      id: 'ITP-PAR-FO', jobId: 'PAR-CFO', stage: 'Fit-off', title: 'Fit-off ITP — Level 4',
      checkpoints: [
        { id: 'cp1', name: 'GPO terminations torqued',           status: 'evidence-missing',  photoCount: 0,  reviewer: null, blocked: true },
        { id: 'cp2', name: 'Lighting circuit balance',           status: 'pending',           photoCount: 1,  reviewer: null },
        { id: 'cp3', name: 'Boardroom DALI commissioning',       status: 'pending',           photoCount: 0,  reviewer: null },
      ],
    },
  ];

  // ── Plans (revision control) ──────────────────────────────────────
  // Each plan can be linked to the whole job, or scoped to specific areas /
  // stages. type ∈ plan / spec / schedule / photo / certificate / other.
  // philVisible reflects whether the field crew can see this document; the
  // toggle persists locally for now (no /api/plans backend yet).
  const plans = [
    { id: 'P-BIR-E01', jobId: 'BIR-IV3232', name: 'Power layout',         drawingNumber: 'E01', type: 'plan',     revision: 'C', publishedRevision: 'C', publishedAt: daysAgo(12).toISOString(), supersededWarning: false, acknowledgedBy: ['jake.smith', 'matt.cohen'], linkedAreas: ['Townhouses (7)'], linkedStages: ['Rough-in', 'Fit-off'], philVisible: true },
    { id: 'P-BIR-E02', jobId: 'BIR-IV3232', name: 'Lighting layout',      drawingNumber: 'E02', type: 'plan',     revision: 'D', publishedRevision: 'C', publishedAt: daysAgo(20).toISOString(), supersededWarning: true,  acknowledgedBy: ['jake.smith'], linkedAreas: ['Townhouses (7)', 'Units (15)'], linkedStages: ['Rough-in'], philVisible: true },
    { id: 'P-BIR-SC1', jobId: 'BIR-IV3232', name: 'Switchboard schedule', drawingNumber: 'SC01', type: 'schedule', revision: 'A', publishedRevision: 'A', publishedAt: daysAgo(40).toISOString(), supersededWarning: false, acknowledgedBy: ['jake.smith', 'matt.cohen', 'liam.brown'], linkedAreas: [], linkedStages: [], philVisible: true },
    { id: 'P-ART-E01', jobId: 'ART-WST',    name: 'Switchboard schedule', drawingNumber: 'E01', type: 'schedule', revision: 'B', publishedRevision: 'B', publishedAt: daysAgo(45).toISOString(), supersededWarning: false, acknowledgedBy: ['jake.smith', 'matt.cohen'], linkedAreas: ['Ground floor'], linkedStages: ['Switchboard install'], philVisible: true },
    { id: 'P-PAR-E01', jobId: 'PAR-CFO',    name: 'Fit-off',              drawingNumber: 'E01', type: 'plan',     revision: 'A', publishedRevision: null,   publishedAt: null, supersededWarning: false, acknowledgedBy: [], linkedAreas: ['Level 4 — Open plan'], linkedStages: ['Fit-off'], philVisible: false },
    { id: 'P-PAR-E02', jobId: 'PAR-CFO',    name: 'Comms layout',         drawingNumber: 'E02', type: 'plan',     revision: 'B', publishedRevision: 'B', publishedAt: daysAgo(7).toISOString(), supersededWarning: false, acknowledgedBy: ['matt.cohen'], linkedAreas: ['Level 4 — Boardrooms'], linkedStages: ['Fit-off'], philVisible: true },
    { id: 'P-SPS-COC', jobId: 'SPS-LHD',    name: 'CoC — main switchboard', drawingNumber: 'COC-001', type: 'certificate', revision: 'A', publishedRevision: null, publishedAt: null, supersededWarning: false, acknowledgedBy: [], linkedAreas: ['Substation'], linkedStages: ['Commissioning'], philVisible: false },
  ];

  // ── Variations ────────────────────────────────────────────────────
  // Statuses: draft / priced / submitted / approved / rejected / invoiced.
  // source ∈ field / admin / builder / plan_change — where the change came from.
  // variationNumber is the human reference (per-job sequence).
  const variations = [
    { id: 'V-BIR-001', variationNumber: 'BIR-V001', jobId: 'BIR-IV3232', title: 'Extra GPO bank for unit 14', status: 'priced',    source: 'builder',     raisedBy: 'jake.smith', raisedAt: daysAgo(4).toISOString(),  priceImpact: 1840,  hoursImpact: 12, photoCount: 3, description: 'Tenant requested an extra dual GPO bank in study nook — not in plan rev C.', builderRef: 'HBI-RFI-188', linkedArea: 'Townhouses (7)', linkedStage: 'Fit-off' },
    { id: 'V-BIR-002', variationNumber: 'BIR-V002', jobId: 'BIR-IV3232', title: 'Switchboard upsize',         status: 'draft',     source: 'field',       raisedBy: 'matt.cohen', raisedAt: daysAgo(1).toISOString(),  priceImpact: 0,     hoursImpact: 0,  photoCount: 1, description: 'Load calc came back over — needs SB upsize from 200A to 250A.',                builderRef: '',          linkedArea: 'Units (15)',       linkedStage: 'Switchboard install' },
    { id: 'V-PAR-001', variationNumber: 'PAR-V001', jobId: 'PAR-CFO',    title: 'Boardroom dimming upgrade',  status: 'submitted', source: 'builder',     raisedBy: 'pete.davis', raisedAt: daysAgo(8).toISOString(),  priceImpact: 4200,  hoursImpact: 18, photoCount: 5, description: 'Client requested DALI dim upgrade post-fitoff start.',                          builderRef: 'BLT-PR-441', linkedArea: 'Level 4 — Boardrooms', linkedStage: 'Fit-off' },
    { id: 'V-PAR-002', variationNumber: 'PAR-V002', jobId: 'PAR-CFO',    title: 'Open ceiling extra runs',    status: 'approved',  source: 'plan_change', raisedBy: 'matt.cohen', raisedAt: daysAgo(14).toISOString(), priceImpact: 2700,  hoursImpact: 14, photoCount: 4, description: 'Open-ceiling design — extra cable runs required for tidy presentation.',        builderRef: 'BLT-VAR-12', linkedArea: 'Level 4 — Open plan',  linkedStage: 'Rough-in' },
    { id: 'V-PAR-003', variationNumber: 'PAR-V003', jobId: 'PAR-CFO',    title: 'Switchroom move',            status: 'invoiced',  source: 'admin',       raisedBy: 'admin',      raisedAt: daysAgo(40).toISOString(), priceImpact: 8800,  hoursImpact: 42, photoCount: 6, description: 'Switchroom relocated to suit revised tenancy plan — invoiced last month.',     builderRef: 'BLT-VAR-09', linkedArea: 'Level 4 — Open plan',  linkedStage: 'Rough-in' },
    { id: 'V-SPS-001', variationNumber: 'SPS-V001', jobId: 'SPS-LHD',    title: 'Earthing grid extension',    status: 'rejected',  source: 'field',       raisedBy: 'sam.lee',    raisedAt: daysAgo(6).toISOString(),  priceImpact: 0,     hoursImpact: 0,  photoCount: 2, description: 'Builder declined — handled in main contract.', rejectReason: 'Out of scope, declined by builder.', builderRef: '', linkedArea: 'Substation', linkedStage: 'Site prep' },
  ];

  // ── Job Builder templates ─────────────────────────────────────────
  // Realistic stage/area templates the Job Builder can offer.
  const jobBuilderTemplates = {
    'commercial-fitout': {
      label: 'Commercial Fit-out',
      stages: [
        { id: 's-roughin', name: 'Rough-in',   areas: [{ id: 'a-os', name: 'Open spaces' }, { id: 'a-mr', name: 'Meeting rooms' }], requiredPhotos: 3, requiredNotes: 1, itpRequired: true },
        { id: 's-fitoff',  name: 'Fit-off',    areas: [{ id: 'a-os', name: 'Open spaces' }, { id: 'a-mr', name: 'Meeting rooms' }, { id: 'a-cmt', name: 'Comms room' }], requiredPhotos: 2, requiredNotes: 1, itpRequired: true },
        { id: 's-comm',    name: 'Commissioning', areas: [{ id: 'a-all', name: 'All circuits' }], requiredPhotos: 4, requiredNotes: 2, itpRequired: true },
        { id: 's-hand',    name: 'Handover',   areas: [{ id: 'a-hand', name: 'Handover pack' }], requiredPhotos: 1, requiredNotes: 1, itpRequired: false },
      ],
    },
    'residential-new': {
      label: 'New Residential',
      stages: [
        { id: 's-roughin', name: 'Rough-in',   areas: [{ id: 'a-gf', name: 'Ground floor' }, { id: 'a-up', name: 'Upper floor' }], requiredPhotos: 2, requiredNotes: 1, itpRequired: false },
        { id: 's-fitoff',  name: 'Fit-off',    areas: [{ id: 'a-gf', name: 'Ground floor' }, { id: 'a-up', name: 'Upper floor' }], requiredPhotos: 2, requiredNotes: 1, itpRequired: false },
        { id: 's-comm',    name: 'Commissioning', areas: [{ id: 'a-all', name: 'Whole house' }], requiredPhotos: 2, requiredNotes: 1, itpRequired: true },
      ],
    },
    'industrial-switchboard': {
      label: 'Industrial — Switchboard',
      stages: [
        { id: 's-prep', name: 'Site prep',     areas: [{ id: 'a-sub', name: 'Substation' }, { id: 'a-mcc', name: 'MCC room' }], requiredPhotos: 4, requiredNotes: 2, itpRequired: true },
        { id: 's-sb',   name: 'Switchboard install', areas: [{ id: 'a-main', name: 'Main switchboard' }, { id: 'a-dist', name: 'Distribution boards' }], requiredPhotos: 6, requiredNotes: 3, itpRequired: true },
        { id: 's-comm', name: 'Commissioning', areas: [{ id: 'a-all', name: 'All circuits' }], requiredPhotos: 8, requiredNotes: 4, itpRequired: true },
      ],
    },
  };

  // ── Recent Phil activity (for Command Centre) ─────────────────────
  const recentActivity = [
    { id: 'act-1', kind: 'timesheet.submitted',  jobId: 'BIR-IV3232', worker: 'jake.smith',  at: hoursAgo(0.4).toISOString(),  text: 'Jake submitted 7.6h on Birdwood' },
    { id: 'act-2', kind: 'variation.raised',     jobId: 'BIR-IV3232', worker: 'matt.cohen',  at: hoursAgo(1.2).toISOString(),  text: 'Matt raised variation: Switchboard upsize' },
    { id: 'act-3', kind: 'material.requested',   jobId: 'PAR-CFO',    worker: 'matt.cohen',  at: hoursAgo(2.1).toISOString(),  text: 'Matt requested 64× GPO double — Parramatta' },
    { id: 'act-4', kind: 'itp.evidence-added',   jobId: 'BIR-IV3232', worker: 'jake.smith',  at: hoursAgo(3.6).toISOString(),  text: 'Jake added 4 photos to Cable supports ITP' },
    { id: 'act-5', kind: 'photo.uploaded',       jobId: 'SPS-LHD',    worker: 'sam.lee',     at: hoursAgo(4.0).toISOString(),  text: 'Sam uploaded 8 photos to Switchboard install' },
    { id: 'act-6', kind: 'plan.published',       jobId: 'PAR-CFO',    worker: 'admin',       at: hoursAgo(8.2).toISOString(),  text: 'Office published E02 Rev B to Parramatta' },
    { id: 'act-7', kind: 'timesheet.approved',   jobId: 'ART-WST',    worker: 'admin',       at: hoursAgo(10.5).toISOString(), text: 'Office approved Matt’s 7.6h on Arthur St' },
  ];

  // ── Export ────────────────────────────────────────────────────────
  root.BUHLOS_MOCK = {
    jobs, workers, hoursByJob, materialsByJob, assetsByJob,
    itps, plans, variations,
    jobBuilderTemplates,
    recentActivity,
    // Helpers exposed so renderers can format consistently
    helpers: {
      workerName(id) { const w = workers.find(x => x.id === id); return w ? w.name : id; },
      jobName(id)    { const j = jobs.find(x => x.id === id);    return j ? j.name : id; },
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
