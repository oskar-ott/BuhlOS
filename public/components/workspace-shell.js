// ╔════════════════════════════════════════════════════════════════════╗
// ║  <workspace-shell> · S-01 · BuhlOS site office                     ║
// ║                                                                    ║
// ║  Per brief §02 (workspace shell) and §15.                          ║
// ║                                                                    ║
// ║  The chrome. Solid navy sidebar, breadcrumb topbar, density       ║
// ║  toggle, command-palette mount, role-aware nav. Page content goes  ║
// ║  in the default slot.                                              ║
// ║                                                                    ║
// ║  USAGE (per page):                                                 ║
// ║                                                                    ║
// ║    <workspace-shell                                                ║
// ║      role="admin"                                                  ║
// ║      page="overview"                                               ║
// ║      crumb="Site Office › Overview">                               ║
// ║                                                                    ║
// ║      <!-- right-side topbar widget; defaults to <open-in-field> -->║
// ║      <span slot="topbar-action">                                   ║
// ║        <open-in-field job="iv3232"></open-in-field>                ║
// ║      </span>                                                       ║
// ║                                                                    ║
// ║      <!-- the actual page -->                                      ║
// ║      <main class="page">…</main>                                   ║
// ║    </workspace-shell>                                              ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    role="admin|office|accounts|leadingHand|tradie|client"          ║
// ║         — controls which nav groups render                         ║
// ║    page="overview|inbox|jobs|users|hours|costs|activity|settings"  ║
// ║         — which item is .active                                    ║
// ║    crumb="..."                                                     ║
// ║         — breadcrumb text in the topbar                            ║
// ║                                                                    ║
// ║  DENSITY                                                           ║
// ║  Reads :root[data-density] (set on <html>). The shell exposes a   ║
// ║  toggle button in the topbar that cycles compact → regular →      ║
// ║  roomy. Persisted in localStorage as 'buhl-site-office-density'.   ║
// ║                                                                    ║
// ║  The shell also mounts a single <cmd-palette> on <body> if there  ║
// ║  isn't one already, so ⌘K works everywhere without per-page glue. ║
// ╚════════════════════════════════════════════════════════════════════╝

// Nav groups per role (§05 nav grouping + role matrix).
// Empty groups never render.
const NAV = {
  // Group label → items. Items are objects {id, label, href, badge?}.
  Today: [
    { id: 'overview', label: 'Overview', href: '/admin/operations' },
    { id: 'inbox',    label: 'Inbox',    href: '/admin/approvals' },
  ],
  Manage: [
    { id: 'jobs',     label: 'Jobs',     href: '/admin/jobs' },
    { id: 'users',    label: 'Users',    href: '/admin/crew' },
    { id: 'hours',    label: 'Hours',    href: '/admin/hours' },
    { id: 'costs',    label: 'Costs',    href: '/admin/operations#costs' },
    { id: 'materials',label: 'Materials',href: '/admin/suppliers' },
    { id: 'assets',   label: 'Temps',    href: '/admin/assets' },
    { id: 'pipeline', label: 'Pipeline', href: '/admin/quotes' },
  ],
  System: [
    { id: 'activity', label: 'Activity', href: '/admin/operations#activity' },
    { id: 'settings', label: 'Settings', href: '/admin/settings' },
  ],
};

// Per §05 matrix — which surfaces each role can see.
const ROLE_ACCESS = {
  admin:        new Set(['overview','inbox','jobs','users','hours','costs','materials','assets','pipeline','activity','settings']),
  office:       new Set(['overview','inbox','jobs','users','hours','materials','assets','pipeline','activity']),
  accounts:     new Set(['overview','inbox','hours','costs','activity']),
  leadingHand:  new Set(['overview','jobs','hours','activity']),
  tradie:       new Set([]), // tradies don't see the site office (see §05)
  client:       new Set([]),
};

const DENSITY_KEY = 'buhl-site-office-density';
const DENSITIES = ['compact', 'regular', 'roomy'];

function readDensity() {
  const v = localStorage.getItem(DENSITY_KEY);
  return DENSITIES.includes(v) ? v : 'regular';
}
function applyDensity(d) {
  document.documentElement.dataset.density = d;
}

