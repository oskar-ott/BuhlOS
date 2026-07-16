// Assets — company-owned items (vehicles, keys, tools, accessories, PPE)
// assigned to people. Separate from jobs and timesheets.
//
// Storage:
//   assets/<id>.json            — the asset record (one file per asset)
//   assets/<id>/history.json    — append-only transfer log for that asset
//
// Why two files instead of one with embedded history: history grows
// unbounded as the asset moves between people, and most reads of the
// asset don't need it. Keeping history in a sibling blob means the
// list view stays fast (one file per asset, no nested array bloat)
// and detail-view reads pay only for the history they show.
//
// Permissions (matches the rest of BuhlOS):
//   admin       — full access (list all, edit, transfer anywhere, archive)
//   leadingHand — same surface as tradie (sees + transfers held assets);
//                 LH-level admin powers would be a future expansion
//   tradie      — sees ONLY the assets where currentHolderId === their id;
//                 can transfer something they currently hold to another
//                 tradie (or back to storage)
//   client      — 403 everywhere

const { readBlob, readBlobFresh, writeBlob, setNoCache } = require('./_lib/blob');
const { requireAuth, isAdminRole, isFieldRole, isLeadingHandRole, isDisabledUser } = require('./_lib/auth');
const { isFlagEnabled } = require('./_lib/feature-flags');
const { listAllAssets } = require('./_lib/assets');
const { sendPushToUserId } = require('./_lib/push');

const VALID_TYPES = ['vehicle', 'key', 'tool', 'accessory', 'ppe', 'other'];

// Who can HOLD an asset: field-tier (tradie/apprentice/labourer/electrician) or
// a leading hand — the people who actually carry gear on site. Admin-tier
// (admin/office/boss/pm/…), clients and unknown roles are never gear holders.
// Normalised via the role helpers, not literal strings.
function isAssignableHolderRole(role) {
  return isFieldRole(role) || isLeadingHandRole(role);
}

// #306: worker↔worker transfers are a HANDSHAKE — pending until the
// receiver accepts in Phil. Limbo guard: proposals auto-cancel after
// this many days (lazily, on the next read/action that touches the asset).
const PENDING_TRANSFER_DAYS = 5;

/** Clears an expired pending transfer IN PLACE; returns the history entry
 *  to append (caller writes), or null when nothing expired. */
function expirePendingIfDue(asset) {
  const p = asset && asset.pendingTransfer;
  if (!p || !p.expiresAt || p.expiresAt > new Date().toISOString()) return null;
  asset.pendingTransfer = null;
  asset.updatedAt = new Date().toISOString();
  return {
    id: newHistoryId(),
    kind: 'transfer_expired',
    from: asset.currentHolderId || null,
    to: p.toUserId || null,
    at: asset.updatedAt,
    byUserId: p.fromUserId || null,
    byRole: null,
    byName: 'system',
    note: `handover to ${p.toUserName || p.toUserId} expired unaccepted after ${PENDING_TRANSFER_DAYS} days`,
  };
}

