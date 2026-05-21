/* ╔══════════════════════════════════════════════════════════════════╗
   ║  BuhlOS site office — shared shell JS.                           ║
   ║                                                                  ║
   ║  Each /admin/<page>.html does:                                   ║
   ║    1. <link rel="stylesheet" href="/admin/_shell.css">           ║
   ║    2. <script src="/admin/_shell.js"></script>                   ║
   ║    3. defines window.PAGE = { id, title, render }                ║
   ║    4. calls SHELL.boot()                                         ║
   ║                                                                  ║
   ║  Boot does the auth gate, fetches sidebar counts (jobs +         ║
   ║  pending hours + open snags), renders sidebar + topbar, calls    ║
   ║  PAGE.render() once it's in the DOM.                             ║
   ╚══════════════════════════════════════════════════════════════════╝ */

(function () {
  'use strict';

  /* ── Tweaks (theme/density) — persisted in localStorage ──
     Phase 02: dropped the .accent picker. Admin-amber is forbidden
     (brief §17). The single yellow lives in tokens; rotating it
     defeats the "one yellow per screen" rule. Density names match
     buhlos-admin.css: compact / regular / roomy. Legacy values
     ('default') migrate to 'regular' on load. */
  const TWEAK_KEY = 'buhl-site-office-tweaks';
  const TWEAK_DEFAULTS = { theme: 'light', density: 'regular' };
  let tweaks = (() => {
    try {
      const stored = JSON.parse(localStorage.getItem(TWEAK_KEY) || '{}');
      // Migrate legacy density values.
      if (stored.density === 'default' || stored.density == null) stored.density = 'regular';
      // Drop legacy .accent if present — yellow is now token-driven.
      if (stored.accent) delete stored.accent;
      return Object.assign({}, TWEAK_DEFAULTS, stored);
    }
    catch { return { ...TWEAK_DEFAULTS }; }
  })();
  function applyTweaks() {
    document.documentElement.dataset.density = tweaks.density;
    document.documentElement.dataset.theme   = tweaks.theme;
  }
  function setTweak(k, v) {
    tweaks[k] = v;
    applyTweaks();
    try { localStorage.setItem(TWEAK_KEY, JSON.stringify(tweaks)); } catch {}
    if (tweakOpen) renderTweaksPanel();
    // Repaint the density toggle if the topbar is up.
    paintDensityToggle();
  }
  applyTweaks();
  let tweakOpen = false;

  /* ── Helpers ───────────────────────────────────────────── */
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function initials(s) {
    return s ? s.split(/[\s._-]+/).filter(Boolean).slice(0,2).map(w => w[0]).join('').toUpperCase() : '?';
  }
  function pluralize(n, w, p) { return n === 1 ? `${n} ${w}` : `${n} ${p || w + 's'}`; }
  function _iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function _ago(iso) {
    if (!iso) return '—';
    const d = new Date(iso); if (isNaN(d)) return '—';
    const s = Math.max(1, Math.floor((Date.now() - d) / 1000));
    if (s < 60)        return 'just now';
    if (s < 3600)      return Math.floor(s / 60) + ' min ago';
    if (s < 86400)     return Math.floor(s / 3600) + ' hr ago';
    if (s < 86400 * 7) return Math.floor(s / 86400) + 'd ago';
    return d.toLocaleDateString('en-AU', { day:'numeric', month:'short' });
  }
  function isoWeekMonday() {
    const d = new Date();
    const dow = d.getDay() || 7;
    if (dow !== 1) d.setDate(d.getDate() - (dow - 1));
    d.setHours(0,0,0,0);
    return d;
  }
  function fmtMoney(n) { return '$' + Number(n||0).toLocaleString('en-AU', { maximumFractionDigits: 0 }); }
  function fmtMoney2(n) { return '$' + Number(n||0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function toast(msg, kind) {
    $$('.toast').forEach(t => t.remove());
    const t = document.createElement('div');
    t.className = 'toast' + (kind ? ' ' + kind : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2400);
  }
  async function api(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    const r = await fetch(url, opts);
    let body = null;
    try { body = await r.json(); } catch {}
    if (!r.ok) {
      const e = new Error((body && body.error) || ('HTTP ' + r.status));
      e.status = r.status; e.body = body;
      throw e;
    }
    return body;
  }

  /* ── Status pills ──────────────────────────────────────── */
  function jobStatusPill(s) {
    if (s === 'active')   return `<span class="pill pill-info"><span class="pill-dot"></span>Active</span>`;
    if (s === 'paused')   return `<span class="pill pill-warn"><span class="pill-dot"></span>Paused</span>`;
    if (s === 'complete') return `<span class="pill pill-ok"><span class="pill-dot"></span>Complete</span>`;
    if (s === 'archived') return `<span class="pill"><span class="pill-dot"></span>Archived</span>`;
    return `<span class="pill">${escapeHtml(s)}</span>`;
  }
  function rolePill(r) {
    const lbl = r === 'leadingHand' ? 'Leading hand' : (r ? r[0].toUpperCase() + r.slice(1) : 'Unknown');
    return `<span class="pill pill-${r}"><span class="pill-dot"></span>${lbl}</span>`;
  }
  function bar(pct, color) {
    const p = Math.max(0, Math.min(100, Number(pct) || 0));
    const c = color || (p >= 100 ? 'var(--ok)' : p >= 50 ? 'var(--accent)' : 'var(--info)');
    return `<div class="bar"><div class="bar-fill" style="width:${p}%;background:${c}"></div></div>`;
  }

  /* ── Icons (inline SVG, currentColor) ──────────────────── */
  const ICONS = {
    today:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    approval:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>',
    snag:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16v.5"/></svg>',
    jobs:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="18" height="14" rx="2"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/></svg>',
    quote:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>',
    hours:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>',
    crew:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 15c2-.5 5.5.7 5.5 4"/></svg>',
    suppliers:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/></svg>',
    temp:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
    settings:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    field:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V8l8-5 8 5v12"/><path d="M9 20v-6h6v6"/></svg>',
    search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5"/></svg>',
    plus:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    external:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/></svg>',
    more:'<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>',
    bell:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2H4.5L6 16z"/><path d="M10 20a2 2 0 0 0 4 0"/></svg>',
    download:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12m0 0l-4-4m4 4l4-4"/><path d="M4 20h16"/></svg>',
    check:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4L19 7"/></svg>',
    x:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    edit:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10-10-4-4L4 16v4z"/><path d="M14 6l4 4"/></svg>',
    warn:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l10 17H2L12 3z"/><path d="M12 10v4M12 17v.5"/></svg>',
    arrow:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
    trash:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    tweaks:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="7" r="2"/><path d="M8 7h12M3 7h1"/><circle cx="18" cy="12" r="2"/><path d="M3 12h13M20 12h1"/><circle cx="9" cy="17" r="2"/><path d="M3 17h4M11 17h10"/></svg>',
    photo:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="M3 17l5-4 4 3 4-5 5 6"/></svg>',
    stage:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4L19 6"/></svg>',
  };

  /* ── Sidebar nav definition ────────────────────────────────────────────
   *
   * Reorganised around what an electrical contractor admin actually does
   * day-to-day, grouped by *decision* not by *database type*:
   *
   *   Run       — daily ops loops (Operations command centre, then queues:
   *               approvals, snags). One landing, no Today/Operations split.
   *   Deliver   — the work itself: Jobs, Hours.
   *   People    — Crew (admin-only — has rates + Xero IDs).
   *   Win       — Quotes (admin-only).
   *   Settings  — low-frequency: Suppliers, Temps, Settings (admin only).
   *
   * The previous 13-item sidebar (split across 5 sections) had Suppliers
   * and Temps competing with daily-ops surfaces. Tradies/LHs don't think
   * about wholesalers when they open the app — so those go below the fold.
   *
   * Each item gets an optional `roles: [...]` allow-list. Items without
   * `roles` are visible to both admin + leadingHand. Items gated to
   * ['admin'] disappear from the LH sidebar.
   */
  const NAV = [
    { section: 'Run' },
    { id: 'operations', label: 'Command centre', href: '/admin/operations', icon: 'today' },
    { id: 'approvals',  label: 'Approvals',      href: '/admin/approvals',  icon: 'approval', countKey: 'pendingHours', badgeBad: true },
    { id: 'snags',      label: 'Snag triage',    href: '/admin/snags',      icon: 'snag',     countKey: 'openSnags',    badgeBad: 'unassigned' },
    { id: 'support',    label: 'Support',        href: '/admin/support',    icon: 'bell',     countKey: 'openSupport',  badgeBad: true, roles: ['admin'] },
    { section: 'Deliver' },
    { id: 'jobs',       label: 'Jobs',           href: '/admin/jobs',       icon: 'jobs',     countKey: 'activeJobs' },
    { id: 'hours',      label: 'Hours & costs',  href: '/admin/hours',      icon: 'hours' },
    { id: 'materials',  label: 'Materials',      href: '/admin/materials',  icon: 'suppliers' },
    { id: 'costs',      label: 'Cash & margin',  href: '/admin/cash',       icon: 'today',    roles: ['admin'] },
    { section: 'People', roles: ['admin'] },
    { id: 'crew',       label: 'People',         href: '/admin/crew',       icon: 'crew',     countKey: 'crewCount', roles: ['admin'] },
    { id: 'assets',     label: 'Assets register', href: '/admin/assets',    icon: 'temp',     countKey: 'overdueAssets', badgeBad: true, roles: ['admin'] },
    { section: 'Win', roles: ['admin'] },
    { id: 'quotes',     label: 'Quotes',         href: '/admin/quotes',     icon: 'quote',    countKey: 'liveQuotes', roles: ['admin'] },
    { section: 'Settings', roles: ['admin'] },
    { id: 'activity',   label: 'Activity',       href: '/admin/activity',   icon: 'today' },
    { id: 'suppliers',  label: 'Suppliers',      href: '/admin/suppliers',  icon: 'suppliers', roles: ['admin'] },
    { id: 'temps',      label: 'Temps & assets', href: '/admin/temps',      icon: 'temp' },
    { id: 'settings',   label: 'Settings',       href: '/admin/settings',   icon: 'settings', roles: ['admin'] },
  ];

  // Pages gated by role. If the user lands on a page they're not allowed,
  // they're bounced to their default landing.
  // (`today` is intentionally still gated to admin because the legacy
  //  /admin/index.html now redirects to /admin/operations — see
  //  `redirectToOperations` below — but this guard catches edge cases
  //  where the page id is referenced elsewhere.)
  const PAGE_ROLES = {
    today:      ['admin'],
    quotes:     ['admin'],
    crew:       ['admin'],
    suppliers:  ['admin'],
    settings:   ['admin'],
    support:    ['admin'],
    assets:     ['admin'],
  };

  /* ── Boot ──────────────────────────────────────────────── */
  async function boot() {
    // Phase 02: ensure the Inter Tight display font is loaded for the
    // new chrome. Pages typically only pull Inter + JetBrains Mono; the
    // new shell adds Inter Tight for headings + cmd-palette labels.
    if (!document.querySelector('link[href*="Inter+Tight"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Inter+Tight:wght@600;700;800&display=swap';
      document.head.appendChild(link);
    }

    // Register the service worker so subsequent admin loads serve
    // _shell.css/.js + theme + key brand assets from the SW cache
    // (stale-while-revalidate). First admin load registers; cold
    // loads after that paint chrome from disk while the network
    // refreshes in the background.
    //
    // controllerchange auto-reload: when a new SW takes over the page
    // (e.g. after a CACHE_VERSION bump in sw.js), reload once so the
    // page is rendered against the new cache. Without this, existing
    // tabs on the old SW keep serving stale _shell.js out of cache
    // even after deploy — the exact symptom that kept /admin/operations
    // blank for clients with an installed SW after the SHELL.boot() fix
    // shipped. One-shot flag prevents reload loops.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
      let _swReloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (_swReloaded) return;
        _swReloaded = true;
        location.reload();
      });
    }

    // Auth gate — admin and leadingHand only.
    let me;
    try {
      const j = await api('/api/auth?action=me');
      me = j.user;
    } catch {
      location.href = '/login'; return;
    }
    if (me.role !== 'admin' && me.role !== 'leadingHand') {
      // Tradies → my-day; clients → client portal; anyone else → login.
      location.href = me.role === 'tradie' ? '/my-day' : (me.role === 'client' ? '/client' : '/login');
      return;
    }
    // Per-page role enforcement. Admin-only pages bounce LHs to their
    // role-specific landing. Admin/LH rebuild (see /lh-home.html): the
    // leadingHand role no longer shares the command-centre with admin;
    // they get the field-control surface at /lh instead. Admin role
    // continues to land in /admin/operations.
    const pageId = (window.PAGE && window.PAGE.id) || '';
    if (PAGE_ROLES[pageId] && !PAGE_ROLES[pageId].includes(me.role)) {
      location.href = me.role === 'leadingHand' ? '/lh' : '/admin/operations';
      return;
    }

    // Mount the shell skeleton if the page hasn't already.
    if (!$('#app')) {
      document.body.insertAdjacentHTML('beforeend', `
        <div class="app" id="app">
          <aside class="side" id="side"></aside>
          <main class="main">
            <header class="topbar" id="topbar"></header>
            <div class="page" id="page"></div>
          </main>
        </div>
      `);
    }

    SHELL.ME = me;

    // Shell-first render. Previously sidebar + topbar awaited
    // fetchSidebarCounts before painting — admin stared at a blank
    // page for the whole fan-out duration. Now we paint the chrome
    // immediately with zero counts so the user sees navigation and
    // page title within a frame; the fan-out then kicks off and
    // re-paints the sidebar badges when counts arrive.
    //
    // PAGE.render() still awaits the fan-out so pages reading
    // SHELL.JOBS / USERS / OPEN_SNAGS / PENDING_ENTRIES / QUOTES
    // (operations, jobs, snags, hours, etc.) see populated data.
    // The win here is purely perceptual — the navigation chrome
    // and active-section indicator appear instantly, the page body
    // shows a "Loading…" placeholder while data lands.
    SHELL.COUNTS = { activeJobs: 0, pendingHours: 0, openSnags: 0, unassignedSnags: 0, crewCount: 0, liveQuotes: 0, openSupport: 0, overdueAssets: 0 };
    renderSidebar();
    renderTopbar();
    bindKeyboard();
    ensurePalette();

    // Kick off the fan-out. Pages may also await SHELL.COUNTS_READY
    // if they want to defer their own work until data is in hand.
    SHELL.COUNTS_READY = (async () => {
      const counts = await fetchSidebarCounts();
      SHELL.COUNTS = counts;
      try { renderSidebar(); } catch (e) {}
      return counts;
    })();

    // Hand off to the page once counts (and SHELL.* shared state)
    // are ready. The fan-out is cached for 15s in sessionStorage
    // (PR #219) and individual blob reads are cached server-side
    // for 5s (PR #218), so this usually resolves in <50ms after
    // the first admin page load in a session.
    await SHELL.COUNTS_READY;

    if (window.PAGE && typeof window.PAGE.render === 'function') {
      try { await window.PAGE.render(); }
      catch (e) {
        console.error('PAGE.render failed', e);
        $('#page').innerHTML = `<div class="empty"><div class="empty-title">Something went wrong</div><div class="empty-sub">${escapeHtml(e.message || 'Try refreshing.')}</div></div>`;
      }
    }
  }

  // Cross-page sessionStorage cache for the shell fan-out. Every
  // admin .html is a separate document so the in-memory SHELL.*
  // globals reset on nav (operations → jobs → snags). Without a
  // cross-document cache the same 8 endpoints fire every load. A
  // 15-second sessionStorage cache keyed by user role makes admin
  // nav feel instant: the first hit populates the cache, the next
  // five+ admin pages opened within 15s read from it.
  //
  // Cache lifetime is intentionally short — counts move when users
  // mutate (snag close, hour approve, job edit), and a 15s window
  // is short enough that no surface goes stale long enough to
  // matter. SHELL.invalidateSidebar() (exposed below) lets pages
  // force-refresh after a write.
  const SIDEBAR_CACHE_KEY = 'buhl.admin.sidebar.v1';
  const SIDEBAR_CACHE_TTL_MS = 15000;

  function _readSidebarCache(role) {
    try {
      const raw = sessionStorage.getItem(SIDEBAR_CACHE_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || j.role !== role) return null;
      if (!j.ts || (Date.now() - j.ts) > SIDEBAR_CACHE_TTL_MS) return null;
      return j;
    } catch (e) { return null; }
  }

  function _writeSidebarCache(role, payload) {
    try {
      sessionStorage.setItem(SIDEBAR_CACHE_KEY, JSON.stringify({
        role, ts: Date.now(), ...payload,
      }));
    } catch (e) {
      // Quota / serialization failure — silently skip cache. Pages
      // still work, just no nav speedup.
    }
  }

  // Pages can call SHELL.invalidateSidebar() after a mutation that
  // would shift the counts (snag resolve, hour approve, etc.) so
  // the next admin nav sees fresh state.
  SHELL.invalidateSidebar = function invalidateSidebar() {
    try { sessionStorage.removeItem(SIDEBAR_CACHE_KEY); } catch (e) {}
  };

  async function fetchSidebarCounts() {
    // Admin gets the Support badge too (LH doesn't see Support — gated).
    const isAdmin = SHELL.ME && SHELL.ME.role === 'admin';
    const role = (SHELL.ME && SHELL.ME.role) || 'unknown';

    // Cache hit? Hydrate SHELL.* + return cached counts. Skips the
    // entire 8-call fan-out for the common admin-nav case.
    const cached = _readSidebarCache(role);
    if (cached) {
      if (Array.isArray(cached.JOBS))            SHELL.JOBS            = cached.JOBS;
      if (Array.isArray(cached.PENDING_ENTRIES)) SHELL.PENDING_ENTRIES = cached.PENDING_ENTRIES;
      if (Array.isArray(cached.OPEN_SNAGS))      SHELL.OPEN_SNAGS      = cached.OPEN_SNAGS;
      if (Array.isArray(cached.USERS))           SHELL.USERS           = cached.USERS;
      if (Array.isArray(cached.QUOTES))          SHELL.QUOTES          = cached.QUOTES;
      return cached.counts || {};
    }

    // Progressive sidebar render. Previously this awaited Promise.all
    // on 8 fetches then processed them sequentially — the slowest
    // fetch determined when ANY badge could update. Now each fetch
    // is wired to its own .then() that immediately writes SHELL.*
    // + updates SHELL.COUNTS + re-renders the sidebar as soon as
    // its data lands. Admins watching the page see badges fill in
    // progressively (200ms for /api/users, 800ms for /api/snags-all,
    // etc.) rather than all-or-nothing after the slowest.
    //
    // Promise.all on the resulting chain still gates COUNTS_READY,
    // so pages awaiting it (operations, hours, etc.) see fully
    // populated SHELL.* state before they render.
    const out = { activeJobs: 0, pendingHours: 0, openSnags: 0, unassignedSnags: 0, crewCount: 0, liveQuotes: 0, openSupport: 0, overdueAssets: 0 };
    function bump() {
      // Live-update the shell counts + sidebar so badges fill in as
      // each fetch lands. Cheap operation — sidebar re-render is a
      // pure HTML template swap.
      SHELL.COUNTS = out;
      try { renderSidebar(); } catch (e) {}
    }

    const tasks = [];
    tasks.push(
      fetch('/api/jobs', { credentials: 'same-origin' })
        .then(r => r && r.ok ? r.json() : null)
        .then(j => {
          if (!j) return;
          const jobs = j.jobs || [];
          out.activeJobs = jobs.filter(x => (x.status || 'active') === 'active').length;
          SHELL.JOBS = jobs;
          bump();
        })
        .catch(() => {})
    );
    tasks.push(
      fetch('/api/time-entries?status=submitted&scope=approver', { credentials: 'same-origin' })
        .then(r => r && r.ok ? r.json() : null)
        .then(j => {
          if (!j) return;
          const entries = j.entries || [];
          out.pendingHours = entries.length;
          SHELL.PENDING_ENTRIES = entries;
          bump();
        })
        .catch(() => {})
    );
    tasks.push(
      fetch('/api/snags-all?status=Open', { credentials: 'same-origin' })
        .then(r => r && r.ok ? r.json() : null)
        .then(j => {
          if (!j) return;
          const snags = j.snags || [];
          out.openSnags = snags.length;
          out.unassignedSnags = snags.filter(s => !s.assignedTo).length;
          SHELL.OPEN_SNAGS = snags;
          bump();
        })
        .catch(() => {})
    );
    tasks.push(
      fetch('/api/users', { credentials: 'same-origin' })
        .then(r => r && r.ok ? r.json() : null)
        .then(j => {
          if (!j) return;
          const users = j.users || [];
          out.crewCount = users.length;
          SHELL.USERS = users;
          bump();
        })
        .catch(() => {})
    );
    tasks.push(
      fetch('/api/quotes', { credentials: 'same-origin' })
        .then(r => r && r.ok ? r.json() : null)
        .then(j => {
          if (!j) return;
          const quotes = j.quotes || [];
          out.liveQuotes = quotes.filter(q => !['archived','converted_to_job','lost','declined'].includes(q.status)).length;
          SHELL.QUOTES = quotes;
          bump();
        })
        .catch(() => {})
    );
    if (isAdmin) {
      // Support inbox count = open access requests + open password
      // resets. Single sidebar pill so admin sees "something needs
      // attention" without thinking about kind.
      tasks.push(
        fetch('/api/access-requests?status=open', { credentials: 'same-origin' })
          .then(r => r && r.ok ? r.json() : null)
          .then(j => {
            if (!j) return;
            out.openSupport = (out.openSupport || 0) + ((j.requests || []).length);
            bump();
          })
          .catch(() => {})
      );
      tasks.push(
        fetch('/api/password-resets?status=open', { credentials: 'same-origin' })
          .then(r => r && r.ok ? r.json() : null)
          .then(j => {
            if (!j) return;
            out.openSupport = (out.openSupport || 0) + ((j.resets || []).length);
            bump();
          })
          .catch(() => {})
      );
      // Overdue-assets badge — assets past expected return date.
      // Admin-only (LH/tradie see their own gear in /my-gear with
      // its own overdue surfacing).
      tasks.push(
        fetch('/api/assets', { credentials: 'same-origin' })
          .then(r => r && r.ok ? r.json() : null)
          .then(j => {
            if (!j) return;
            const today = new Date().toISOString().slice(0, 10);
            out.overdueAssets = (j.assets || []).filter(a => !a.archived && a.expectedReturn && a.expectedReturn < today && a.currentHolderId).length;
            bump();
          })
          .catch(() => {})
      );
    }
    // Wait for all tasks before completing — pages awaiting
    // COUNTS_READY get fully populated SHELL.* shared state.
    await Promise.all(tasks);

    // Write the fresh fan-out result to sessionStorage so the next
    // admin nav within 15s skips the network entirely. Persists
    // SHELL.* shared state alongside the counts so pages reading
    // SHELL.JOBS / SHELL.USERS etc. work from the cache too.
    _writeSidebarCache(role, {
      counts:          out,
      JOBS:            SHELL.JOBS || [],
      PENDING_ENTRIES: SHELL.PENDING_ENTRIES || [],
      OPEN_SNAGS:      SHELL.OPEN_SNAGS || [],
      USERS:           SHELL.USERS || [],
      QUOTES:          SHELL.QUOTES || [],
    });

    return out;
  }

  function renderSidebar() {
    const me = SHELL.ME;
    const C  = SHELL.COUNTS || {};
    const activeId = (window.PAGE && window.PAGE.id) || 'today';
    // Filter the nav by role and drop adjacent / trailing section headers
    // that no longer have any items underneath them.
    const visible = NAV.filter(item => !item.roles || item.roles.includes(me.role));
    const cleaned = visible.filter((item, i) => {
      if (!item.section) return true;
      // Drop section header if next item is another section header or end of list
      const next = visible[i + 1];
      return next && !next.section;
    });
    const items = cleaned.map(item => {
      if (item.section) {
        return `<div class="side-section">${escapeHtml(item.section)}</div>`;
      }
      const isActive = item.id === activeId;
      const count = item.countKey ? C[item.countKey] : null;
      let badge = '';
      if (count != null && count > 0) {
        // Brief F-01 + §02 severity rules:
        //   - Default: neutral grey (calm by default).
        //   - .warn (yellow): "needs attention" categories.
        //   - .bad (red): true SLA breach.
        // Until we have age data, most queues land on .warn. Assets is
        // the only one where the count itself means "literally past
        // due" — so it gets the only red badge.
        let kind = '';
        if (item.id === 'assets')                kind = 'bad';
        else if (item.badgeBad === true)         kind = 'warn';
        else if (item.badgeBad === 'unassigned'
                 && (C.unassignedSnags || 0) > 0) kind = 'warn';
        badge = `<span class="side-badge ${kind}">${count}</span>`;
      }
      return `<a href="${item.href}" class="${isActive ? 'active' : ''}">
        ${ICONS[item.icon] || ''}<span>${escapeHtml(item.label)}</span>${badge}
      </a>`;
    }).join('');

    const roleLabel = me.role === 'admin' ? 'Admin' : 'Leading hand';
    $('#side').innerHTML = `
      <div class="side-brand">
        <div class="side-brand-mark">b</div>
        <div>
          <div class="side-brand-name">bühl admin</div>
          <div class="side-brand-sub">site office</div>
        </div>
      </div>
      ${items}
      <!-- Picker page nuked — admin/LH "Jobs" lives in the sidebar above
           (/admin/jobs). Field-side equivalents kept as quick jump-outs:
           My Day for LH (their daily home); per-job dashboards reachable
           from /admin/jobs row → workspace → "Open in field". -->
      ${me.role === 'leadingHand' ? `<div class="side-section">Field</div>
        <a href="/my-day" target="_blank" rel="noopener">${ICONS.field}<span>My Day</span>${ICONS.external}</a>` : ''}
      <div class="side-foot">
        <div class="side-avatar">${initials(me.username)}</div>
        <div style="flex:1;min-width:0">
          <div class="side-foot-name">${escapeHtml(me.username)}</div>
          <div class="side-foot-role">${roleLabel} · signed in</div>
        </div>
        <button class="btn-icon btn-ghost" title="Tweaks"   onclick="SHELL.toggleTweaks()" style="color:#8a93a4">${ICONS.tweaks}</button>
        <button class="btn-icon btn-ghost" title="Sign out" onclick="SHELL.signOut()"      style="color:#8a93a4">${ICONS.x}</button>
      </div>
      <!-- Env-chip — design ref: sCITnq7lo bundle, sidenav-foot. Tiny
           low-key string in the sidebar foot so admins always know which
           build of BuhlOS they're looking at. -->
      <div class="side-env" title="bühl electrical · Site office console">
        <span class="side-env-dot"></span>
        Production · v1
        <span class="side-env-meta">bühl electrical · Site office</span>
      </div>
    `;
  }

  function renderTopbar() {
    const crumb = (window.PAGE && window.PAGE.crumb) || (window.PAGE && window.PAGE.title) || '';
    // Phase 02 chrome (brief §02 + §06):
    //   - Crumb on the left.
    //   - Real ⌘K trigger replaces the inert "Quick find" field (F-04).
    //   - Density toggle (compact / regular / roomy).
    //   - Bell (F-05) removed — no notification system behind it.
    $('#topbar').innerHTML = `
      <div class="topbar-crumb">
        <span>${SHELL.ME && SHELL.ME.role === 'leadingHand' ? 'Site office' : 'Admin'}</span><span>›</span><b>${escapeHtml(crumb)}</b>
      </div>
      <button class="topbar-cmd" id="topbar-cmd" type="button"
              title="Open command palette (⌘K)" aria-haspopup="dialog">
        <span class="topbar-cmd-arr">⌘K</span>
        <span class="topbar-cmd-ph">Jump or do…</span>
        <span class="topbar-cmd-kb">⌘K</span>
      </button>
      <div class="topbar-density" role="tablist" aria-label="Density">
        <button data-d="compact" type="button" title="Compact (32px row)">·</button>
        <button data-d="regular" type="button" title="Regular (40px row)">··</button>
        <button data-d="roomy"   type="button" title="Roomy (48px row)">···</button>
      </div>
    `;
    // Open palette when the trigger is clicked.
    const cmdTrigger = $('#topbar-cmd');
    if (cmdTrigger) cmdTrigger.addEventListener('click', () => openCmdPalette());
    // Wire density toggle.
    $$('.topbar-density button[data-d]').forEach(b => {
      b.addEventListener('click', () => setTweak('density', b.dataset.d));
    });
    paintDensityToggle();
  }

  function paintDensityToggle() {
    $$('.topbar-density button[data-d]').forEach(b => {
      b.classList.toggle('on', b.dataset.d === tweaks.density);
    });
  }

  /* ── Command palette (brief §06) ────────────────────────────────
     Phase 02 ships the chrome — the singleton <cmd-palette> mount,
     the topbar trigger, and a baseline command registry (jump-to
     pages + density switches + sign out). Per-view commands come in
     phase 04. */

  let _palettePromise = null;
  function ensurePalette() {
    if (_palettePromise) return _palettePromise;
    _palettePromise = (async () => {
      // Lazy-load the module. Component self-registers on import.
      await import('/components/cmd-palette.js');
      let p = document.querySelector('cmd-palette');
      if (!p) {
        p = document.createElement('cmd-palette');
        document.body.appendChild(p);
      }
      registerBaselineCommands();
      return p;
    })();
    return _palettePromise;
  }
  async function openCmdPalette() {
    const p = await ensurePalette();
    if (p && typeof p.open === 'function') p.open();
  }

  let _baselineRegistered = false;
  async function registerBaselineCommands() {
    if (_baselineRegistered) return;
    const { CmdRegistry } = await import('/components/cmd-palette.js');
    const role = SHELL.ME?.role;
    const isAdmin = role === 'admin';

    const cmds = [];

    // ── Jumps to admin pages the current role can see. ──
    NAV.filter(n => !n.section && (!n.roles || n.roles.includes(role)))
       .forEach(n => cmds.push({
         id: 'jump-' + n.id,
         verb: 'Open',
         group: 'Jump',
         label: n.label,
         href: n.href,
       }));

    // ── Job jumps (brief §06: type "iv32" → jump to IV3232). ──
    // Active jobs first, then setup/paused. Archived stays out — the
    // boss doesn't think about old jobs day-to-day.
    const jobs = (SHELL.JOBS || []).filter(j => j.status !== 'archived');
    jobs.sort((a, b) => {
      const order = { active: 0, setup: 1, paused: 2, complete: 3 };
      return (order[a.status] ?? 4) - (order[b.status] ?? 4);
    });
    jobs.forEach(j => cmds.push({
      id: 'jump-job-' + j.id,
      verb: 'Open',
      group: 'Jobs',
      label: `${j.code ? j.code + ' · ' : ''}${j.name || j.id}`,
      detail: j.client || j.address || '',
      href: `/admin/jobs/${encodeURIComponent(j.id)}`,
    }));

    // ── User jumps (admin only — LH doesn't manage people). ──
    if (isAdmin) {
      const users = (SHELL.USERS || []).filter(u => !u.archived);
      users.sort((a, b) => (a.username || '').localeCompare(b.username || ''));
      users.forEach(u => cmds.push({
        id: 'jump-user-' + u.id,
        verb: 'Open',
        group: 'People',
        label: u.username || u.id,
        detail: u.role === 'leadingHand' ? 'Leading hand' :
                u.role ? (u.role.charAt(0).toUpperCase() + u.role.slice(1)) : '',
        href: `/admin/crew?u=${encodeURIComponent(u.id)}`,
      }));
    }

    // ── Open snag jumps — typed "snag" or the title. ──
    (SHELL.OPEN_SNAGS || []).slice(0, 20).forEach(s => cmds.push({
      id: 'jump-snag-' + s.id,
      verb: 'Open',
      group: 'Snags',
      label: s.title || s.description || 'Snag',
      detail: s.location || s.jobName || '',
      href: `/admin/snags?id=${encodeURIComponent(s.id)}`,
    }));

    // ── Do commands (brief §06 "do" verbs). ──
    if (isAdmin) {
      cmds.push(
        { id: 'do-new-job',     verb: 'Create', group: 'Actions',
          label: 'New job', href: '/admin/jobs?new=1' },
        { id: 'do-new-quote',   verb: 'Create', group: 'Actions',
          label: 'New quote', href: '/admin/quotes?new=1' },
        { id: 'do-new-person',  verb: 'Create', group: 'Actions',
          label: 'New person', href: '/admin/crew?new=1' },
        { id: 'do-export-payroll', verb: 'Export', group: 'Actions',
          label: 'Payroll CSV · this week', href: '/admin/hours?export=this-week' },
      );
    }
    // Snag-raising is available to admin + LH.
    cmds.push(
      { id: 'do-new-snag', verb: 'Raise', group: 'Actions',
        label: 'New snag', href: '/admin/snags?new=1' },
    );

    // ── Switches. ──
    cmds.push(
      { id: 'density-compact', verb: 'Set', group: 'Density',
        label: 'Density · Compact', shortcut: '',
        run: () => setTweak('density', 'compact') },
      { id: 'density-regular', verb: 'Set', group: 'Density',
        label: 'Density · Regular',
        run: () => setTweak('density', 'regular') },
      { id: 'density-roomy', verb: 'Set', group: 'Density',
        label: 'Density · Roomy',
        run: () => setTweak('density', 'roomy') },
    );

    // ── LH-only: deep-link to their field interface. ──
    if (role === 'leadingHand') {
      cmds.push({ id: 'open-in-field-myday', verb: 'Open', group: 'Field',
                  label: 'My Day · field interface', href: '/my-day' });
    }

    // ── Sign out — always last. ──
    cmds.push({ id: 'sign-out', verb: 'Sign', group: 'Account',
                label: 'Sign out', run: () => signOut() });

    CmdRegistry.registerMany(cmds);
    _baselineRegistered = true;
  }

  function bindKeyboard() {
    // ⌘K is owned by <cmd-palette> — see /components/cmd-palette.js.
    // We only handle escape-to-close-tweaks here.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && tweakOpen) { tweakOpen = false; renderTweaksPanel(); }
    });
  }

  /* ── Side panel (right-slide) ──────────────────────────── */
  function openPanel({ title, body, footer }) {
    closePanel();
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.id = 'side-panel-host';
    scrim.innerHTML = `
      <div class="side-panel" role="dialog" aria-modal="true">
        <div class="side-panel-head">
          <div class="side-panel-title">${escapeHtml(title || '')}</div>
          <button class="btn-icon btn-ghost" onclick="SHELL.closePanel()">${ICONS.x}</button>
        </div>
        <div class="side-panel-body">${body || ''}</div>
        ${footer ? `<div class="side-panel-foot">${footer}</div>` : ''}
      </div>
    `;
    scrim.addEventListener('click', (e) => { if (e.target === scrim) closePanel(); });
    document.body.appendChild(scrim);
    return scrim.querySelector('.side-panel');
  }
  function closePanel() {
    const h = $('#side-panel-host');
    if (h) h.remove();
  }

  /* ── Centred dialog (confirm-style) ────────────────────── */
  function openDialog({ title, body, footer }) {
    closeDialog();
    const scrim = document.createElement('div');
    scrim.className = 'scrim-c';
    scrim.id = 'dialog-host';
    scrim.innerHTML = `
      <div class="dialog" role="dialog" aria-modal="true">
        <div class="dialog-head">
          <div class="dialog-title">${escapeHtml(title || '')}</div>
          <button class="btn-icon btn-ghost" onclick="SHELL.closeDialog()">${ICONS.x}</button>
        </div>
        <div>${body || ''}</div>
        ${footer ? `<div class="dialog-foot">${footer}</div>` : ''}
      </div>
    `;
    scrim.addEventListener('click', (e) => { if (e.target === scrim) closeDialog(); });
    document.body.appendChild(scrim);
    return scrim.querySelector('.dialog');
  }
  function closeDialog() {
    const h = $('#dialog-host');
    if (h) h.remove();
  }

  /* ── Tweaks panel ──────────────────────────────────────── */
  function toggleTweaks() { tweakOpen = !tweakOpen; renderTweaksPanel(); }
  function renderTweaksPanel() {
    let host = $('#tweaks-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'tweaks-host';
      document.body.appendChild(host);
    }
    if (!tweakOpen) { host.innerHTML = ''; return; }
    // Phase 02: dropped accent picker. The yellow accent is token-
    // driven and shouldn't be rotated (brief §17: one yellow per
    // screen — rotating defeats the rule).
    host.innerHTML = `
      <div style="position:fixed;bottom:20px;right:20px;width:280px;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow-lg);padding:18px;z-index:300">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
          <div style="font-weight:600;font-size:14px">Tweaks</div>
          <button class="btn-icon btn-ghost" onclick="SHELL.toggleTweaks()">${ICONS.x}</button>
        </div>
        <div class="field-lbl" style="margin-bottom:6px">Theme</div>
        <div class="chip-group" style="display:grid;grid-template-columns:1fr 1fr">
          <button class="chip ${tweaks.theme==='light'?'active':''}" onclick="SHELL.setTweak('theme','light')">Light</button>
          <button class="chip ${tweaks.theme==='dark'?'active':''}"  onclick="SHELL.setTweak('theme','dark')">Dark</button>
        </div>
        <div class="field-lbl" style="margin:12px 0 6px">Density</div>
        <div class="chip-group" style="display:grid;grid-template-columns:1fr 1fr 1fr">
          <button class="chip ${tweaks.density==='compact'?'active':''}" onclick="SHELL.setTweak('density','compact')">Compact</button>
          <button class="chip ${tweaks.density==='regular'?'active':''}" onclick="SHELL.setTweak('density','regular')">Regular</button>
          <button class="chip ${tweaks.density==='roomy'?'active':''}"   onclick="SHELL.setTweak('density','roomy')">Roomy</button>
        </div>
        <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);line-height:1.5">
          Saved on this device. Press <kbd style="font-family:var(--ff-mono);background:var(--surface-2);padding:1px 5px;border:1px solid var(--line);border-radius:3px">⌘K</kbd> anywhere to open the command palette · <kbd style="font-family:var(--ff-mono);background:var(--surface-2);padding:1px 5px;border:1px solid var(--line);border-radius:3px">Esc</kbd> to close panels.
        </div>
      </div>
    `;
  }

  async function signOut() {
    try { await api('/api/auth?action=logout', { method: 'POST' }); } catch {}
    location.href = '/login';
  }

  // Defensive top-level wrapper around boot. Any uncaught throw in
  // the boot chain (auth, fan-out, sidebar render, PAGE.render) used
  // to leave the page completely blank — users reported the symptom
  // as "/admin/operations is blank". Catching at the top surfaces
  // a visible error message so the user knows the app is alive
  // even when something's gone wrong, and gives them a recovery
  // path (refresh, copy the error for support).
  // Tracks whether boot was kicked off (explicitly via SHELL.boot() at the
  // end of a page's script, OR via the DOMContentLoaded auto-boot fallback
  // below). Used by both safeBoot's idempotency check and the blank-shell
  // detector so they don't fight over the body.
  let _bootCalled = false;
  let _bootFinished = false;

  async function safeBoot() {
    if (_bootCalled) return;
    _bootCalled = true;
    try {
      await boot();
      _bootFinished = true;
    }
    catch (e) {
      _bootFinished = true;
      console.error('SHELL.boot failed', e);
      try {
        document.body.innerHTML = `
          <div style="max-width:520px;margin:80px auto;padding:32px 24px;font-family:-apple-system,Segoe UI,sans-serif;background:#fff;border:1px solid #e3e5dc;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.06)">
            <div style="font-family:'Inter Tight',sans-serif;font-weight:700;font-size:22px;color:#0d1b34;letter-spacing:-.015em;margin-bottom:6px">Couldn't load the admin shell</div>
            <div style="color:#6a7591;font-size:13.5px;margin-bottom:18px">${(e && e.message || 'Unknown error').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</div>
            <button onclick="location.reload()" style="padding:9px 16px;border-radius:8px;background:#0d1b34;color:#fff;border:0;font-weight:600;font-size:13px;cursor:pointer">Reload page</button>
            <a href="/login" style="margin-left:8px;color:#6a7591;font-size:13px">Sign in again</a>
            <details style="margin-top:18px;color:#9aa3bc;font-family:ui-monospace,Menlo,monospace;font-size:11px"><summary style="cursor:pointer">Show stack</summary><pre style="white-space:pre-wrap;word-break:break-word;margin-top:8px">${((e && e.stack) || '').replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</pre></details>
          </div>
        `;
      } catch (_) {}
    }
  }

  /* ── Public surface ────────────────────────────────────── */
  window.SHELL = {
    boot: safeBoot,
    ME: null,
    COUNTS: null,
    JOBS: [],
    USERS: [],
    OPEN_SNAGS: [],
    PENDING_ENTRIES: [],
    QUOTES: [],
    // Helpers
    $, $$, escapeHtml, initials, pluralize, _iso, _ago, isoWeekMonday, fmtMoney, fmtMoney2, toast, api,
    jobStatusPill, rolePill, bar,
    ICONS,
    // UI
    openPanel, closePanel, openDialog, closeDialog,
    toggleTweaks, setTweak,
    signOut,
    // Phase 02 — command palette helpers.
    openCmdPalette,
    ensurePalette,
    // Phase 04 — per-view command registration.
    //   const unreg = await SHELL.registerCommands('hours', [...]);
    //   // returns a teardown function; the same scope key clears
    //   // any commands previously registered under that key.
    registerCommands: async (scopeKey, cmds) => {
      const { CmdRegistry } = await import('/components/cmd-palette.js');
      if (scopeKey) return CmdRegistry.scope(scopeKey)(cmds);
      return CmdRegistry.registerMany(cmds);
    },
    // Re-render the sidebar (for after a write that changes a count)
    refreshCounts: async () => {
      const c = await fetchSidebarCounts();
      SHELL.COUNTS = c;
      renderSidebar();
      renderTopbar();
    },
  };

  /* ── Auto-boot fallback ────────────────────────────────────
     PR #35 (Site office Phase 03 rebuild) dropped the explicit
     SHELL.boot() call from operations.html. With no boot, the
     shell skeleton never mounts and the page is silently blank —
     none of the in-boot try/catches fire because boot never runs.

     Convention is still that every /admin/<page>.html ends with
     SHELL.boot() (enforced by scripts/check-admin-shell.js at
     predeploy), but a runtime safety net stops the same class
     of regression from ever shipping blank again: if the page
     hasn't explicitly called SHELL.boot() by the time the DOM
     is parsed, we call it ourselves. */
  function _autoBootIfMissing() {
    if (_bootCalled) return;
    console.warn('SHELL: page did not call SHELL.boot() — auto-booting. ' +
      'Add an explicit `SHELL.boot();` to the page script.');
    safeBoot();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _autoBootIfMissing, { once: true });
  } else {
    // Defer one task so a trailing `SHELL.boot()` later in the same script
    // (parsed after _shell.js) still wins the race and we don't double-boot.
    setTimeout(_autoBootIfMissing, 0);
  }

  /* ── Blank-shell detector ──────────────────────────────────
     Last-line defence. If five seconds after DOM ready the
     shell skeleton (#app) still isn't in the DOM, something
     catastrophic happened — boot threw before mounting, or
     never started. Render a visible recovery panel instead of
     leaving the user staring at a white page. */
  function _checkBlankShell() {
    try {
      if (document.getElementById('app')) return;          // shell mounted, fine
      if (document.querySelector('[data-shell-error]')) return; // safeBoot's catch painted
      // Don't fight a slow but legitimate boot — only fire if boot has
      // either not been called or has finished without mounting #app.
      if (_bootCalled && !_bootFinished) return;
      console.error('SHELL: blank shell detected after 5s — emergency fallback.');
      document.body.innerHTML = `
        <div data-shell-error style="max-width:520px;margin:80px auto;padding:32px 24px;font-family:-apple-system,Segoe UI,sans-serif;background:#fff;border:1px solid #e3e5dc;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.06)">
          <div style="font-family:'Inter Tight',sans-serif;font-weight:700;font-size:22px;color:#0d1b34;letter-spacing:-.015em;margin-bottom:6px">Admin shell didn't load</div>
          <div style="color:#6a7591;font-size:13.5px;margin-bottom:18px">This page should not be blank. The BuhlOS admin shell failed to mount within 5 seconds.</div>
          <button onclick="location.reload()" style="padding:9px 16px;border-radius:8px;background:#0d1b34;color:#fff;border:0;font-weight:600;font-size:13px;cursor:pointer">Reload page</button>
          <a href="/admin/operations" style="margin-left:8px;color:#6a7591;font-size:13px">Command centre</a>
          <a href="/login" style="margin-left:8px;color:#6a7591;font-size:13px">Sign in again</a>
        </div>
      `;
    } catch (_) {}
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(_checkBlankShell, 5000), { once: true });
  } else {
    setTimeout(_checkBlankShell, 5000);
  }
})();
