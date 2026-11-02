// Simple mobile ITP builder (#912, lean-reset step 6; redesigned per the
// 2026-11-02 developer handoff) — the field's minimum honest QA artifact:
// start an ITP on the phone, photograph it area by area, make one or more
// plain PDFs, send them to the office / by email / save them to the phone.
// No templates, no sign-off workflow — the heavy office ITP system (`itp`
// flag) is a separate, hidden feature.
//
// Storage split (product-owner directive 2026-07-18):
//   metadata → Supabase (api/_lib/itp-simple-store; the tables ARE the store)
//   binaries → Vercel Blob under jobs/<jobId>/itp-simple/ (photos + PDFs)
//
// Actions (all ?jobId=X scoped; field-authed like api/tags.js):
//   GET                                   → { job, reports: [...], walkthroughSeen, officeEmailSet }
//   GET    ?id=R                          → { report, pdfs, sends, recentNames, emailSuggestions, officeEmail }
//   POST         body {title}             → create report
//   PUT          body {id, title}         → rename report
//   DELETE       body {id}                → soft-delete report
//   POST   ?action=area   {reportId,name} → add area
//   PUT    ?action=area   {id, name}      → rename area
//   DELETE ?action=area   {id}            → delete area (+ its photo rows)
//   POST   ?action=photo  {areaId, dataUrl, caption?} → upload + attach
//   PUT    ?action=photo  {id, caption}   → caption a photo
//   DELETE ?action=photo  {id}            → delete photo row
//   POST   ?action=pdf    {reportId, areaIds?, name?} → make a PDF → { pdf }
//   POST   ?action=pdf    {pdfId}         → make it again (same areas + name, file replaced)
//   PUT    ?action=pdf    {id, name}      → rename (header + file name re-rendered from its snapshot)
//   POST   ?action=send   {pdfId, to: 'office'|'email', email?, note?} → email the PDF → { send, pdf }
//   PUT    ?action=walkthrough            → mark the first-open walkthrough seen for this person
//
// "Sent" means the mail service accepted the message — never delivered or
// read (P7). A stale PDF is made again before it goes.
//
// Flag-dark behind `itp_simple` (viewer-aware gate → owner preview works;
// everyone else sees 404 — #760 no-trace layer for APIs).

const { put } = require('@vercel/blob');
const { readBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { getSetting } = require('./_lib/feature-settings');
const { getDb } = require('./_lib/supabase-db');
const store = require('./_lib/itp-simple-store');
const model = require('./_lib/itp-simple-model');
const { composeItpPdf } = require('./_lib/itp-simple-pdf');
const { renderItpEmail } = require('./_lib/itp-simple-email');
const { isEmailConfigured, sendEmail } = require('./_lib/email');

const MAX_PHOTO_BYTES = 8 * 1024 * 1024; // matches the tag-photo cap
const MAX_PDF_PHOTOS = 120; // serverless memory/time guard (maxDuration 60)
// Above this the email carries a download link instead of the file.
const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
const DEFAULT_FROM = 'BuhlOS Reports <reports@buhlos.com>';

function cleanName(v, max) {
  const s = String(v == null ? '' : v).trim();
  return s.length >= 1 && s.length <= max ? s : null;
}

async function jobMeta(jobId) {
  const data = await readBlob('jobs.json', { jobs: [] });
  const job = (data.jobs || []).find((j) => j.id === jobId);
  const areaNames = [];
  for (const g of (job && job.areaGroups) || []) {
    for (const a of g.areas || []) if (a && a.name) areaNames.push(String(a.name));
  }
  return { id: jobId, name: (job && job.name) || jobId, areaNames };
}

function sydneyLabel(d, withTime) {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney', day: 'numeric', month: 'short', year: 'numeric',
    ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
  }).format(d);
}

function safeFileName(name) {
  const s = String(name || 'ITP').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
  return (s || 'ITP').slice(0, 80);
}