const STYLES = `
  :host {
    display: grid;
    grid-template-columns: var(--sidebar-w, 220px) 1fr;
    min-height: 100vh;
    background: var(--paper, #f3efe7);
    font-family: var(--body, sans-serif);
    color: var(--ink, #0d1b34);
  }

  /* ── Sidebar ── */
  aside.side {
    background: var(--navy, #0d1b34);
    color: rgba(255,255,255,.82);
    display: flex; flex-direction: column;
    position: sticky; top: 0; height: 100vh; overflow-y: auto;
    padding: 14px 10px;
    border-right: 1px solid rgba(255,255,255,.05);
  }
  .brand {
    display: flex; align-items: center; gap: 10px;
    padding: 6px 10px 14px;
    border-bottom: 1px solid rgba(255,255,255,.06);
    margin-bottom: 8px;
  }
  .brand .mk {
    width: 28px; height: 28px;
    background: #fff; color: var(--navy, #0d1b34);
    border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--display, sans-serif);
    font-weight: 800;
    font-size: 14px;
    letter-spacing: -.04em;
  }
  .brand .nm {
    color: #fff;
    font-family: var(--display, sans-serif);
    font-weight: 600;
    font-size: 13.5px;
    letter-spacing: -.005em;
  }
  .brand .sb {
    color: rgba(255,255,255,.42);
    font-size: 10.5px;
    margin-top: 1px;
  }
  .group-lab {
    font-family: var(--mono, monospace);
    font-size: 9.5px;
    font-weight: 700;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: rgba(255,255,255,.32);
    padding: 12px 10px 6px;
  }
  a.nav {
    display: flex; align-items: center; gap: 10px;
    padding: 7px 10px;
    border-radius: 6px;
    color: rgba(255,255,255,.72);
    font-size: 13px;
    font-weight: 500;
    position: relative;
    text-decoration: none;
    transition: background .14s, color .14s;
  }
  a.nav:hover { background: rgba(255,255,255,.04); color: #fff; }
  a.nav.on {
    background: rgba(255,255,255,.07);
    color: #fff;
  }
  a.nav.on::before {
    content: ""; position: absolute; left: 0; top: 50%; transform: translateY(-50%);
    width: 3px; height: 16px; background: var(--yellow, #f5d020);
    border-radius: 2px;
  }
  a.nav .ct {
    margin-left: auto;
    background: rgba(255,255,255,.08);
    color: rgba(255,255,255,.68);
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 999px;
    font-variant-numeric: tabular-nums;
  }
  a.nav .ct.warn { background: var(--yellow, #f5d020); color: var(--yellow-ink, #1d1700); }
  a.nav .ct.bad  { background: var(--red, #c0312f); color: #fff; }

  .me {
    margin-top: auto;
    padding: 10px;
    border-top: 1px solid rgba(255,255,255,.06);
    display: flex; align-items: center; gap: 10px;
  }
  .me .av {
    width: 28px; height: 28px;
    background: rgba(255,255,255,.1); color: #fff;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-family: var(--mono, monospace);
    font-weight: 700;
    font-size: 10.5px;
  }
  .me .nm { color: #fff; font-size: 13px; font-weight: 500; }
  .me .rl { color: rgba(255,255,255,.46); font-size: 10.5px; }

  /* ── Topbar ── */
  .topbar {
    display: flex; align-items: center; gap: 14px;
    padding: 10px 24px;
    background: var(--paper, #f3efe7);
    border-bottom: 1px solid var(--rule, #d2ccbf);
    position: sticky; top: 0; z-index: 40;
    min-height: var(--topbar-h, 54px);
  }
  .crumb {
    display: flex; align-items: center; gap: 6px;
    font-size: 12.5px;
    color: var(--ink-3, #6a7591);
  }
  .crumb b { color: var(--ink, #0d1b34); font-weight: 600; }
  .find {
    margin-left: auto;
    display: flex; align-items: center; gap: 8px;
    background: var(--paper-2, #ebe7df);
    border: 1px solid var(--rule, #d2ccbf);
    border-radius: 6px;
    padding: 5px 10px;
    width: 260px;
    cursor: pointer;
    font-family: var(--body, sans-serif);
    font-size: 12.5px;
    color: var(--ink-3, #6a7591);
    transition: background .14s, border-color .14s;
  }
  .find:hover { background: var(--paper-3, #dfdacf); }
  .find .ph { flex: 1; }
  .find .kb {
    background: var(--paper, #f3efe7);
    border: 1px solid var(--rule, #d2ccbf);
    border-bottom-width: 2px;
    border-radius: 4px;
    padding: 0 5px;
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    color: var(--ink-2, #2a3958);
    font-weight: 600;
  }
  .density {
    display: inline-flex; align-items: center; gap: 4px;
    border: 1px solid var(--rule, #d2ccbf);
    border-radius: 6px;
    padding: 2px;
    background: var(--paper, #f3efe7);
  }
  .density button {
    padding: 4px 8px;
    border-radius: 4px;
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    font-weight: 600;
    color: var(--ink-3, #6a7591);
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .density button.on {
    background: var(--paper-3, #dfdacf);
    color: var(--ink, #0d1b34);
  }

  /* ── Main ── */
  .main { display: flex; flex-direction: column; min-width: 0; }
  .body { padding: 20px 24px 40px; min-width: 0; }

  /* ── Mobile (< 880px) — sidebar collapses to a bottom rail (§05) ── */
  @media (max-width: 880px) {
    :host {
      grid-template-columns: 1fr;
    }
    aside.side {
      position: fixed; bottom: 0; left: 0; right: 0;
      top: auto;
      height: auto;
      flex-direction: row;
      padding: 6px 10px;
      gap: 4px;
      overflow-x: auto;
      overflow-y: hidden;
      z-index: 50;
      border-right: 0;
      border-top: 1px solid rgba(255,255,255,.06);
    }
    .brand, .group-lab, .me { display: none; }
    a.nav {
      flex-direction: column;
      gap: 2px;
      padding: 6px 10px;
      font-size: 10.5px;
    }
    a.nav .ct { margin-left: 0; }
    .body { padding-bottom: 72px; }
    .find { width: auto; max-width: 100%; }
  }
`;

