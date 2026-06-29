// api/safety-docs.js — #219 safety documents (SWMS / SDS / other-safety) on the
// job, with acknowledge-read in Phil.
//
//   GET    /api/safety-docs?jobId=X                  → list current docs
//                                                       admin/manager: + ack rollup
//                                                       assigned crew:  + own acked ids
//   POST   /api/safety-docs?jobId=X                   → upload (admin/manager, dataUrl)
//                                                       body { type, title, dataUrl, mimeType?, fileName?, supersedesId? }
//   POST   /api/safety-docs?jobId=X&action=acknowledge → assigned crew acknowledges
//                                                       body { docId } — identity from the SESSION, never the body
//
// Mirrors api/plans.js (#299 plan-acks): one handler for upload + per-user acks +
// admin rollup + field/admin auth. Storage is isolated from the shared documents
// register: jobs/<jobId>/safety-docs.json + jobs/<jobId>/safety-acks.json.
//
// Dark by default behind the `safety_docs` flag (GLOBAL — assigned crew, not just
// admin, must see it once on). Uploads are admin/manager-only (enforced here, not
// by the flag). A new version supersedes the prior and starts fresh acks.

const { put } = require("@vercel/blob");
const { readBlob, writeBlob, setNoCache } = require("./_lib/blob");
const {
  requireAuth,
  canManageJob,
  isAdminRole,
  isClientRole,
  isFieldRole,
  isLeadingHandRole,
} = require("./_lib/auth");
const { isFlagEnabled } = require("./_lib/feature-flags");
const { getSetting } = require("./_lib/feature-settings");
const { append: appendAuditLog } = require("./_lib/audit-log");

const FLAG = "safety_docs";
const SAFETY_TYPES = ["swms", "sds", "other-safety"];
// Upload cap is an owner-tunable setting (feature-settings.js →
// safety_docs.maxUploadMb, default 25) — resolved per request at the check below.

function docsKey(jobId) {
  return "jobs/" + jobId + "/safety-docs.json";
}
function acksKey(jobId) {
  return "jobs/" + jobId + "/safety-acks.json";
}
async function readDocs(jobId) {
  return await readBlob(docsKey(jobId), { documents: [] });
}
async function readAcks(jobId) {
  return await readBlob(acksKey(jobId), { acks: [] });
}