async function uploadPhoto(jobId, dataUrl) {
  const base64 = String(dataUrl).split(',')[1];
  if (!base64) return { error: 'invalid dataUrl' };
  const mime = (String(dataUrl).match(/data:([^;]+)/) || [, 'image/jpeg'])[1];
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > MAX_PHOTO_BYTES) return { error: 'photo too large (max 8 MB)' };
  const photoId = Date.now() + '_' + Math.random().toString(36).slice(2);
  const blob = await put(`jobs/${jobId}/itp-simple/${photoId}.jpg`, buf, {
    access: 'public',
    contentType: mime,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  return { url: blob.url, pathname: blob.pathname };
}

/** Fetch photo bytes from Blob; a failed fetch becomes null and renders as
 *  an honest "couldn't be embedded" box instead of a silent drop (P7). */
async function fetchPhotoBytes(urls) {
  const bytesByUrl = new Map();
  await Promise.all([...new Set(urls)].map(async (url) => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(String(r.status));
      bytesByUrl.set(url, new Uint8Array(await r.arrayBuffer()));
    } catch {
      bytesByUrl.set(url, null);
    }
  }));
  return bytesByUrl;
}

/** Render + store one PDF file from a snapshot. Pure of the DB. */
async function renderPdfFile({ jobId, report, name, snapshot, totalAreaCount, user }) {
  const job = await jobMeta(jobId);
  const bytesByUrl = await fetchPhotoBytes(snapshot.areas.flatMap((a) => a.photos.map((p) => p.url)));
  const areaNames = snapshot.areas.map((a) => a.name).join(', ');
  const areaSummary = snapshot.areas.length < totalAreaCount
    ? `${areaNames} (${snapshot.areas.length} of ${totalAreaCount})`
    : areaNames;
  const pdfBytes = await composeItpPdf({
    name,
    title: report.title,
    jobName: job.name,
    jobLegacyId: jobId,
    authorName: user.name || user.username || '',
    generatedAtLabel: sydneyLabel(new Date(), true),
    areaSummary,
    areas: snapshot.areas.map((a) => ({
      name: a.name,
      photos: a.photos.map((p) => ({ bytes: bytesByUrl.get(p.url) || null, caption: p.caption })),
    })),
  });
  const blob = await put(
    `jobs/${jobId}/itp-simple/${report.id}/${safeFileName(name)}-${Date.now()}.pdf`,
    Buffer.from(pdfBytes),
    { access: 'public', contentType: 'application/pdf', token: process.env.BLOB_READ_WRITE_TOKEN },
  );
  return { url: blob.url, pathname: blob.pathname, byteSize: pdfBytes.length };
}

function withStale(pdf, report) {
  return { ...pdf, stale: pdf.contentKey !== model.liveContentKey(report, pdf.areaIds) };
}

function photoCapError(snapshot) {
  const total = model.countPhotos(snapshot.areas);
  if (total > MAX_PDF_PHOTOS) {
    const big = snapshot.areas.find((a) => a.photos.length > MAX_PDF_PHOTOS);
    return big
      ? `${big.name} has ${big.photos.length} photos — one PDF holds ${MAX_PDF_PHOTOS}. Remove some from ${big.name}.`
      : `${total} photos — one PDF holds ${MAX_PDF_PHOTOS}. Untick some areas. Make a second PDF for the rest.`;
  }
  return null;
}