function newAssetId() {
  return 'a_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function newHistoryId() {
  return 'h_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function sanitiseAsset(body, existing) {
  // Coerce + clamp inputs. Existing fields pass through if the caller
  // didn't supply them so PUT acts like a real patch.
  const next = existing ? { ...existing } : {};
  if (body.name !== undefined) {
    const t = String(body.name || '').trim().slice(0, 120);
    if (!t) return { error: 'name must be a non-empty string' };
    next.name = t;
  }
  if (body.type !== undefined) {
    if (!VALID_TYPES.includes(body.type)) return { error: 'type must be one of: ' + VALID_TYPES.join(', ') };
    next.type = body.type;
  }
  if (body.identifier !== undefined) next.identifier = String(body.identifier || '').trim().slice(0, 120) || null;
  if (body.notes      !== undefined) next.notes      = String(body.notes      || '').trim().slice(0, 2000) || null;
  if (body.expectedReturn !== undefined) {
    // ISO date or null. Null = open-ended.
    if (body.expectedReturn === null || body.expectedReturn === '') next.expectedReturn = null;
    else {
      const s = String(body.expectedReturn);
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return { error: 'expectedReturn must be an ISO date (YYYY-MM-DD) or null' };
      next.expectedReturn = s;
    }
  }

  // Phase 12 (brief §12): hired-gear fields. owned (default) vs hired,
  // hire end-date, day-rate ex-GST. Used by the dead-rent flag on
  // the admin assets register.
  if (body.ownership !== undefined) {
    if (body.ownership === '' || body.ownership === null) next.ownership = 'owned';
    else if (body.ownership !== 'owned' && body.ownership !== 'hired') {
      return { error: 'ownership must be "owned" or "hired"' };
    } else {
      next.ownership = body.ownership;
    }
  }
  if (body.hireEndDate !== undefined) {
    if (body.hireEndDate === null || body.hireEndDate === '') next.hireEndDate = null;
    else {
      const s = String(body.hireEndDate);
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return { error: 'hireEndDate must be an ISO date (YYYY-MM-DD) or null' };
      next.hireEndDate = s;
    }
  }
  if (body.hireRateExGst !== undefined) {
    if (body.hireRateExGst === null || body.hireRateExGst === '') next.hireRateExGst = null;
    else {
      const n = Number(body.hireRateExGst);
      if (!Number.isFinite(n) || n < 0) return { error: 'hireRateExGst must be a non-negative number' };
      next.hireRateExGst = Math.round(n * 100) / 100;
    }
  }
  if (body.hireSupplier !== undefined) next.hireSupplier = String(body.hireSupplier || '').trim().slice(0, 120) || null;

  // #305: optional calibration due-date for test instruments (AS/NZS 3760
  // loop). ISO date or null — null/absent means "not a calibrated
  // instrument"; the compliance computation skips it entirely.
  if (body.calibrationDue !== undefined) {
    if (body.calibrationDue === null || body.calibrationDue === '') next.calibrationDue = null;
    else {
      const s = String(body.calibrationDue);
      if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return { error: 'calibrationDue must be an ISO date (YYYY-MM-DD) or null' };
      next.calibrationDue = s;
    }
  }

  // Default ownership to 'owned' on new records so the dead-rent
  // calculator doesn't accidentally flag a missing field.
  if (existing && existing.ownership === undefined && next.ownership === undefined) {
    next.ownership = 'owned';
  }
  if (!existing && next.ownership === undefined) {
    next.ownership = 'owned';
  }

  return { asset: next };
}

// readAsset / readHistory bypass the 5-second in-memory cache in
// api/_lib/blob.js. Without this, an admin opening the drawer right after
// a Phil report (or vice versa) can hit a Vercel function instance whose
// cache predates the write and serve stale data — see BUG-C-004.
async function readAsset(id) {
  return await readBlobFresh('assets/' + id + '.json', null);
}
async function writeAsset(asset) {
  await writeBlob('assets/' + asset.id + '.json', asset);
}
async function readHistory(id) {
  return (await readBlobFresh('assets/' + id + '/history.json', { entries: [] })) || { entries: [] };
}
async function appendHistory(id, entry) {
  const log = await readHistory(id);
  log.entries = log.entries || [];
  log.entries.push(entry);
  await writeBlob('assets/' + id + '/history.json', log);
}

