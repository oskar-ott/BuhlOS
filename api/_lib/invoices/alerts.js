'use strict';

// Mid-week alerts (owner direction 2026-09-23: "no alarm between Mondays").
// The 15-minute sweep evaluates a health snapshot and, when something needs a
// person, emails the accounts recipient list — at most once a day per
// condition set, so a broken key on Tuesday is known on Tuesday and a quiet
// week is not fifty emails. Pure functions here; the sweep does the I/O.

const DAY_MS = 86_400_000;

/**
 * @param {{ failedCount: number, stuckCount: number, quarantinedOldCount: number, forwardFailedCount: number,
 *           lastReceivedAt: string|null, everReceived: boolean }} snap
 * @param {{ quietDays: number, providerAuthFailed: boolean, now?: number }} opts
 * @returns {Array<{ code: string, text: string }>}
 */
function evaluateAlerts(snap, opts) {
  const now = opts.now == null ? Date.now() : opts.now;
  const out = [];
  if (opts.providerAuthFailed) {
    out.push({ code: 'provider_auth', text: 'BuhlOS can no longer read email from Resend — the API key was rejected. Emails are still arriving but nothing is captured until RESEND_API_KEY is fixed in Vercel.' });
  }
  if (snap.failedCount > 0) {
    out.push({ code: 'failed', text: `${snap.failedCount} document${snap.failedCount === 1 ? '' : 's'} could not be read after three attempts — open the inbox, Failed filter, and re-read or enter by hand.` });
  }
  if (snap.stuckCount > 0) {
    out.push({ code: 'stuck', text: `${snap.stuckCount} document${snap.stuckCount === 1 ? ' has' : 's have'} waited more than two hours to be read — the reading step may be failing.` });
  }
  if (snap.quarantinedOldCount > 0) {
    out.push({ code: 'quarantined', text: `${snap.quarantinedOldCount} email${snap.quarantinedOldCount === 1 ? '' : 's'} received while the feature was off ${snap.quarantinedOldCount === 1 ? 'has' : 'have'} not been picked up for over a day.` });
  }
  if (snap.forwardFailedCount > 0) {
    out.push({ code: 'forward_failed', text: `${snap.forwardFailedCount} repl${snap.forwardFailedCount === 1 ? 'y' : 'ies'} to an office address could not be forwarded in the last day — check the sender address and the email provider.` });
  }
  const quietDays = Number(opts.quietDays);
  if (Number.isFinite(quietDays) && quietDays > 0 && snap.everReceived && snap.lastReceivedAt) {
    const age = now - Date.parse(snap.lastReceivedAt);
    if (age >= quietDays * DAY_MS) {
      const days = Math.floor(age / DAY_MS);
      out.push({ code: 'quiet', text: `No supplier email has arrived for ${days} days (last on ${new Date(snap.lastReceivedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'Australia/Sydney' })}). Check the mailbox forwarding rule and the Resend webhook.` });
    }
  }
  return out;
}

/** Stable identity of a condition set — the rate limit keys on it. Pure. */
function alertKey(conditions) {
  return conditions.map((c) => c.code).sort().join(',');
}

/** Send when there is something to say and it is new, or a day has passed. Pure. */
function shouldSend(state, key, now) {
  if (!key) return false;
  const prevKey = state && state.key ? state.key : '';
  const sentAt = state && state.sentAt ? Date.parse(state.sentAt) : NaN;
  if (prevKey !== key) return true;
  return !Number.isFinite(sentAt) || now - sentAt >= DAY_MS;
}

function buildAlertEmail(conditions, { inboxUrl }) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const n = conditions.length;
  const subject = `BuhlOS invoices need attention — ${n} thing${n === 1 ? '' : 's'} to look at`;
  const text = [`${n} thing${n === 1 ? '' : 's'} on the supplier-invoice inbox need${n === 1 ? 's' : ''} a person:`, '', ...conditions.map((c) => `• ${c.text}`), '', `Inbox: ${inboxUrl}`, '', 'You get one of these a day at most while something is wrong; the Monday digest covers the rest.'].join('\n');
  const html = `<p>${n} thing${n === 1 ? '' : 's'} on the supplier-invoice inbox need${n === 1 ? 's' : ''} a person:</p><ul>${conditions.map((c) => `<li>${esc(c.text)}</li>`).join('')}</ul><p><a href="${esc(inboxUrl)}">Open the inbox</a></p><p style="color:#777;font-size:12px">You get one of these a day at most while something is wrong; the Monday digest covers the rest.</p>`;
  return { subject, text, html };
}

module.exports = { evaluateAlerts, alertKey, shouldSend, buildAlertEmail, DAY_MS };
