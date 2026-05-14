// Job Materials + Invoice Capture.
// Storage: jobs/<jobId>/materials.json with { materials: [], invoices: [] }
// Missing file is treated as empty — no eager migration.
//
// Actions (use ?action=...):
//   GET   ?jobId=X                           → { materials, invoices, summary }
//   POST  ?jobId=X&action=material           → create material
//   PATCH ?jobId=X&action=material&id=Y      → update material
//   DELETE?jobId=X&action=material&id=Y      → archive material (status=cancelled)
//   POST  ?jobId=X&action=invoice            → create invoice (metadata only)
//   PATCH ?jobId=X&action=invoice&id=Y       → update / review invoice
//   DELETE?jobId=X&action=invoice&id=Y       → admin only — hard delete invoice record
//   POST  ?jobId=X&action=invoice-file&id=Y  → attach a file (base64) to an existing invoice
//   POST  ?jobId=X&action=invoice-with-file  → create invoice + upload file in one shot
//
// Cost rollup rules:
//   approvedActual = sum(approved invoices) + sum(material.actualTotal where NOT linked to approved invoice)
//   pendingReview  = sum(pending_review + needs_info invoices)
//   estimated      = sum(material.estimatedTotal)
//   rejected invoices and cancelled materials are excluded from totals.

const { put } = require('@vercel/blob');
const { readBlob, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, canWrite } = require('./_lib/auth');
const {
  requireFields, trimStr, trimStrOrNull, newId, nowIso,
} = require('./_lib/validation');

const MATERIAL_STATUSES = ['needed','ordered','to_be_delivered','delivered','onsite','used','cancelled'];
const INVOICE_STATUSES = ['pending_review','approved','needs_info','rejected'];
const SOURCES = ['planned','site_purchase','variation','workshop_stock','supplier_order','manual'];
const REVIEW_STATUSES = ['draft','pending_review','approved','needs_info','rejected'];

function blobKey(jobId) { return `jobs/${jobId}/materials.json`; }

function emptyDoc() { return { materials: [], invoices: [] }; }