function newId() {
  return "sd_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function extFor(mime) {
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime && (mime.includes("word") || mime.includes("officedocument"))) return "docx";
  return "bin";
}
function isAllowedMime(mime) {
  if (!mime) return false;
  if (mime === "application/pdf") return true;
  if (mime.startsWith("image/")) return true;
  if (mime.includes("word") || mime.includes("officedocument")) return true; // docx
  return false;
}

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;

  // Dark by default → 404 when off, so the surface is invisible.
  if (!(await isFlagEnabled(FLAG, user))) {
    return res.status(404).json({ error: "not found" });
  }
  // Clients never see job safety docs.
  if (isClientRole(user.role)) return res.status(403).json({ error: "forbidden" });

  const jobId = (req.query && req.query.jobId) || "";
  if (!jobId) return res.status(400).json({ error: "jobId required" });
  const action = (req.query && req.query.action) || "";

  const isCrew = Array.isArray(user.assignedJobIds) && user.assignedJobIds.includes(jobId);
  const canManage = isAdminRole(user.role) || canManageJob(user, jobId);

  // ---- POST acknowledge — assigned crew (or manager). Self-attributed. ----
  if (req.method === "POST" && action === "acknowledge") {
    if (!isCrew && !canManage) return res.status(403).json({ error: "not assigned to this job" });
    const body = req.body || {};
    const docId = body.docId;
    if (!docId) return res.status(400).json({ error: "docId required" });

    const docsData = await readDocs(jobId);
    const doc = (docsData.documents || []).find((d) => d.id === docId && d.status === "current");
    if (!doc) return res.status(404).json({ error: "document not found or not current" });

    const acksData = await readAcks(jobId);
    acksData.acks = acksData.acks || [];
    const existing = acksData.acks.find((a) => a.docId === docId && a.userId === user.id);
    if (existing) return res.status(200).json({ ack: existing, already: true }); // idempotent

    const ack = {
      docId,
      version: doc.version,
      userId: user.id, // ← identity from the session, never the request body
      userName: user.username || user.id,
      at: new Date().toISOString(),
    };
    acksData.acks.push(ack);
    await writeBlob(acksKey(jobId), acksData);
    await appendAuditLog({
      action: "safety_doc.acknowledged",
      actorId: user.id,
      actorName: user.username || "Unknown",
      actorRole: user.role || null,
      jobId,
      targetType: "safety_doc",
      targetId: docId,
      summary: `acknowledged safety doc "${String(doc.title).slice(0, 80)}" (v${doc.version})`,
      metadata: { type: doc.type, version: doc.version },
    }).catch(() => {});
    return res.status(201).json({ ack });
  }

  // ---- GET list (admin → rollup; assigned crew → own acked ids) ----
  if (req.method === "GET") {
    if (!isCrew && !canManage) return res.status(403).json({ error: "not assigned to this job" });
    const [docsData, acksData] = await Promise.all([readDocs(jobId), readAcks(jobId)]);
    const current = (docsData.documents || []).filter((d) => d.status === "current");

    if (canManage) {
      const usersBlob = await readBlob("users.json", { users: [] });
      const workers = (usersBlob.users || []).filter(
        (u) =>
          Array.isArray(u.assignedJobIds) &&
          u.assignedJobIds.includes(jobId) &&
          !u.archived &&
          !u.disabled &&
          u.status !== "disabled" &&
          (isFieldRole(u.role) || isLeadingHandRole(u.role))
      );
      const rollup = current.map((doc) => {
        const acknowledged = [];
        const outstanding = [];
        for (const w of workers) {
          const ack = (acksData.acks || []).find((a) => a.docId === doc.id && a.userId === w.id);
          if (ack) acknowledged.push({ userId: w.id, name: w.username || w.id, at: ack.at });
          else outstanding.push({ userId: w.id, name: w.username || w.id });
        }
        return { doc, acknowledged, outstanding };
      });
      return res.status(200).json({ documents: current, rollup });
    }

    const live = new Set(current.map((d) => d.id));
    const acknowledgedDocIds = (acksData.acks || [])
      .filter((a) => a.userId === user.id && live.has(a.docId))
      .map((a) => a.docId);
    return res.status(200).json({ documents: current, acknowledgedDocIds });
  }

  // ---- POST upload (admin / manager only) ----
  if (req.method === "POST") {
    if (!canManage) return res.status(403).json({ error: "admin / manager only" });
    const body = req.body || {};
    const type = SAFETY_TYPES.includes(body.type) ? body.type : null;
    if (!type)
      return res.status(400).json({ error: "type must be one of swms | sds | other-safety" });
    const title = body.title ? String(body.title).trim().slice(0, 200) : "";
    if (!title) return res.status(400).json({ error: "title required" });
    if (!body.dataUrl || typeof body.dataUrl !== "string") {
      return res.status(400).json({ error: "dataUrl required" });
    }
    const mime =
      body.mimeType ||
      (body.dataUrl.match(/^data:([^;]+);/) || [])[1] ||
      "application/octet-stream";
    if (!isAllowedMime(mime)) {
      return res.status(400).json({ error: "unsupported file type (PDF, image or Word)" });
    }
    const base64 = String(body.dataUrl).split(",")[1];
    if (!base64) return res.status(400).json({ error: "invalid dataUrl" });
    const buf = Buffer.from(base64, "base64");
    const maxMb = await getSetting("safety_docs", "maxUploadMb");
    if (buf.length > maxMb * 1024 * 1024)
      return res.status(400).json({ error: `file too large (max ${maxMb} MB)` });

    const docsData = await readDocs(jobId);
    docsData.documents = docsData.documents || [];

    // A new version supersedes a prior CURRENT doc and starts fresh acks.
    let version = 1;
    let supersedesId = null;
    if (body.supersedesId) {
      const prior = docsData.documents.find(
        (d) => d.id === body.supersedesId && d.status === "current"
      );
      if (!prior) return res.status(404).json({ error: "supersedesId not found or not current" });
      version = (Number.isFinite(prior.version) ? prior.version : 1) + 1;
      supersedesId = prior.id;
    }

    const id = newId();
    const blobPath = "jobs/" + jobId + "/safety-docs/" + id + "." + extFor(mime);
    const uploaded = await put(blobPath, buf, {
      access: "public",
      contentType: mime,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    if (supersedesId) {
      const prior = docsData.documents.find((d) => d.id === supersedesId);
      if (prior) {
        prior.status = "superseded";
        prior.supersededById = id;
      }
    }
    const now = new Date().toISOString();
    const doc = {
      id,
      jobId,
      type,
      title,
      version,
      fileName: body.fileName ? String(body.fileName).slice(0, 200) : title + "." + extFor(mime),
      blobPath,
      url: uploaded.url,
      mimeType: mime,
      sizeBytes: buf.length,
      status: "current",
      supersedesId,
      supersededById: null,
      uploadedAt: now,
      uploadedBy: user.username || user.id,
    };
    docsData.documents.push(doc);
    await writeBlob(docsKey(jobId), docsData);
    await appendAuditLog({
      action: "safety_doc.uploaded",
      actorId: user.id,
      actorName: user.username || "Unknown",
      actorRole: user.role || null,
      jobId,
      targetType: "safety_doc",
      targetId: id,
      summary: `uploaded ${type.toUpperCase()} "${title.slice(0, 80)}" (v${version})`,
      metadata: { type, version, supersedesId },
    }).catch(() => {});
    return res.status(201).json({ document: doc });
  }

  return res.status(405).json({ error: "method not allowed" });
};
