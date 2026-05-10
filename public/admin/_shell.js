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

  /* ── Tweaks (theme/density/accent) — persisted in localStorage ── */
  const TWEAK_KEY = 'buhl-site-office-tweaks';
  const TWEAK_DEFAULTS = { theme: 'light', density: 'default', accent: '#e08a1a' };
  let tweaks = (() => {
    try { return Object.assign({}, TWEAK_DEFAULTS, JSON.parse(localStorage.getItem(TWEAK_KEY) || '{}')); }
    catch { return { ...TWEAK_DEFAULTS }; }
  })();
  function shadeAccent(hex, amt) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    const t = n => Math.min(255, Math.round(n + (255-n)*amt));
    return '#' + [t(r),t(g),t(b)].map(n => n.toString(16).padStart(2,'0')).join('');
  }
  function applyTweaks() {
    document.documentElement.dataset.density = tweaks.density;
    document.documentElement.dataset.theme   = tweaks.theme;
    document.documentElement.style.setProperty('--accent',   tweaks.accent);
    document.documentElement.style.setProperty('--accent-2', shadeAccent(tweaks.accent, 0.18));
    const r = parseInt(tweaks.accent.slice(1,3),16),
          g = parseInt(tweaks.accent.slice(3,5),16),
          b = parseInt(tweaks.accent.slice(5,7),16);
    const lum = (0.299*r + 0.587*g + 0.114*b);
    document.documentElement.style.setProperty('--accent-ink', lum > 160 ? '#2a1a05' : '#fff');
  }
  function setTweak(k, v) {
    tweaks[k] = v;
    applyTweaks();
    try { localStorage.setItem(TWEAK_KEY, JSON.stringify(tweaks)); } catch {}
    if (tweakOpen) renderTweaksPanel();
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
    { section: 'Deliver' },
    { id: 'jobs',       label: 'Jobs',           href: '/admin/jobs',       icon: 'jobs',     countKey: 'activeJobs' },
    { id: 'hours',      label: 'Hours & costs',  href: '/admin/hours',      icon: 'hours' },
    { section: 'People', roles: ['admin'] },
    { id: 'crew',       label: 'Crew',           href: '/admin/crew',       icon: 'crew',     countKey: 'crewCount', roles: ['admin'] },
    { section: 'Win', roles: ['admin'] },
    { id: 'quotes',     label: 'Quotes',         href: '/admin/quotes',     icon: 'quote',    countKey: 'liveQuotes', roles: ['admin'] },
    { section: 'Settings', roles: ['admin'] },
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
  };

  /* ── Boot ──────────────────────────────────────────────── */
  async function boot() {
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
    // Per-page role enforcement. Admin-only pages bounce LHs to their default landing.
    const pageId = (window.PAGE && window.PAGE.id) || '';
    if (PAGE_ROLES[pageId] && !PAGE_ROLES[pageId].includes(me.role)) {
      // Single command-centre landing for both admin + LH.
      location.href = '/admin/operations';
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

    // Fetch sidebar counts in parallel — cheap reads, no per-section detail.
    const counts = await fetchSidebarCounts();
    SHELL.COUNTS = counts;

    renderSidebar();
    renderTopbar();
    bindKeyboard();

    // Hand off to the page.
    if (window.PAGE && typeof window.PAGE.render === 'function') {
      try { await window.PAGE.render(); }
      catch (e) {
        console.error('PAGE.render failed', e);
        $('#page').innerHTML = `<div class="empty"><div class="empty-title">Something went wrong</div><div class="empty-sub">${escapeHtml(e.message || 'Try refreshing.')}</div></div>`;
      }
    }
  }

  async function fetchSidebarCounts() {
    const [jobsR, pendingR, snagsR, usersR, quotesR] = await Promise.all([
      fetch('/api/jobs?withStats=1', { credentials: 'same-origin' }).catch(() => null),
      fetch('/api/time-entries?status=submitted&scope=approver', { credentials: 'same-origin' }).catch(() => null),
      fetch('/api/snags-all?status=Open', { credentials: 'same-origin' }).catch(() => null),
      fetch('/api/users', { credentials: 'same-origin' }).catch(() => null),
      fetch('/api/quotes', { credentials: 'same-origin' }).catch(() => null),
    ]);
    const out = { activeJobs: 0, pendingHours: 0, openSnags: 0, unassignedSnags: 0, crewCount: 0, liveQuotes: 0 };
    try {
      if (jobsR && jobsR.ok) {
        const jobs = (await jobsR.json()).jobs || [];
        out.activeJobs = jobs.filter(j => (j.status || 'active') === 'active').length;
        SHELL.JOBS = jobs;
      }
    } catch {}
    try {
      if (pendingR && pendingR.ok) {
        const entries = (await pendingR.json()).entries || [];
        out.pendingHours = entries.length;
        SHELL.PENDING_ENTRIES = entries;
      }
    } catch {}
    try {
      if (snagsR && snagsR.ok) {
        const snags = (await snagsR.json()).snags || [];
        out.openSnags = snags.length;
        out.unassignedSnags = snags.filter(s => !s.assignedTo).length;
        SHELL.OPEN_SNAGS = snags;
      }
    } catch {}
    try {
      if (usersR && usersR.ok) {
        const users = (await usersR.json()).users || [];
        out.crewCount = users.length;
        SHELL.USERS = users;
      }
    } catch {}
    try {
      if (quotesR && quotesR.ok) {
        const quotes = (await quotesR.json()).quotes || [];
        out.liveQuotes = quotes.filter(q => !['archived','converted_to_job','lost','declined'].includes(q.status)).length;
        SHELL.QUOTES = quotes;
      }
    } catch {}
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
        let bad = false;
        if (item.badgeBad === true) bad = true;
        else if (item.badgeBad === 'unassigned') bad = (C.unassignedSnags || 0) > 0;
        badge = `<span class="side-badge ${bad ? 'bad' : ''}">${count}</span>`;
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
    const C = SHELL.COUNTS || {};
    const crumb = (window.PAGE && window.PAGE.crumb) || (window.PAGE && window.PAGE.title) || '';
    const showDot = (C.pendingHours || 0) > 0 || (C.unassignedSnags || 0) > 0;
    // Single command-centre landing for both admin + LH. The legacy
    // /admin/ "Today" page redirects to /admin/operations on load — see
    // public/admin/index.html — so the bell always lands on the live
    // command centre, not a half-stale duplicate.
    const homeHref = '/admin/operations';
    $('#topbar').innerHTML = `
      <div class="topbar-crumb">
        <span>${SHELL.ME && SHELL.ME.role === 'leadingHand' ? 'Site office' : 'Admin'}</span><span>›</span><b>${escapeHtml(crumb)}</b>
      </div>
      <div class="topbar-spacer"></div>
      <div class="search">
        ${ICONS.search}
        <input id="topbar-search" placeholder="Quick find — job, user, snag…" autocomplete="off">
        <span class="search-key">⌘K</span>
      </div>
      <button class="icon-btn" title="${C.pendingHours} pending hours, ${C.unassignedSnags || 0} unassigned snags" style="position:relative" onclick="location.href='${homeHref}'">
        ${ICONS.bell}
        ${showDot ? `<span style="position:absolute;top:6px;right:6px;width:7px;height:7px;background:var(--bad);border-radius:50%;border:1.5px solid var(--surface)"></span>` : ''}
      </button>
    `;
    // Wire the topbar search to dispatch a custom event the page can listen for.
    const search = $('#topbar-search');
    if (search) {
      search.addEventListener('input', () => {
        document.dispatchEvent(new CustomEvent('shell-search', { detail: { q: search.value } }));
      });
    }
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Cmd/Ctrl-K — focus topbar search.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const input = $('#topbar-search');
        if (input) { input.focus(); input.select(); }
      }
      // Escape — close tweaks panel.
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
    const ACCENTS = ['#e08a1a','#f5d020','#1c5fb8','#1f8a4c','#b3261e','#5b3a8a'];
    host.innerHTML = `
      <div style="position:fixed;bottom:20px;right:20px;width:300px;background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow-lg);padding:18px;z-index:300">
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
          <button class="chip ${tweaks.density==='default'?'active':''}" onclick="SHELL.setTweak('density','default')">Default</button>
          <button class="chip ${tweaks.density==='roomy'?'active':''}"   onclick="SHELL.setTweak('density','roomy')">Roomy</button>
        </div>
        <div class="field-lbl" style="margin:12px 0 6px">Accent</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${ACCENTS.map(c => `
            <button onclick="SHELL.setTweak('accent','${c}')" title="${c}"
              style="width:28px;height:28px;border-radius:50%;background:${c};border:2px solid ${tweaks.accent===c?'var(--ink)':'var(--line)'};cursor:pointer"></button>
          `).join('')}
        </div>
        <div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--line);font-size:11px;color:var(--muted);line-height:1.5">
          Saved on this device. <kbd style="font-family:var(--ff-mono);background:var(--surface-2);padding:1px 5px;border:1px solid var(--line);border-radius:3px">⌘K</kbd> focuses search · <kbd style="font-family:var(--ff-mono);background:var(--surface-2);padding:1px 5px;border:1px solid var(--line);border-radius:3px">Esc</kbd> closes panels.
        </div>
      </div>
    `;
  }

  async function signOut() {
    try { await api('/api/auth?action=logout', { method: 'POST' }); } catch {}
    location.href = '/login';
  }

  /* ── Public surface ────────────────────────────────────── */
  window.SHELL = {
    boot,
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
    // Re-render the sidebar (for after a write that changes a count)
    refreshCounts: async () => {
      const c = await fetchSidebarCounts();
      SHELL.COUNTS = c;
      renderSidebar();
      renderTopbar();
    },
  };
})();