async function readDoc(jobId) {
  const data = await readBlob(blobKey(jobId), emptyDoc());
  data.materials = Array.isArray(data.materials) ? data.materials : [];
  data.invoices = Array.isArray(data.invoices) ? data.invoices : [];
  return data;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function bool(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  return !!v;
}

function sanitizeMaterial(input, base = {}, userId) {
  const status = MATERIAL_STATUSES.includes(input.status) ? input.status : (base.status || 'needed');
  const source = SOURCES.includes(input.source) ? input.source : (base.source || 'manual');
  const reviewStatus = REVIEW_STATUSES.includes(input.reviewStatus) ? input.reviewStatus : (base.reviewStatus || 'draft');
  const estUnit = num(input.estimatedUnitCost ?? base.estimatedUnitCost);
  const estTotal = num(input.estimatedTotalCost ?? base.estimatedTotalCost);
  const actUnit = num(input.actualUnitCost ?? base.actualUnitCost);
  const actTotal = num(input.actualTotalCost ?? base.actualTotalCost);
  const qty = num(input.quantity ?? base.quantity);
  return {
    id: base.id,
    jobId: base.jobId,
    name: trimStr(input.name ?? base.name, 200),
    description: trimStrOrNull(input.description ?? base.description, 2000) || '',
    category: trimStrOrNull(input.category ?? base.category, 100) || '',
    supplier: trimStrOrNull(input.supplier ?? base.supplier, 200) || '',
    partNumber: trimStrOrNull(input.partNumber ?? base.partNumber, 100) || '',
    quantity: qty,
    unit: trimStrOrNull(input.unit ?? base.unit, 30) || 'ea',
    status,
    location: trimStrOrNull(input.location ?? base.location, 200) || '',
    source,
    isVariation: bool(input.isVariation ?? base.isVariation, false),
    variationNote: trimStrOrNull(input.variationNote ?? base.variationNote, 1000) || '',
    estimatedUnitCost: estUnit,
    estimatedTotalCost: estTotal !== null ? estTotal : (estUnit !== null && qty !== null ? +(estUnit * qty).toFixed(2) : null),
    actualUnitCost: actUnit,
    actualTotalCost: actTotal !== null ? actTotal : (actUnit !== null && qty !== null ? +(actUnit * qty).toFixed(2) : null),
    gstIncluded: bool(input.gstIncluded ?? base.gstIncluded, true),
    linkedInvoiceIds: Array.isArray(input.linkedInvoiceIds)
      ? input.linkedInvoiceIds.filter(x => typeof x === 'string')
      : (Array.isArray(base.linkedInvoiceIds) ? base.linkedInvoiceIds : []),
    reviewStatus,
    addedBy: base.addedBy,
    createdAt: base.createdAt,
    updatedBy: userId,
    updatedAt: nowIso(),
    notes: trimStrOrNull(input.notes ?? base.notes, 5000) || '',
  };
}

function sanitizeInvoice(input, base = {}, userId) {
  const status = INVOICE_STATUSES.includes(input.status) ? input.status : (base.status || 'pending_review');
  return {
    id: base.id,
    jobId: base.jobId,
    supplier: trimStrOrNull(input.supplier ?? base.supplier, 200) || '',
    invoiceNumber: trimStrOrNull(input.invoiceNumber ?? base.invoiceNumber, 100) || '',
    invoiceDate: trimStrOrNull(input.invoiceDate ?? base.invoiceDate, 30) || '',
    totalAmount: num(input.totalAmount ?? base.totalAmount),
    gstIncluded: bool(input.gstIncluded ?? base.gstIncluded, true),
    status,
    photoUrl: trimStrOrNull(input.photoUrl ?? base.photoUrl, 1000) || '',
    blobPath: trimStrOrNull(input.blobPath ?? base.blobPath, 1000) || '',
    fileName: trimStrOrNull(input.fileName ?? base.fileName, 300) || '',
    fileType: trimStrOrNull(input.fileType ?? base.fileType, 100) || '',
    linkedMaterialIds: Array.isArray(input.linkedMaterialIds)
      ? input.linkedMaterialIds.filter(x => typeof x === 'string')
      : (Array.isArray(base.linkedMaterialIds) ? base.linkedMaterialIds : []),
    uploadedBy: base.uploadedBy,
    uploadedAt: base.uploadedAt,
    reviewedBy: base.reviewedBy ?? null,
    reviewedAt: base.reviewedAt ?? null,
    notes: trimStrOrNull(input.notes ?? base.notes, 5000) || '',
  };
}

function computeSummary(doc) {
  const matsActive = doc.materials.filter(m => m.status !== 'cancelled');

  const approvedInvoices = doc.invoices.filter(i => i.status === 'approved');
  const pendingInvoices = doc.invoices.filter(i => i.status === 'pending_review' || i.status === 'needs_info');

  const approvedInvoiceIds = new Set(approvedInvoices.map(i => i.id));
  const approvedInvoiceTotal = approvedInvoices.reduce((s, i) => s + (Number(i.totalAmount) || 0), 0);

  // Approved actual from materials NOT linked to an approved invoice (avoid double-count)
  const materialApprovedActual = matsActive.reduce((s, m) => {
    if (m.reviewStatus !== 'approved') return s;
    if (m.actualTotalCost == null) return s;
    const linkedToApproved = (m.linkedInvoiceIds || []).some(id => approvedInvoiceIds.has(id));
    if (linkedToApproved) return s;
    return s + Number(m.actualTotalCost);
  }, 0);

  const approvedActual = +(approvedInvoiceTotal + materialApprovedActual).toFixed(2);
  const pendingReview = +(pendingInvoices.reduce((s, i) => s + (Number(i.totalAmount) || 0), 0)).toFixed(2);
  const estimated = +(matsActive.reduce((s, m) => s + (Number(m.estimatedTotalCost) || 0), 0)).toFixed(2);

  return {
    estimated,
    approvedActual,
    pendingReview,
    invoicesPending: pendingInvoices.length,
    invoicesApproved: approvedInvoices.length,
    materialsOnsite: matsActive.filter(m => m.status === 'onsite').length,
    materialsToBeDelivered: matsActive.filter(m => m.status === 'to_be_delivered' || m.status === 'ordered').length,
    materialsUsed: matsActive.filter(m => m.status === 'used').length,
    materialsNeeded: matsActive.filter(m => m.status === 'needed').length,
    variations: matsActive.filter(m => m.isVariation || m.source === 'variation').length,
  };
}

// Strip cost data for users who can't see financials (tradie / client).
function redactForRole(doc, user) {
  if (user.role === 'admin') return doc;
  const matsActive = doc.materials.filter(m => m.status !== 'cancelled');
  const sanitisedMaterials = matsActive.map(m => {
    const copy = { ...m };
    if (user.role !== 'admin') {
      delete copy.estimatedUnitCost;
      delete copy.estimatedTotalCost;
      delete copy.actualUnitCost;
      delete copy.actualTotalCost;
    }
    return copy;
  });

  // Leading hand (tradie) sees their own invoice uploads (no totalAmount unless they entered it themselves).
  // To keep it simple: tradies see invoice metadata they uploaded, with totalAmount preserved (they may have entered it).
  // Other tradies' invoices: visible but totalAmount hidden.
  const sanitisedInvoices = doc.invoices
    .filter(i => i.status !== 'rejected' || i.uploadedBy === user.id)
    .map(i => {
      const copy = { ...i };
      if (copy.uploadedBy !== user.id) delete copy.totalAmount;
      return copy;
    });

  return { materials: sanitisedMaterials, invoices: sanitisedInvoices };
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const jobId = (req.query && req.query.jobId) || '';
  if (!jobId) return res.status(400).json({ error: 'jobId required' });

  const user = await requireAuth(req, res, { jobId });
  if (!user) return;

  // Clients: no access to materials/invoices at all.
  if (user.role === 'client') return res.status(403).json({ error: 'forbidden' });

  const action = (req.query && req.query.action) || '';
  const id = (req.query && req.query.id) || '';

  // GET — list materials + invoices + summary
  if (req.method === 'GET') {
    const doc = await readDoc(jobId);
    const summary = computeSummary(doc);
    if (user.role === 'admin') {
      return res.status(200).json({ ...doc, summary });
    }
    const safe = redactForRole(doc, user);
    return res.status(200).json({
      ...safe,
      summary: {
        invoicesPending: summary.invoicesPending,
        materialsOnsite: summary.materialsOnsite,
        materialsToBeDelivered: summary.materialsToBeDelivered,
        materialsUsed: summary.materialsUsed,
        materialsNeeded: summary.materialsNeeded,
        variations: summary.variations,
      },
    });
  }

  // Writes — leading hand (tradie) or admin only.
  if (!canWrite(user, jobId)) return res.status(403).json({ error: 'read-only' });

  const doc = await readDoc(jobId);

  // ─── Materials ───
  if (action === 'material' && req.method === 'POST') {
    const body = req.body || {};
    const err = requireFields(body, ['name']);
    if (err) return res.status(400).json({ error: err });
    if (body.status && !MATERIAL_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const matId = newId('mat');
    const now = nowIso();
    const sanitized = sanitizeMaterial(body, {
      id: matId, jobId, createdAt: now, addedBy: user.id,
    }, user.id);
    // Tradies can't set actual cost fields; strip if present.
    if (user.role !== 'admin') {
      sanitized.actualUnitCost = null;
      sanitized.actualTotalCost = null;
      sanitized.estimatedUnitCost = null;
      sanitized.estimatedTotalCost = null;
      sanitized.reviewStatus = 'draft';
    }
    sanitized.id = matId;
    sanitized.jobId = jobId;
    sanitized.addedBy = user.id;
    sanitized.createdAt = now;
    doc.materials.push(sanitized);
    await writeBlob(blobKey(jobId), doc);
    return res.status(200).json({ material: sanitized });
  }

  if (action === 'material' && req.method === 'PATCH') {
    if (!id) return res.status(400).json({ error: 'id required' });
    const idx = doc.materials.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'material not found' });
    const body = req.body || {};
    if (body.status && !MATERIAL_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const existing = doc.materials[idx];
    const updated = sanitizeMaterial(body, existing, user.id);
    if (user.role !== 'admin') {
      // Leading hand cannot change cost fields or admin review status
      updated.actualUnitCost = existing.actualUnitCost;
      updated.actualTotalCost = existing.actualTotalCost;
      updated.estimatedUnitCost = existing.estimatedUnitCost;
      updated.estimatedTotalCost = existing.estimatedTotalCost;
      updated.reviewStatus = existing.reviewStatus;
    }
    updated.id = id;
    updated.jobId = jobId;
    doc.materials[idx] = updated;
    await writeBlob(blobKey(jobId), doc);
    return res.status(200).json({ material: updated });
  }

  if (action === 'material' && req.method === 'DELETE') {
    if (!id) return res.status(400).json({ error: 'id required' });
    const idx = doc.materials.findIndex(m => m.id === id);
    if (idx === -1) return res.status(404).json({ error: 'material not found' });
    // Soft delete — mark cancelled. Only admin can hard-archive.
    doc.materials[idx].status = 'cancelled';
    doc.materials[idx].updatedAt = nowIso();
    doc.materials[idx].updatedBy = user.id;
    await writeBlob(blobKey(jobId), doc);
    return res.status(200).json({ ok: true });
  }

  // ─── Invoices ───
  if (action === 'invoice' && req.method === 'POST') {
    const body = req.body || {};
    // Duplicate warning: supplier + invoiceNumber on same job
    const supplier = trimStrOrNull(body.supplier, 200);
    const invoiceNumber = trimStrOrNull(body.invoiceNumber, 100);
    if (supplier && invoiceNumber) {
      const dup = doc.invoices.find(i =>
        (i.supplier || '').toLowerCase() === supplier.toLowerCase() &&
        (i.invoiceNumber || '').toLowerCase() === invoiceNumber.toLowerCase() &&
        i.status !== 'rejected'
      );
      if (dup && !body.confirmDuplicate) {
        return res.status(409).json({
          error: 'duplicate invoice',
          duplicateOf: dup.id,
          message: 'An invoice with this supplier and invoice number already exists. Pass confirmDuplicate=true to override.',
        });
      }
    }
    const invId = newId('inv');
    const now = nowIso();
    const sanitized = sanitizeInvoice(body, {
      id: invId, jobId, uploadedBy: user.id, uploadedAt: now,
    }, user.id);
    // Tradie uploads always default to pending_review
    if (user.role !== 'admin') sanitized.status = 'pending_review';
    sanitized.id = invId;
    sanitized.jobId = jobId;
    sanitized.uploadedBy = user.id;
    sanitized.uploadedAt = now;
    doc.invoices.push(sanitized);
    await writeBlob(blobKey(jobId), doc);
    return res.status(200).json({ invoice: sanitized });
  }

  if (action === 'invoice' && req.method === 'PATCH') {
    if (!id) return res.status(400).json({ error: 'id required' });
    const idx = doc.invoices.findIndex(i => i.id === id);
    if (idx === -1) return res.status(404).json({ error: 'invoice not found' });
    const body = req.body || {};
    if (body.status && !INVOICE_STATUSES.includes(body.status)) {
      return res.status(400).json({ error: 'invalid status' });
    }
    const existing = doc.invoices[idx];

    // Permission check: tradies can only edit their own invoices,
    // and can never change status to approved.
    if (user.role !== 'admin') {
      if (existing.uploadedBy !== user.id) {
        return res.status(403).json({ error: 'forbidden' });
      }
      if (body.status && body.status !== existing.status && body.status !== 'pending_review') {
        return res.status(403).json({ error: 'only admin can review invoices' });
      }
    }

    const updated = sanitizeInvoice(body, existing, user.id);
    updated.id = id;
    updated.jobId = jobId;
    // Track admin review actions
    if (user.role === 'admin' && body.status && body.status !== existing.status) {
      if (['approved','needs_info','rejected'].includes(body.status)) {
        updated.reviewedBy = user.id;
        updated.reviewedAt = nowIso();
      } else {
        updated.reviewedBy = null;
        updated.reviewedAt = null;
      }
    }
    doc.invoices[idx] = updated;
    await writeBlob(blobKey(jobId), doc);
    return res.status(200).json({ invoice: updated });
  }

  if (action === 'invoice' && req.method === 'DELETE') {
    if (user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    if (!id) return res.status(400).json({ error: 'id required' });
    const before = doc.invoices.length;
    doc.invoices = doc.invoices.filter(i => i.id !== id);
    if (doc.invoices.length === before) return res.status(404).json({ error: 'invoice not found' });
    // Unlink from any material
    doc.materials.forEach(m => {
      if (Array.isArray(m.linkedInvoiceIds)) {
        m.linkedInvoiceIds = m.linkedInvoiceIds.filter(x => x !== id);
      }
    });
    await writeBlob(blobKey(jobId), doc);
    return res.status(200).json({ ok: true });
  }

  // ─── Invoice file attach (base64) ───
  // Stores file at jobs/<jobId>/materials/invoices/<invoiceId>/<filename>
  if ((action === 'invoice-file' || action === 'invoice-with-file') && req.method === 'POST') {
    const body = req.body || {};
    const { filename, data, contentType } = body;
    if (!filename || !data) return res.status(400).json({ error: 'filename and data required' });
    if (!/^[\w. \-()+]+$/i.test(filename)) return res.status(400).json({ error: 'invalid filename' });

    let invoice;
    let invoiceId;
    if (action === 'invoice-file') {
      if (!id) return res.status(400).json({ error: 'id required' });
      const idx = doc.invoices.findIndex(i => i.id === id);
      if (idx === -1) return res.status(404).json({ error: 'invoice not found' });
      invoice = doc.invoices[idx];
      if (user.role !== 'admin' && invoice.uploadedBy !== user.id) {
        return res.status(403).json({ error: 'forbidden' });
      }
      invoiceId = id;
    } else {
      // Combined create-and-upload — also check duplicate
      const supplier = trimStrOrNull(body.supplier, 200);
      const invoiceNumber = trimStrOrNull(body.invoiceNumber, 100);
      if (supplier && invoiceNumber) {
        const dup = doc.invoices.find(i =>
          (i.supplier || '').toLowerCase() === supplier.toLowerCase() &&
          (i.invoiceNumber || '').toLowerCase() === invoiceNumber.toLowerCase() &&
          i.status !== 'rejected'
        );
        if (dup && !body.confirmDuplicate) {
          return res.status(409).json({
            error: 'duplicate invoice',
            duplicateOf: dup.id,
            message: 'An invoice with this supplier and invoice number already exists. Pass confirmDuplicate=true to override.',
          });
        }
      }
      invoiceId = newId('inv');
      const now = nowIso();
      invoice = sanitizeInvoice(body, {
        id: invoiceId, jobId, uploadedBy: user.id, uploadedAt: now,
      }, user.id);
      if (user.role !== 'admin') invoice.status = 'pending_review';
      invoice.id = invoiceId;
      invoice.jobId = jobId;
      invoice.uploadedBy = user.id;
      invoice.uploadedAt = now;
      doc.invoices.push(invoice);
    }

    const safeName = filename.replace(/[^\w.\-()+]/g, '_').slice(0, 200);
    const path = `jobs/${jobId}/materials/invoices/${invoiceId}/${Date.now()}-${safeName}`;
    let blob;
    try {
      const buf = Buffer.from(String(data), 'base64');
      blob = await put(path, buf, {
        access: 'public',
        contentType: contentType || 'application/octet-stream',
        token: process.env.BLOB_READ_WRITE_TOKEN,
        addRandomSuffix: false,
      });
    } catch (e) {
      return res.status(500).json({ error: 'upload failed: ' + e.message });
    }

    // Update invoice with file info
    const finalIdx = doc.invoices.findIndex(i => i.id === invoiceId);
    if (finalIdx === -1) return res.status(500).json({ error: 'invoice missing after upload' });
    doc.invoices[finalIdx].photoUrl = blob.url;
    doc.invoices[finalIdx].blobPath = path;
    doc.invoices[finalIdx].fileName = safeName;
    doc.invoices[finalIdx].fileType = contentType || 'application/octet-stream';
    await writeBlob(blobKey(jobId), doc);
    return res.status(200).json({ invoice: doc.invoices[finalIdx] });
  }

  res.status(400).json({ error: 'unknown action' });
};
