// POST /api/client-errors — the client error-boundary report sink (#154).
//
// src/app/error.tsx fires a best-effort report here when a Next.js page
// crashes. Accepts { message, stack, digest, url }. Always 202 on accepted
// input — the client never retries or blocks on this.
//
// Auth is OPTIONAL by design: a pre-login crash must still be visible. An
// authenticated report keeps its stack/digest/url and is attributed to the
// user; an anonymous report is hard-capped (message ≤ 300 chars, no stack,
// no metadata) so the open endpoint can't be used to stuff the journal.
// Abuse guard: any body over ~4 KB is rejected outright.

const { setNoCache } = require('./_lib/blob');
const { getCurrentUser } = require('./_lib/auth');
const { appendError, STACK_CAP } = require('./_lib/error-log');

const MAX_BODY_BYTES = 4096;
const ANON_MESSAGE_CAP = 300;

module.exports = async (req, res) => {
  setNoCache(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  let size = 0;
  try {
    size = JSON.stringify(body).length;
  } catch {
    size = MAX_BODY_BYTES + 1;
  }
  if (size > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'payload too large' });
  }

  // Optional identity — never 401s. A broken session degrades to anonymous.
  let user = null;
  try {
    user = await getCurrentUser(req);
  } catch {
    user = null;
  }

  const rawMessage = String(body.message || '').trim();
  if (rawMessage) {
    const url = String(body.url || '').slice(0, 200);
    const digest = String(body.digest || '').slice(0, 64);
    await appendError({
      source: 'client',
      // Group by page path — the client analogue of an api handler name.
      handler: url ? `page:${url}` : 'page:unknown',
      message: user ? rawMessage : rawMessage.slice(0, ANON_MESSAGE_CAP),
      severity: 'error',
      statusCode: null,
      stack: user && body.stack ? String(body.stack).slice(0, STACK_CAP) : null,
      userId: user ? user.id : null,
      ...(user && digest ? { metadata: { digest } } : {}),
    });
  }

  // 202 whether or not anything was recorded — the boundary must never see
  // a failure it might surface or retry on.
  return res.status(202).json({ ok: true });
};
