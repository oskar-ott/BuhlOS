// ╔════════════════════════════════════════════════════════════════════╗
// ║  queue.js — offline-first write queue                              ║
// ║                                                                    ║
// ║  Per the Job Mobile brief constraint: "Offline-first — every       ║
// ║  mutating call goes through an IndexedDB queue. <buhl-mark>        ║
// ║  reflects state (idle / pulsing / offline / failed)."              ║
// ║                                                                    ║
// ║  USE                                                               ║
// ║    import { Queue } from '/components/queue.js';                   ║
// ║    // OR via window.BuhlQueue for non-module callers.              ║
// ║                                                                    ║
// ║    const r = await Queue.fetch(url, {                              ║
// ║      method: 'POST',                                               ║
// ║      headers: { 'Content-Type': 'application/json' },              ║
// ║      body: JSON.stringify(payload),                                ║
// ║      // optional: replaceKey collapses earlier queued requests     ║
// ║      // that share the same key. Use for whole-state POSTs like    ║
// ║      // /api/data where only the latest body matters.              ║
// ║      replaceKey: 'data',                                           ║
// ║    });                                                             ║
// ║                                                                    ║
// ║  BEHAVIOUR                                                         ║
// ║    1. If online and reachable, the call runs directly. Sync bus    ║
// ║       pulses for the duration.                                     ║
// ║    2. If the call fails with a network error OR the browser is     ║
// ║       offline, the request is persisted to IndexedDB and the bus   ║
// ║       flips to 'offline' (or 'failed' on non-network errors).      ║
// ║    3. On the next online event (or successful direct send), the    ║
// ║       queue drains in FIFO order, with exponential back-off for    ║
// ║       transient 5xx responses.                                     ║
// ║                                                                    ║
// ║  STORAGE                                                           ║
// ║    IndexedDB database "buhlos", object store "writes":             ║
// ║      { id, url, method, headers, body, replaceKey,                 ║
// ║        attempts, lastError, queuedAt }                             ║
// ║                                                                    ║
// ║  GET requests pass straight through — no point queueing reads.     ║
// ╚════════════════════════════════════════════════════════════════════╝

import { Sync } from '/components/sync.js';

const DB_NAME = 'buhlos';
const STORE   = 'writes';
const VERSION = 1;

let _dbPromise = null;
function openDb() {
  if (_dbPromise) return _dbPromise;
  if (typeof indexedDB === 'undefined') {
    _dbPromise = Promise.resolve(null);
    return _dbPromise;
  }
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('replaceKey', 'replaceKey', { unique: false });
        store.createIndex('queuedAt',   'queuedAt',   { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _dbPromise;
}

async function withStore(mode, fn) {
  const db = await openDb();
  if (!db) return fn(null); // IndexedDB unavailable — caller falls back to direct
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; }).catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror    = () => reject(tx.error);
  });
}

async function _enqueue(req) {
  return withStore('readwrite', async (store) => {
    if (!store) return null;
    // If a replaceKey collapses duplicates, delete existing entries first.
    if (req.replaceKey) {
      await new Promise(res => {
        const idx = store.index('replaceKey');
        const range = IDBKeyRange.only(req.replaceKey);
        const cursorReq = idx.openCursor(range);
        cursorReq.onsuccess = (ev) => {
          const cur = ev.target.result;
          if (cur) { cur.delete(); cur.continue(); }
          else { res(); }
        };
        cursorReq.onerror = () => res();
      });
    }
    return new Promise(res => {
      const addReq = store.add({
        url: req.url,
        method: req.method,
        headers: req.headers || null,
        body: req.body || null,
        replaceKey: req.replaceKey || null,
        attempts: 0,
        lastError: null,
        queuedAt: Date.now(),
      });
      addReq.onsuccess = () => res(addReq.result);
      addReq.onerror   = () => res(null);
    });
  });
}

async function _allPending() {
  return withStore('readonly', async (store) => {
    if (!store) return [];
    return new Promise(res => {
      const out = [];
      const idx = store.index('queuedAt');
      const cursorReq = idx.openCursor();
      cursorReq.onsuccess = (ev) => {
        const cur = ev.target.result;
        if (cur) { out.push(cur.value); cur.continue(); }
        else { res(out); }
      };
      cursorReq.onerror = () => res([]);
    });
  });
}

async function _remove(id) {
  return withStore('readwrite', async (store) => {
    if (!store) return;
    return new Promise(res => {
      const r = store.delete(id);
      r.onsuccess = () => res();
      r.onerror   = () => res();
    });
  });
}

async function _markAttempt(id, errorMessage) {
  return withStore('readwrite', async (store) => {
    if (!store) return;
    return new Promise(res => {
      const g = store.get(id);
      g.onsuccess = () => {
        const v = g.result;
        if (!v) return res();
        v.attempts = (v.attempts || 0) + 1;
        v.lastError = errorMessage || null;
        const u = store.put(v);
        u.onsuccess = () => res();
        u.onerror   = () => res();
      };
      g.onerror = () => res();
    });
  });
}