/** Make a new PDF (areaIds + optional name) for a report. */
async function makePdf(sql, tenantId, jobId, report, { areaIds, name }, user) {
  const allIds = report.areas.map((a) => a.id);
  const wanted = Array.isArray(areaIds) && areaIds.length ? areaIds.filter((id) => allIds.includes(id)) : allIds;
  if (!wanted.length) return { status: 400, body: { error: 'Tick at least one area.' } };
  const snapshot = model.snapshotFor(report, wanted);
  const capError = photoCapError(snapshot);
  if (capError) return { status: 400, body: { error: capError } };
  const typed = cleanName(name, model.MAX_NAME);
  const pdfName = typed || model.defaultPdfName(snapshot.areas, report.areas.length);
  const file = await renderPdfFile({ jobId, report, name: pdfName, snapshot, totalAreaCount: report.areas.length, user });
  const pdf = await store.createPdf(sql, tenantId, report.id, {
    name: pdfName,
    nameIsAuto: !typed,
    areaIds: wanted,
    snapshot,
    contentKey: model.contentKey(snapshot.areas),
    areaCount: snapshot.areas.length,
    photoCount: model.countPhotos(snapshot.areas),
    url: file.url,
    pathname: file.pathname,
    byteSize: file.byteSize,
    user,
  });
  await store.stampPdf(sql, tenantId, jobId, report.id, file.url);
  return { status: 200, body: { pdf: withStale(pdf, report) } };
}

/** Make an existing PDF again: same areas, same name, file replaced. */
async function remakePdf(sql, tenantId, jobId, report, pdf, user) {
  const snapshot = model.snapshotFor(report, pdf.areaIds);
  if (!snapshot.areas.length) return { status: 400, body: { error: "This PDF's areas are gone — make a new PDF." } };
  const capError = photoCapError(snapshot);
  if (capError) return { status: 400, body: { error: capError } };
  const name = pdf.nameIsAuto ? model.defaultPdfName(snapshot.areas, report.areas.length) : pdf.name;
  const file = await renderPdfFile({ jobId, report, name, snapshot, totalAreaCount: report.areas.length, user });
  const next = await store.replacePdfFile(sql, pdf.id, {
    name,
    snapshot,
    contentKey: model.contentKey(snapshot.areas),
    areaCount: snapshot.areas.length,
    photoCount: model.countPhotos(snapshot.areas),
    url: file.url,
    pathname: file.pathname,
    byteSize: file.byteSize,
    user,
    touchMadeAt: true,
  });
  await store.stampPdf(sql, tenantId, jobId, report.id, file.url);
  return { status: 200, body: { pdf: withStale(next, report) } };
}

/** Rename: re-render header + file name from the PDF's OWN snapshot (the
 *  photo pages don't change, so it doesn't go out of date). */
async function renamePdf(sql, tenantId, jobId, report, pdf, name, user) {
  const typed = cleanName(name, model.MAX_NAME);
  const nextName = typed || model.defaultPdfName(pdf.snapshot.areas || [], report.areas.length);
  const file = await renderPdfFile({
    jobId, report, name: nextName, snapshot: pdf.snapshot, totalAreaCount: report.areas.length, user,
  });
  const next = await store.replacePdfFile(sql, pdf.id, {
    name: nextName,
    nameIsAuto: !typed,
    url: file.url,
    pathname: file.pathname,
    byteSize: file.byteSize,
    user,
    touchMadeAt: false,
  });
  return { status: 200, body: { pdf: withStale(next, report) } };
}