// listAllAssets (admin sees the full set; tradie filters down to their own)
// lives in ./_lib/assets — shared with the compliance loop (#305).

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await requireAuth(req, res);
  if (!user) return;
  // #760: gear is an owner kill-switch feature. When turned off, the whole
  // surface 404s (masking it) — same pattern as the register flags.
  if (!(await isFlagEnabled('gear', user))) return res.status(404).json({ error: 'not found' });
  // Gear is for admin-tier (manage all assets) and field-tier + leading hands
  // (their own held gear). Clients and any unknown role are denied outright —
  // normalised, not a literal `role === 'client'` check.
  if (!isAdminRole(user.role) && !isAssignableHolderRole(user.role)) {
    return res.status(403).json({ error: 'forbidden' });
  }

  // ── Transfer subroute — accepts POST with action=transfer or path-like
  //   ?transfer=1 / pathname ending in /transfer. We expose it as a query
  //   action since the rest of the API uses query-based routing.
  const action = (req.query && req.query.action) || '';

  // ── GET — list or single (with history) ─────────────────────────────
  if (req.method === 'GET') {
    const { id } = req.query || {};
    if (id) {
      const a = await readAsset(id);
      if (!a) return res.status(404).json({ error: 'not found' });
      // Visibility: admin sees all; tradie/LH sees only what they hold.
      if (
        !isAdminRole(user.role) &&
        a.currentHolderId !== user.id &&
        !(a.pendingTransfer && a.pendingTransfer.toUserId === user.id)
      ) {
        return res.status(403).json({ error: 'no access to this asset' });
      }
      const history = await readHistory(id);
      // Enrich history with user names so the UI doesn't need a second
      // round-trip just to display "Sam → Jack" rows. Cheap: one users.json
      // read per asset detail open.
      const usersBlob = await readBlob('users.json', { users: [] });
      const nameById = {};
      (usersBlob.users || []).forEach(u => { nameById[u.id] = u.username; });
      const enriched = (history.entries || []).map(e => ({
        ...e,
        fromName: e.from ? (nameById[e.from] || '(unknown user)') : 'Storage',
        toName:   e.to   ? (nameById[e.to]   || '(unknown user)') : 'Storage',
        byName:   e.byUserId ? (nameById[e.byUserId] || '(unknown user)') : '—',
      })).sort((x, y) => (y.at || '').localeCompare(x.at || '')); // newest first
      const holderName = a.currentHolderId ? (nameById[a.currentHolderId] || '(unknown user)') : null;
      return res.status(200).json({ asset: { ...a, currentHolderName: holderName }, history: enriched });
    }
    const all = (await listAllAssets()).filter(a => !a.archived || (req.query && req.query.archived === '1'));
    // Admin TIER (admin/office/boss/owner/manager/pm/estimator) sees the whole
    // register; field-tier + leading hands see only what they currently hold.
    // (Was a literal `role === 'admin'`, which hid the register from office/
    // boss/PM — the field-readiness audit's P1 Gear bug.)
    const visible = isAdminRole(user.role)
      ? all
      : all.filter(a =>
          a.currentHolderId === user.id ||
          (a.pendingTransfer && a.pendingTransfer.toUserId === user.id)
        );
    // Same name enrichment as single-asset for the list view.
    const usersBlob = await readBlob('users.json', { users: [] });
    const nameById = {};
    (usersBlob.users || []).forEach(u => { nameById[u.id] = u.username; });
    const enriched = visible.map(a => ({
      ...a,
      currentHolderName: a.currentHolderId ? (nameById[a.currentHolderId] || '(unknown user)') : null,
    }));
    return res.status(200).json({ assets: enriched });
  }

  // ── POST — create new asset OR transfer ────────────────────────────
  if (req.method === 'POST') {
    if (action === 'transfer') {
      const body = req.body || {};
      const { assetId, toUserId, expectedReturn, note } = body;
      if (!assetId) return res.status(400).json({ error: 'assetId required' });
      const a = await readAsset(assetId);
      if (!a) return res.status(404).json({ error: 'asset not found' });

      // Tradie/LH may only transfer something they currently hold.
      if (!isAdminRole(user.role)) {
        if (a.currentHolderId !== user.id) {
          return res.status(403).json({ error: "you can only transfer an asset you currently hold" });
        }
        // Destination must be a real tradie/LH (or null = back to storage).
        // Validated below.
      }

      // Resolve destination user if non-null (null = return to storage/depot).
      let toUser = null;
      if (toUserId) {
        const usersBlob = await readBlob('users.json', { users: [] });
        toUser = (usersBlob.users || []).find(u => u.id === toUserId);
        if (!toUser) return res.status(404).json({ error: 'destination user not found' });
        // Asset holders must be a field worker or leading hand — never an
        // admin/office/client/unknown user (they manage gear, they don't carry
        // it). Normalised, so office/boss/pm are correctly rejected as holders.
        if (!isAssignableHolderRole(toUser.role)) {
          return res.status(400).json({ error: 'asset holder must be a field worker or leading hand' });
        }
        if (isDisabledUser(toUser)) {
          return res.status(400).json({ error: 'cannot assign to a disabled or archived user' });
        }
      }

      const now = new Date().toISOString();
      // Validate expectedReturn shape
      let er = a.expectedReturn || null;
      if (expectedReturn !== undefined) {
        if (expectedReturn === null || expectedReturn === '') er = null;
        else if (/^\d{4}-\d{2}-\d{2}/.test(String(expectedReturn))) er = String(expectedReturn);
        else return res.status(400).json({ error: 'expectedReturn must be ISO date YYYY-MM-DD or null' });
      } else if (toUserId === null) {
        // Returning to storage clears the expected-return date.
        er = null;
      }

      const expiredEntry = expirePendingIfDue(a);
      if (expiredEntry) await appendHistory(assetId, expiredEntry);

      // #306: worker→worker is a handshake — the asset stays the
      // initiator's responsibility until the receiver accepts in Phil.
      // Admin-initiated moves and returns-to-storage stay INSTANT.
      if (!isAdminRole(user.role) && toUserId) {
        if (a.pendingTransfer) {
          return res.status(409).json({ error: 'a handover is already pending for this asset' });
        }
        const expiresAt = new Date(Date.now() + PENDING_TRANSFER_DAYS * 86400000).toISOString();
        a.pendingTransfer = {
          toUserId,
          toUserName: toUser.username,
          fromUserId: user.id,
          fromUserName: user.username,
          proposedAt: now,
          expiresAt,
          note: note ? String(note).trim().slice(0, 500) : null,
        };
        a.updatedAt = now;
        await writeAsset(a);
        await appendHistory(assetId, {
          id: newHistoryId(),
          kind: 'transfer_proposed',
          from: user.id,
          to: toUserId,
          at: now,
          byUserId: user.id,
          byRole: user.role,
          byName: user.username,
          note: note ? String(note).trim().slice(0, 500) : null,
        });
        try {
          await sendPushToUserId(toUserId, {
            title: `${user.username} wants to hand you gear`,
            body: `${a.name}${a.identifier ? ' · ' + a.identifier : ''} — accept or decline in your gear list.`,
            url: '/phil/gear',
            tag: 'buhl-gear-handover',
          });
        } catch {}
        return res.status(200).json({ asset: a });
      }

      // Instant path: an authoritative move voids any pending handover.
      if (a.pendingTransfer) {
        await appendHistory(assetId, {
          id: newHistoryId(),
          kind: 'transfer_declined',
          from: a.currentHolderId || null,
          to: a.pendingTransfer.toUserId || null,
          at: now,
          byUserId: user.id,
          byRole: user.role,
          byName: user.username,
          note: 'voided by an authoritative transfer',
        });
        a.pendingTransfer = null;
      }

      const prev = { from: a.currentHolderId || null, to: toUserId || null };
      a.currentHolderId = toUserId || null;
      a.assignedAt = toUserId ? now : null;
      a.expectedReturn = er;
      a.updatedAt = now;
      await writeAsset(a);
      await appendHistory(assetId, {
        id: newHistoryId(),
        from: prev.from,
        to:   prev.to,
        at:   now,
        byUserId: user.id,
        byRole:   user.role,
        byName:   user.username,
        note: note ? String(note).trim().slice(0, 500) : null,
      });
      return res.status(200).json({ asset: a });
    }

    // ── #306: ?action=transfer-response — receiver accepts/declines a
    //   pending handover. Accept flips the holder; decline reverts cleanly.
    if (action === 'transfer-response') {
      const body = req.body || {};
      const { assetId, accept } = body;
      if (!assetId) return res.status(400).json({ error: 'assetId required' });
      if (typeof accept !== 'boolean') return res.status(400).json({ error: 'accept must be true or false' });
      const a = await readAsset(assetId);
      if (!a) return res.status(404).json({ error: 'asset not found' });
      const expiredEntry = expirePendingIfDue(a);
      if (expiredEntry) {
        await writeAsset(a);
        await appendHistory(assetId, expiredEntry);
        return res.status(409).json({ error: 'this handover expired' });
      }
      const p = a.pendingTransfer;
      if (!p) return res.status(404).json({ error: 'no pending handover on this asset' });
      if (p.toUserId !== user.id) {
        return res.status(403).json({ error: 'only the receiving worker can respond to this handover' });
      }
      const now = new Date().toISOString();
      a.pendingTransfer = null;
      if (accept) {
        a.currentHolderId = user.id;
        a.assignedAt = now;
      }
      a.updatedAt = now;
      await writeAsset(a);
      await appendHistory(assetId, {
        id: newHistoryId(),
        kind: accept ? 'transfer_accepted' : 'transfer_declined',
        from: p.fromUserId || null,
        to: p.toUserId || null,
        at: now,
        byUserId: user.id,
        byRole: user.role,
        byName: user.username,
        note: null,
      });
      return res.status(200).json({ asset: a });
    }

    // ── #303: ?action=claim — a field worker claims an IN-STORAGE asset by
    //   scanning its printed QR label. This is the ONLY path that lets a field
    //   role move an unheld asset onto themselves (transfer requires you to
    //   already hold it, or to be admin). Scoped deliberately to storage:
    //   claiming an asset held by someone else must go through the #306
    //   handshake, never snatch.
    //
    //   Body: { assetId }
    //
    //   Gates (fail-closed, in order):
    //     - assignable holder role only (field-tier / leading hand). Admin-tier
    //       assigns via the register (office-vs-holder semantics), so admin is
    //       rejected here with a pointer to that flow; clients are already 403
    //       at the top gate.
    //     - not a disabled/archived user.
    //     - asset exists and is NOT archived (retired stock can't be claimed).
    //     - asset is in storage (currentHolderId == null) AND has no pending
    //       handover — else 409 pointing at the request-transfer path (#306).
    //   Integrity: the read is fresh (readAsset → readBlobFresh, BUG-C-004
    //   discipline) and we 409 if a holder appeared between the scan and the
    //   claim tap (two tradies, one drill, same moment). The history row is the
    //   SAME shape as a transfer ({ from:null, to:me }) so every existing
    //   consumer (admin drawer, Phil history, assignmentsFromHistory) reads it.
    if (action === 'claim') {
      if (isAdminRole(user.role)) {
        return res.status(403).json({
          error: 'admins assign gear from the register, not by claiming — use the office gear page',
        });
      }
      if (!isAssignableHolderRole(user.role)) {
        return res.status(403).json({ error: 'only field workers and leading hands can claim gear' });
      }
      if (isDisabledUser(user)) {
        return res.status(403).json({ error: 'your account can no longer hold gear — ask the office' });
      }
      const body = req.body || {};
      const { assetId } = body;
      if (!assetId) return res.status(400).json({ error: 'assetId required' });
      const a = await readAsset(assetId);
      if (!a) return res.status(404).json({ error: 'asset not found' });
      if (a.archived) return res.status(409).json({ error: 'this asset is no longer in service' });

      // Lazily clear an expired handover before deciding — a stale proposal
      // shouldn't block a claim once its 5-day window has passed.
      const expiredEntry = expirePendingIfDue(a);
      if (expiredEntry) {
        await writeAsset(a);
        await appendHistory(assetId, expiredEntry);
      }

      // Race + not-in-storage guard: if a holder appeared since the scan (or the
      // asset was never in storage), send the claimer to the #306 request path.
      if (a.currentHolderId) {
        const usersBlob = await readBlob('users.json', { users: [] });
        const holder = (usersBlob.users || []).find(u => u.id === a.currentHolderId);
        const holderName = holder ? holder.username : 'someone';
        if (a.currentHolderId === user.id) {
          // Idempotent: you already hold it (double-scan / double-tap).
          return res.status(200).json({ asset: a, alreadyMine: true });
        }
        return res.status(409).json({
          error: `${holderName} is holding this — ask for a transfer instead of claiming`,
          currentHolderId: a.currentHolderId,
          currentHolderName: holderName,
        });
      }
      if (a.pendingTransfer) {
        return res.status(409).json({
          error: 'a handover is already pending for this asset',
        });
      }

      const now = new Date().toISOString();
      a.currentHolderId = user.id;
      a.assignedAt = now;
      a.updatedAt = now;
      await writeAsset(a);
      await appendHistory(assetId, {
        id: newHistoryId(),
        kind: 'claim',
        from: null,
        to: user.id,
        at: now,
        byUserId: user.id,
        byRole: user.role,
        byName: user.username,
        note: 'claimed from storage via QR scan',
      });
      return res.status(200).json({ asset: a });
    }

    // ── #303: ?action=scan-info — the summary-only read the scan landing page
    //   needs BEFORE the worker decides to claim. The normal GET ?id= 403s a
    //   field worker who doesn't already hold the asset, so an in-storage tool
    //   is unreadable from the field — this endpoint fills that gap.
    //
    //   Body: { assetId }
    //
    //   Returns a DELIBERATELY NARROW summary (id / name / type / identifier /
    //   status / holder display name) — never the full detail payload or the
    //   transfer history — for assignable-holder roles. Admin-tier is allowed
    //   too (so admins can eyeball a sticker), but the shape is identical.
    //   Archived assets return status:'retired' honestly (not 404) so the page
    //   can say "no longer in service" rather than a bare not-found.
    if (action === 'scan-info') {
      // Only gear holders (+ admin-tier) reach the API at all (top gate). No
      // extra role narrowing here — the payload is holder-safe by construction.
      const body = req.body || {};
      const { assetId } = body;
      if (!assetId) return res.status(400).json({ error: 'assetId required' });
      const a = await readAsset(assetId);
      if (!a) return res.status(404).json({ error: 'not found' });

      let holderName = null;
      if (a.currentHolderId) {
        const usersBlob = await readBlob('users.json', { users: [] });
        const holder = (usersBlob.users || []).find(u => u.id === a.currentHolderId);
        holderName = holder ? holder.username : '(unknown user)';
      }
      // Derived status mirrors src/domains/gear/service.ts deriveStatus():
      // archived > condition > holder presence.
      let status = 'available';
      if (a.archived === true) status = 'retired';
      else if (a.condition === 'damaged') status = 'damaged';
      else if (a.condition === 'missing') status = 'missing';
      else if (a.currentHolderId) status = 'assigned';

      return res.status(200).json({
        asset: {
          id: a.id,
          name: a.name,
          type: a.type,
          identifier: a.identifier || null,
          status,
          archived: a.archived === true,
          condition: a.condition || 'good',
          currentHolderId: a.currentHolderId || null,
          currentHolderName: holderName,
          heldByMe: a.currentHolderId === user.id,
          pendingTransfer: a.pendingTransfer
            ? { toUserId: a.pendingTransfer.toUserId, toUserName: a.pendingTransfer.toUserName || null }
            : null,
        },
      });
    }

    // ── Phase C hardening: ?action=mark-good — admin clears a damaged /
    //   missing condition after the asset has been repaired or recovered.
    //   Workers are not allowed to do this (would let a tradie hide a
    //   damage flag); the report endpoint is one-way for them.
    //
    //   Body: { assetId, note? }
    //
    //   Mutations on the asset record:
    //     condition           → 'good'
    //     lastConditionAt/By  → now, admin
    //   History gets a `kind: 'admin_updated'` entry so the action log
    //   shows the admin reset distinct from worker reports.
    if (action === 'mark-good') {
      if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });
      const body = req.body || {};
      const { assetId, note } = body;
      if (!assetId) return res.status(400).json({ error: 'assetId required' });
      const a = await readAsset(assetId);
      if (!a) return res.status(404).json({ error: 'asset not found' });
      const cleanNote = note ? String(note).trim().slice(0, 500) : null;
      const now = new Date().toISOString();
      a.condition = 'good';
      a.lastConditionAt = now;
      a.lastConditionBy = user.id;
      a.updatedAt = now;
      await writeAsset(a);
      await appendHistory(assetId, {
        id: newHistoryId(),
        kind: 'admin_updated',
        at: now,
        byUserId: user.id,
        byRole: user.role,
        byName: user.username,
        note: cleanNote,
        condition: 'good',
      });
      return res.status(200).json({ asset: a });
    }

    // ── Phase C addition: ?action=report — worker check / condition report.
    //   Records a possession confirmation ("check") or a condition flag
    //   ("damaged" / "missing"). Workers may only report on gear they hold;
    //   admin may report on anything. Always appends a history entry with
    //   `kind` set, so the action log discriminates reports from transfers.
    //
    //   Body: { assetId, kind: 'check'|'damaged'|'missing', note? }
    //
    //   Mutations on the asset record (all optional fields — old readers
    //   ignore them and continue to work unchanged):
    //     check    → lastCheckedAt + lastCheckedBy (condition untouched)
    //     damaged  → condition='damaged' + lastConditionAt + lastConditionBy
    //     missing  → condition='missing' + lastConditionAt + lastConditionBy
    if (action === 'report') {
      const body = req.body || {};
      const { assetId, kind, note } = body;
      if (!assetId) return res.status(400).json({ error: 'assetId required' });
      if (kind !== 'check' && kind !== 'damaged' && kind !== 'missing') {
        return res.status(400).json({ error: 'kind must be one of: check, damaged, missing' });
      }
      const a = await readAsset(assetId);
      if (!a) return res.status(404).json({ error: 'asset not found' });
      // Worker may only report on assets they currently hold. Admin sees all.
      if (!isAdminRole(user.role) && a.currentHolderId !== user.id) {
        return res.status(403).json({ error: 'you can only report on an asset you currently hold' });
      }
      const cleanNote = note ? String(note).trim().slice(0, 500) : null;
      const now = new Date().toISOString();
      if (kind === 'check') {
        a.lastCheckedAt = now;
        a.lastCheckedBy = user.id;
      } else {
        a.condition = kind; // 'damaged' | 'missing'
        a.lastConditionAt = now;
        a.lastConditionBy = user.id;
      }
      a.updatedAt = now;
      await writeAsset(a);
      await appendHistory(assetId, {
        id: newHistoryId(),
        kind: kind === 'check' ? 'check' : (kind === 'damaged' ? 'report_damaged' : 'report_missing'),
        at: now,
        byUserId: user.id,
        byRole: user.role,
        byName: user.username,
        note: cleanNote,
        condition: kind === 'check' ? undefined : kind,
      });
      return res.status(200).json({ asset: a });
    }

    // Create new asset — admin only
    if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });
    const body = req.body || {};
    if (!body.name || !String(body.name).trim()) return res.status(400).json({ error: 'name required' });
    if (!body.type || !VALID_TYPES.includes(body.type)) {
      return res.status(400).json({ error: 'type required (one of: ' + VALID_TYPES.join(', ') + ')' });
    }
    const parsed = sanitiseAsset(body, {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    // If creating-and-assigning in one move, the holder must be a real field
    // worker or leading hand (same rule as transfer) — never admin/office/
    // client/unknown, and never a disabled/archived user.
    if (body.currentHolderId) {
      const usersBlob = await readBlob('users.json', { users: [] });
      const holder = (usersBlob.users || []).find(u => u.id === body.currentHolderId);
      if (!holder) return res.status(404).json({ error: 'destination user not found' });
      if (!isAssignableHolderRole(holder.role)) {
        return res.status(400).json({ error: 'asset holder must be a field worker or leading hand' });
      }
      if (isDisabledUser(holder)) {
        return res.status(400).json({ error: 'cannot assign to a disabled or archived user' });
      }
    }
    const now = new Date().toISOString();
    const asset = {
      id: newAssetId(),
      name: parsed.asset.name,
      type: parsed.asset.type,
      identifier: parsed.asset.identifier || null,
      notes: parsed.asset.notes || null,
      // Admin can create-and-assign in one move by passing currentHolderId.
      // Otherwise the asset is in storage (currentHolderId = null).
      currentHolderId: body.currentHolderId || null,
      assignedAt: body.currentHolderId ? now : null,
      expectedReturn: parsed.asset.expectedReturn || null,
      calibrationDue: parsed.asset.calibrationDue || null,
      // #394: persist everything sanitiseAsset accepted — create and edit
      // must never disagree about which metadata exists. ownership defaults
      // 'owned' inside sanitiseAsset.
      ownership: parsed.asset.ownership,
      hireEndDate: parsed.asset.hireEndDate ?? null,
      hireRateExGst: parsed.asset.hireRateExGst ?? null,
      hireSupplier: parsed.asset.hireSupplier ?? null,
      archived: false,
      createdAt: now,
      updatedAt: now,
      createdBy: user.id,
    };
    await writeAsset(asset);
    if (asset.currentHolderId) {
      await appendHistory(asset.id, {
        id: newHistoryId(),
        from: null,
        to:   asset.currentHolderId,
        at:   now,
        byUserId: user.id,
        byRole:   user.role,
        byName:   user.username,
        note: 'created and assigned',
      });
    }
    return res.status(201).json({ asset });
  }

  // ── PUT — edit metadata (admin only). Holder changes go via transfer.
  if (req.method === 'PUT') {
    if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });
    const id = (req.query && req.query.id) || '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const existing = await readAsset(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    const body = req.body || {};
    // Block currentHolderId on PUT — must use transfer so the audit log
    // is always populated. If the admin wants to change the holder, they
    // do it through POST ?action=transfer.
    if (body.currentHolderId !== undefined && body.currentHolderId !== existing.currentHolderId) {
      return res.status(400).json({ error: 'use POST ?action=transfer to change the holder' });
    }
    const parsed = sanitiseAsset(body, existing);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const next = { ...parsed.asset, updatedAt: new Date().toISOString() };
    await writeAsset(next);
    return res.status(200).json({ asset: next });
  }

  // ── DELETE — soft-delete (admin only). Sets archived:true; record + history kept.
  if (req.method === 'DELETE') {
    if (!isAdminRole(user.role)) return res.status(403).json({ error: 'admin only' });
    const id = (req.query && req.query.id) || '';
    if (!id) return res.status(400).json({ error: 'id required' });
    const existing = await readAsset(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    existing.archived = true;
    existing.updatedAt = new Date().toISOString();
    await writeAsset(existing);
    return res.status(200).json({ asset: existing });
  }

  return res.status(405).json({ error: 'method not allowed' });
};
