// ╔════════════════════════════════════════════════════════════════════╗
// ║  sync.js — minimal event bus for offline / write-queue state.      ║
// ║                                                                    ║
// ║  Per brief §17 + the prompt's mobile constraints: "every mutating  ║
// ║  call goes through an IndexedDB queue. <buhl-mark> reflects state  ║
// ║  (idle / pulsing / offline / failed)."                             ║
// ║                                                                    ║
// ║  This module is the wire between the queue and any UI that wants   ║
// ║  to display sync state. The actual IndexedDB queue lives in a      ║
// ║  follow-up phase — for now this is a tiny pub/sub that <buhl-mark> ║
// ║  and any future indicator can subscribe to. API helpers will fire  ║
// ║  Sync.pulse() / Sync.fail() / Sync.offline() / Sync.idle() as      ║
// ║  they make calls.                                                  ║
// ║                                                                    ║
// ║  USAGE                                                             ║
// ║    import { Sync } from '/components/sync.js';                     ║
// ║    Sync.pulse();          // mark transmitting                     ║
// ║    Sync.fail('reason');   // last attempt failed                   ║
// ║    Sync.idle();           // back to quiet                         ║
// ║                                                                    ║
// ║    const off = Sync.subscribe(state => updateUI(state));           ║
// ║    off();                 // unsubscribe                           ║
// ╚════════════════════════════════════════════════════════════════════╝

const BUS_KEY = '__buhl_sync__';
const bus = window[BUS_KEY] || (window[BUS_KEY] = {
  state: 'idle', // idle | pulsing | offline | failed
  reason: null,
  listeners: new Set(),
});

function emit() {
  const snap = { state: bus.state, reason: bus.reason };
  bus.listeners.forEach(fn => { try { fn(snap); } catch (e) { /* swallow */ } });
}

function setState(state, reason = null) {
  if (bus.state === state && bus.reason === reason) return;
  bus.state = state;
  bus.reason = reason;
  emit();
}

// Pulse briefly; auto-return to idle if no further pulse arrives.
let pulseTimer = null;
function pulse() {
  setState('pulsing');
  clearTimeout(pulseTimer);
  pulseTimer = setTimeout(() => {
    if (bus.state === 'pulsing') setState('idle');
  }, 700);
}

// React to browser online/offline events.
if (typeof window !== 'undefined') {
  window.addEventListener('online',  () => { if (bus.state === 'offline') setState('idle'); });
  window.addEventListener('offline', () => setState('offline'));
  if (!navigator.onLine) bus.state = 'offline';
}

export const Sync = {
  pulse,
  idle:    () => setState('idle'),
  offline: () => setState('offline'),
  fail:    (reason) => setState('failed', reason || null),
  subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    bus.listeners.add(fn);
    // Fire current state immediately so subscribers don't render stale.
    try { fn({ state: bus.state, reason: bus.reason }); } catch {}
    return () => bus.listeners.delete(fn);
  },
  current() { return { state: bus.state, reason: bus.reason }; },
};