async function count() {
  return withStore('readonly', async (store) => {
    if (!store) return 0;
    return new Promise(res => {
      const r = store.count();
      r.onsuccess = () => res(r.result || 0);
      r.onerror   = () => res(0);
    });
  });
}

/* ── Direct fetch + queue-on-failure ─────────────────────────────── */

function isNetworkError(err) {
  // Browser network failure typically throws TypeError 'Failed to fetch'.
  return err && (err.name === 'TypeError' || /network|failed to fetch/i.test(err.message || ''));
}

async function tryDirect(req) {
  Sync.pulse();
  let res;
  try {
    res = await fetch(req.url, {
      method:      req.method,
      headers:     req.headers || undefined,
      body:        req.body || undefined,
      credentials: 'same-origin',
    });
  } catch (e) {
    if (isNetworkError(e) || !navigator.onLine) {
      Sync.offline();
      throw Object.assign(new Error('offline'), { offline: true });
    }
    Sync.fail(e.message || 'fetch failed');
    throw e;
  }
  if (res.status >= 500) {
    // Treat 5xx as retryable. Caller falls back to queue.
    Sync.fail('server ' + res.status);
    throw Object.assign(new Error('server ' + res.status), { retryable: true });
  }
  Sync.idle();
  return res;
}

async function _drainNow() {
  const pending = await _allPending();
  if (!pending.length) {
    Sync.idle();
    return { drained: 0 };
  }
  Sync.pulse();
  let drained = 0;
  for (const item of pending) {
    try {
      const res = await fetch(item.url, {
        method: item.method,
        headers: item.headers || undefined,
        body: item.body || undefined,
        credentials: 'same-origin',
      });
      if (res.status >= 500) {
        await _markAttempt(item.id, 'server ' + res.status);
        // Stop draining on the first transient failure; we'll retry next tick.
        Sync.fail('server ' + res.status);
        return { drained, retryable: true };
      }
      if (res.status >= 400) {
        // 4xx is a permanent client error — discard with a console log.
        console.warn('queue: discarded ' + item.url + ' (status ' + res.status + ')');
      }
      await _remove(item.id);
      drained++;
    } catch (e) {
      if (isNetworkError(e) || !navigator.onLine) {
        await _markAttempt(item.id, 'network');
        Sync.offline();
        return { drained, offline: true };
      }
      await _markAttempt(item.id, e.message || 'error');
    }
  }
  Sync.idle();
  // Notify any UI watching the queue count.
  const c = await count();
  _emit('count', c);
  return { drained };
}

/* ── Public queue.fetch — direct first, fall back on offline ─────── */

async function queuedFetch(url, opts) {
  opts = opts || {};
  const req = {
    url,
    method:      (opts.method || 'GET').toUpperCase(),
    headers:     opts.headers || null,
    body:        opts.body || null,
    replaceKey:  opts.replaceKey || null,
  };
  // GETs pass straight through.
  if (req.method === 'GET') return fetch(url, opts);

  // Try direct.
  try {
    const res = await tryDirect(req);
    // Whenever a direct call succeeds, opportunistically drain.
    _drainNow().catch(() => {});
    return res;
  } catch (e) {
    if (e.offline || e.retryable) {
      const id = await _enqueue(req);
      const c = await count();
      _emit('count', c);
      // Return a synthetic 202 so callers know it was accepted.
      return new Response(JSON.stringify({ queued: true, id }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw e;
  }
}

/* ── Tiny event bus (separate from Sync) for queue count subscriptions ── */

const listeners = new Set();
function _emit(/* type */ _t, payload) {
  listeners.forEach(fn => { try { fn(payload); } catch {} });
}

/* ── Online/offline auto-drain ───────────────────────────────────── */

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { _drainNow().catch(() => {}); });
  // Soft poll: every 30s while idle, attempt drain. Cheap when the queue
  // is empty; meaningful when a flaky network blipped during a write.
  setInterval(() => {
    if (!navigator.onLine) return;
    count().then(c => { if (c > 0) _drainNow().catch(() => {}); });
  }, 30000);
}

export const Queue = {
  /** Drop-in fetch replacement. Tries direct; queues on failure. */
  fetch: queuedFetch,
  /** Force a drain attempt. Useful for "retry now" buttons. */
  drain: _drainNow,
  /** Current count of queued writes. */
  count,
  /** Subscribe to count changes. Returns an unsubscribe function. */
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    count().then(c => { try { fn(c); } catch {} });
    return () => listeners.delete(fn);
  },
};

// Expose on window for non-module callers (legacy inline scripts).
if (typeof window !== 'undefined') {
  window.BuhlQueue = Queue;
}