async function sendPdf(sql, tenantId, jobId, report, pdf, body, user) {
  const to = body.to === 'office' ? 'office' : body.to === 'email' ? 'email' : null;
  if (!to) return { status: 400, body: { error: 'to must be office or email' } };
  const officeEmail = String((await getSetting('itp_simple', 'officeEmail')) || '').trim();
  let recipient;
  if (to === 'office') {
    if (!model.isEmailAddress(officeEmail)) {
      return { status: 409, body: { error: 'No office email is set up yet — ask an admin, or Email it.' } };
    }
    recipient = officeEmail;
  } else {
    recipient = String(body.email || '').trim();
    if (!model.isEmailAddress(recipient)) {
      return { status: 400, body: { error: "That doesn't look like an email address." } };
    }
  }
  if (!isEmailConfigured()) {
    return { status: 503, body: { error: "Email isn't set up on the server yet. Save the PDF to your phone and send it yourself." } };
  }

  // A stale PDF is made again first, so they get the lot.
  let current = withStale(pdf, report);
  if (current.stale) {
    const remade = await remakePdf(sql, tenantId, jobId, report, pdf, user);
    if (remade.status !== 200) return remade;
    current = remade.body.pdf;
  }

  // Attach the file unless it's over the mail cap — then a link, and the
  // email says so.
  let attachment = null;
  let attached = false;
  try {
    const r = await fetch(current.url);
    if (r.ok) {
      const bytes = Buffer.from(await r.arrayBuffer());
      if (bytes.length <= MAX_ATTACH_BYTES) {
        attachment = { filename: `${safeFileName(current.name)}.pdf`, content: bytes.toString('base64') };
        attached = true;
      }
    }
  } catch {
    attachment = null;
  }

  const job = await jobMeta(jobId);
  const note = String(body.note || '').trim().slice(0, 1000);
  const message = renderItpEmail({
    pdfName: current.name,
    jobAddress: job.name,
    note,
    areaCount: current.areaCount,
    photoCount: current.photoCount,
    madeLabel: sydneyLabel(new Date(current.madeAt), true),
    attached,
    downloadUrl: current.url,
    senderName: user.name || user.username || '',
  });
  const result = await sendEmail({
    to: recipient,
    subject: message.subject,
    html: message.html,
    text: message.text,
    from: process.env.ITP_EMAIL_FROM || DEFAULT_FROM,
    replyTo: model.isEmailAddress(officeEmail) ? officeEmail : undefined,
    attachments: attachment ? [attachment] : undefined,
  });

  const send = await store.logSend(sql, tenantId, jobId, report.id, {
    pdfId: current.id,
    kind: to,
    recipient,
    pdfName: current.name,
    attached,
    result: result.ok ? 'sent' : 'failed',
    failure: result.ok ? null : result.reason,
    user,
  });
  if (!result.ok) {
    return {
      status: 502,
      body: {
        error: 'Didn\'t send. Try again — if it keeps failing, Save PDF to phone and send it yourself.',
        reason: result.reason,
        send,
        pdf: current,
      },
    };
  }
  return { status: 200, body: { send, pdf: current } };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;
  if (!(await isFlagEnabled('itp_simple', user))) return res.status(404).json({ error: 'not found' });

  const action = (req.query && req.query.action) || '';
  const isRead = req.method === 'GET';
  const writes = !isRead;
  // The walkthrough flag is the person's own, not the job's — any assigned
  // reader may mark it seen.
  if (writes && action !== 'walkthrough' && !canWrite(user, jobId)) {
    return res.status(403).json({ error: 'read-only' });
  }

  try {
    const sql = getDb({ mode: isRead ? 'read' : 'write' });
    const tenantId = await store.resolveTenantId(sql);
    if (!tenantId) return res.status(503).json({ error: 'itp store not provisioned' });
    const body = req.body || {};

    // ── Walkthrough ──────────────────────────────────────────────────
    if (action === 'walkthrough') {
      if (req.method !== 'PUT') return res.status(405).end();
      await store.markWalkthroughSeen(sql, tenantId, String(user.id || user.username || ''));
      return res.status(200).json({ ok: true, walkthroughSeen: true });
    }

    // ── Areas ─────────────────────────────────────────────────────────
    if (action === 'area') {
      if (req.method === 'POST') {
        const name = cleanName(body.name, 120);
        if (!body.reportId || !name) return res.status(400).json({ error: 'reportId and name required' });
        const area = await store.addArea(sql, tenantId, jobId, body.reportId, name);
        if (!area) return res.status(404).json({ error: 'report not found' });
        return res.status(200).json({ area });
      }
      if (req.method === 'PUT') {
        const name = cleanName(body.name, 120);
        if (!body.id || !name) return res.status(400).json({ error: 'id and name required' });
        const ok = await store.renameArea(sql, tenantId, jobId, body.id, name);
        return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'area not found' });
      }
      if (req.method === 'DELETE') {
        if (!body.id) return res.status(400).json({ error: 'id required' });
        const ok = await store.deleteArea(sql, tenantId, jobId, body.id);
        return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'area not found' });
      }
      return res.status(405).end();
    }

    // ── Photos ────────────────────────────────────────────────────────
    if (action === 'photo') {
      if (req.method === 'POST') {
        if (!body.areaId || !body.dataUrl) return res.status(400).json({ error: 'areaId and dataUrl required' });
        const caption = body.caption ? String(body.caption).trim().slice(0, 200) : '';
        const uploaded = await uploadPhoto(jobId, body.dataUrl);
        if (uploaded.error) return res.status(400).json({ error: uploaded.error });
        const photo = await store.addPhoto(sql, tenantId, jobId, body.areaId, {
          url: uploaded.url, pathname: uploaded.pathname, caption, user,
        });
        // A bad areaId after a successful upload leaves an orphaned Blob byte —
        // that joins the existing evidence orphan-GC story, it is not tracked here.
        if (!photo) return res.status(404).json({ error: 'area not found' });
        return res.status(200).json({ photo });
      }
      if (req.method === 'PUT') {
        if (!body.id || typeof body.caption !== 'string') return res.status(400).json({ error: 'id and caption required' });
        const caption = body.caption.trim().slice(0, 200);
        const ok = await store.updatePhotoCaption(sql, tenantId, jobId, body.id, caption);
        return ok ? res.status(200).json({ ok: true, caption }) : res.status(404).json({ error: 'photo not found' });
      }
      if (req.method === 'DELETE') {
        if (!body.id) return res.status(400).json({ error: 'id required' });
        const ok = await store.deletePhoto(sql, tenantId, jobId, body.id);
        return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'photo not found' });
      }
      return res.status(405).end();
    }

    // ── PDFs ──────────────────────────────────────────────────────────
    if (action === 'pdf') {
      if (req.method === 'POST' && body.pdfId) {
        const pdf = await store.getPdf(sql, tenantId, jobId, body.pdfId);
        if (!pdf) return res.status(404).json({ error: 'pdf not found' });
        const report = await store.getReport(sql, tenantId, jobId, pdf.reportId);
        if (!report) return res.status(404).json({ error: 'report not found' });
        const out = await remakePdf(sql, tenantId, jobId, report, pdf, user);
        return res.status(out.status).json(out.body);
      }
      if (req.method === 'POST') {
        if (!body.reportId) return res.status(400).json({ error: 'reportId required' });
        const report = await store.getReport(sql, tenantId, jobId, body.reportId);
        if (!report) return res.status(404).json({ error: 'report not found' });
        const out = await makePdf(sql, tenantId, jobId, report, { areaIds: body.areaIds, name: body.name }, user);
        return res.status(out.status).json(out.body);
      }
      if (req.method === 'PUT') {
        if (!body.id) return res.status(400).json({ error: 'id required' });
        const pdf = await store.getPdf(sql, tenantId, jobId, body.id);
        if (!pdf) return res.status(404).json({ error: 'pdf not found' });
        const report = await store.getReport(sql, tenantId, jobId, pdf.reportId);
        if (!report) return res.status(404).json({ error: 'report not found' });
        const out = await renamePdf(sql, tenantId, jobId, report, pdf, body.name, user);
        return res.status(out.status).json(out.body);
      }
      return res.status(405).end();
    }

    // ── Send ──────────────────────────────────────────────────────────
    if (action === 'send') {
      if (req.method !== 'POST') return res.status(405).end();
      if (!body.pdfId) return res.status(400).json({ error: 'pdfId required' });
      const pdf = await store.getPdf(sql, tenantId, jobId, body.pdfId);
      if (!pdf) return res.status(404).json({ error: 'pdf not found' });
      const report = await store.getReport(sql, tenantId, jobId, pdf.reportId);
      if (!report) return res.status(404).json({ error: 'report not found' });
      const out = await sendPdf(sql, tenantId, jobId, report, pdf, body, user);
      return res.status(out.status).json(out.body);
    }

    // ── Reports ───────────────────────────────────────────────────────
    if (req.method === 'GET') {
      const id = (req.query && req.query.id) || '';
      if (id) {
        const report = await store.getReport(sql, tenantId, jobId, id);
        if (!report) return res.status(404).json({ error: 'report not found' });
        const [pdfs, sends, lastNames, emailSuggestions, job, officeEmail] = await Promise.all([
          store.listPdfs(sql, report.id),
          store.listSends(sql, report.id),
          store.lastReportAreaNames(sql, tenantId, jobId, report.id),
          store.recentEmailRecipients(sql, tenantId, jobId),
          jobMeta(jobId),
          getSetting('itp_simple', 'officeEmail'),
        ]);
        // Recent names: this job's area names first, then the last ITP's;
        // names already in this ITP left out; no built-in list (handoff).
        const taken = new Set(report.areas.map((a) => a.name.trim().toLowerCase()));
        const recentNames = [];
        for (const n of [...job.areaNames, ...lastNames]) {
          const key = String(n).trim().toLowerCase();
          if (!key || taken.has(key)) continue;
          taken.add(key);
          recentNames.push(String(n).trim());
        }
        const office = String(officeEmail || '').trim();
        return res.status(200).json({
          report,
          pdfs: pdfs.map((p) => withStale(p, report)),
          sends,
          recentNames,
          emailSuggestions,
          officeEmail: model.isEmailAddress(office) ? office : null,
        });
      }
      const [job, reports, walkthroughSeen, officeEmail] = await Promise.all([
        jobMeta(jobId),
        store.listReports(sql, tenantId, jobId),
        store.walkthroughSeen(sql, tenantId, String(user.id || user.username || '')),
        getSetting('itp_simple', 'officeEmail'),
      ]);
      const facts = await store.reportFacts(sql, reports.map((r) => r.id));
      const enriched = reports.map((r) => {
        const pdfs = facts.pdfsByReport.get(r.id) || [];
        const liveAreas = facts.areasByReport.get(r.id) || [];
        const liveReport = { areas: liveAreas };
        const staleCount = pdfs.filter((p) => p.contentKey !== model.liveContentKey(liveReport, p.areaIds)).length;
        const lastSend = facts.lastSendByReport.get(r.id) || null;
        return {
          ...r,
          pdfCount: pdfs.length,
          staleCount,
          lastMadeAt: pdfs.length ? pdfs[0].madeAt : r.pdfGeneratedAt || null,
          lastSend: lastSend ? { kind: lastSend.kind, recipient: lastSend.recipient, sentAt: lastSend.sentAt } : null,
        };
      });
      return res.status(200).json({
        job: { id: job.id, name: job.name },
        reports: enriched,
        walkthroughSeen,
        officeEmailSet: model.isEmailAddress(String(officeEmail || '').trim()),
      });
    }

    if (req.method === 'POST') {
      const title = cleanName(body.title, 120);
      if (!title) return res.status(400).json({ error: 'title required (max 120 chars)' });
      const report = await store.createReport(sql, tenantId, { jobLegacyId: jobId, title, user });
      return res.status(200).json({ report });
    }

    if (req.method === 'PUT') {
      const title = cleanName(body.title, 120);
      if (!body.id || !title) return res.status(400).json({ error: 'id and title required' });
      const ok = await store.renameReport(sql, tenantId, jobId, body.id, title);
      return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'report not found' });
    }

    if (req.method === 'DELETE') {
      if (!body.id) return res.status(400).json({ error: 'id required' });
      const ok = await store.deleteReport(sql, tenantId, jobId, body.id);
      return ok ? res.status(200).json({ ok: true }) : res.status(404).json({ error: 'report not found' });
    }

    return res.status(405).end();
  } catch (e) {
    console.error('itp-simple:', e);
    return res.status(500).json({ error: e.message || 'itp-simple failed' });
  }
};