class WorkspaceShell extends HTMLElement {
  static get observedAttributes() { return ['role', 'page', 'crumb', 'job', 'me-name']; }

  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <aside class="side" aria-label="Primary">
        <div class="brand">
          <span class="mk">b</span>
          <div>
            <div class="nm">bühl · site office</div>
            <div class="sb"></div>
          </div>
        </div>
        <nav class="navwrap"></nav>
        <div class="me">
          <span class="av"></span>
          <div>
            <div class="nm"></div>
            <div class="rl"></div>
          </div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="crumb"></div>
          <div class="find" role="button" tabindex="0" aria-label="Open command palette (⌘K)">
            <span class="ph">⌘K · Jump or do…</span>
            <span class="kb">⌘K</span>
          </div>
          <div class="density" role="tablist" aria-label="Density">
            <button data-d="compact" title="Compact">·</button>
            <button data-d="regular" title="Regular">··</button>
            <button data-d="roomy"   title="Roomy">···</button>
          </div>
          <slot name="topbar-action"></slot>
        </header>
        <div class="body">
          <slot></slot>
        </div>
      </div>
    `;

    this._navwrapEl = r.querySelector('.navwrap');
    this._crumbEl   = r.querySelector('.crumb');
    this._findEl    = r.querySelector('.find');
    this._sbEl      = r.querySelector('.brand .sb');
    this._densityEl = r.querySelector('.density');
    this._meAvEl    = r.querySelector('.me .av');
    this._meNmEl    = r.querySelector('.me .nm');
    this._meRlEl    = r.querySelector('.me .rl');

    this._findEl.addEventListener('click', () => this._openPalette());
    this._findEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this._openPalette(); }
    });
    this._densityEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-d]');
      if (!btn) return;
      const d = btn.dataset.d;
      localStorage.setItem(DENSITY_KEY, d);
      applyDensity(d);
      this._paintDensity();
    });
  }

  connectedCallback() {
    applyDensity(readDensity());
    this._ensurePalette();
    this._render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this._render();
  }

  /** Mount a singleton <cmd-palette> on <body> if missing. */
  _ensurePalette() {
    if (!document.querySelector('cmd-palette')) {
      // Lazy-import the module so any page including <workspace-shell> gets ⌘K.
      import('/components/cmd-palette.js').then(() => {
        if (!document.querySelector('cmd-palette')) {
          const p = document.createElement('cmd-palette');
          document.body.appendChild(p);
        }
      }).catch(err => console.warn('cmd-palette not available', err));
    }
  }

  _openPalette() {
    const p = document.querySelector('cmd-palette');
    if (p && typeof p.open === 'function') p.open();
  }

  _render() {
    const role = (this.getAttribute('role') || 'admin').trim();
    const page = (this.getAttribute('page') || '').trim();
    const crumb = this.getAttribute('crumb') || '';
    const meName = this.getAttribute('me-name') || '';

    // Sidebar brand sub-text — show the role.
    this._sbEl.textContent = role === 'admin' ? '' : roleLabel(role);

    // Nav.
    this._renderNav(role, page);

    // Crumb. Format: "Site Office › Overview" → render last segment bold.
    this._crumbEl.innerHTML = '';
    const parts = crumb.split('›').map(s => s.trim()).filter(Boolean);
    parts.forEach((p, i) => {
      const span = document.createElement(i === parts.length - 1 ? 'b' : 'span');
      span.textContent = p;
      this._crumbEl.appendChild(span);
      if (i < parts.length - 1) {
        const sep = document.createElement('span');
        sep.textContent = '›';
        sep.style.opacity = '.5';
        this._crumbEl.appendChild(sep);
      }
    });

    // Me chip.
    if (meName) {
      this._meAvEl.textContent = initials(meName);
      this._meNmEl.textContent = meName;
      this._meRlEl.textContent = roleLabel(role);
    }

    this._paintDensity();
  }

  _renderNav(role, page) {
    const access = ROLE_ACCESS[role] || ROLE_ACCESS.admin;
    this._navwrapEl.textContent = '';
    Object.entries(NAV).forEach(([groupName, items]) => {
      const visible = items.filter(it => access.has(it.id));
      if (!visible.length) return; // empty groups never render
      const lab = document.createElement('div');
      lab.className = 'group-lab';
      lab.textContent = groupName;
      this._navwrapEl.appendChild(lab);
      visible.forEach(it => {
        const a = document.createElement('a');
        a.className = 'nav';
        a.href = it.href;
        if (it.id === page) a.classList.add('on');
        const lab = document.createElement('span'); lab.textContent = it.label;
        a.appendChild(lab);
        if (it.badge) {
          const ct = document.createElement('span');
          ct.className = 'ct ' + (it.badgeKind || '');
          ct.textContent = String(it.badge);
          a.appendChild(ct);
        }
        this._navwrapEl.appendChild(a);
      });
    });
  }

  _paintDensity() {
    const cur = readDensity();
    this._densityEl.querySelectorAll('button[data-d]').forEach(b => {
      b.classList.toggle('on', b.dataset.d === cur);
    });
  }

  /**
   * Set a count badge on a nav item. Kind: '' | 'warn' | 'bad'.
   * e.g. shell.setBadge('hours', 15, 'bad');
   */
  setBadge(id, value, kind = '') {
    const item = Object.values(NAV).flat().find(x => x.id === id);
    if (item) {
      item.badge = value;
      item.badgeKind = kind;
    }
    if (this.isConnected) this._renderNav(this.getAttribute('role') || 'admin', this.getAttribute('page') || '');
  }
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
function roleLabel(role) {
  switch (role) {
    case 'admin':       return 'Admin';
    case 'office':      return 'Office';
    case 'accounts':    return 'Accounts';
    case 'leadingHand': return 'Leading hand';
    case 'tradie':      return 'Tradie';
    case 'client':      return 'Client';
    default:            return role || '';
  }
}

if (!customElements.get('workspace-shell')) {
  customElements.define('workspace-shell', WorkspaceShell);
}
