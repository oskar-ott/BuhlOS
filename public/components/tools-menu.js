// ╔════════════════════════════════════════════════════════════════════╗
// ║  <tools-menu> · C-08 · BuhlOS Job Interface                        ║
// ║                                                                    ║
// ║  Per brief §14 & §17. Three groups, fixed order. Same component   ║
// ║  on phone (bottom sheet) and desktop (left rail). Role-aware —    ║
// ║  empty groups hide entirely.                                       ║
// ║                                                                    ║
// ║  THREE GROUPS (fixed order):                                       ║
// ║    Run     — Snags · Hours · Plans                                 ║
// ║    Capture — Photos · Note                                         ║
// ║    Look up — Product catalogue · Manuals                           ║
// ║                                                                    ║
// ║  Usage:                                                            ║
// ║    <tools-menu role="tradie" job-id="iv3232"></tools-menu>         ║
// ║                                                                    ║
// ║  The consumer can override the item list by setting .items =       ║
// ║  [{ id, label, group, href, count, hidden, roles }] before the     ║
// ║  element connects.                                                 ║
// ║                                                                    ║
// ║  Events:                                                           ║
// ║    tools-menu:select  detail = { id, href }                        ║
// ╚════════════════════════════════════════════════════════════════════╝

const GROUPS = ['Run', 'Capture', 'Look up'];

const DEFAULT_ITEMS = [
  { id: 'snags',     group: 'Run',     label: 'Snags',     href: '#snags',   roles: ['tradie', 'leadingHand', 'admin', 'client'] },
  { id: 'hours',     group: 'Run',     label: 'Hours',     href: '#hours',   roles: ['tradie', 'leadingHand', 'admin'] },
  { id: 'plans',     group: 'Run',     label: 'Plans',     href: '#plans',   roles: ['tradie', 'leadingHand', 'admin', 'client'] },
  { id: 'photos',    group: 'Capture', label: 'Photos',    href: '#photos',  roles: ['tradie', 'leadingHand', 'admin'] },
  { id: 'note',      group: 'Capture', label: 'Note',      href: '#note',    roles: ['tradie', 'leadingHand', 'admin'] },
  { id: 'catalogue', group: 'Look up', label: 'Catalogue', href: '#catalogue', roles: ['tradie', 'leadingHand', 'admin', 'client'] },
  { id: 'manuals',   group: 'Look up', label: 'Manuals',   href: '#manuals', roles: ['tradie', 'leadingHand', 'admin', 'client'] },
];

const STYLES = `
  :host {
    display: block;
    font-family: var(--display, sans-serif);
    color: var(--ink, #0d1b34);
  }
  .group { margin-bottom: 18px; }
  .group:last-child { margin-bottom: 0; }
  .group-lab {
    font-family: var(--mono, monospace);
    font-size: 10px;
    font-weight: 600;
    letter-spacing: .14em;
    text-transform: uppercase;
    color: var(--ink-3, #6a7591);
    margin-bottom: 6px;
  }
  .items {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .item {
    display: flex; align-items: center; justify-content: space-between;
    gap: 8px;
    background: var(--paper, #f3efe7);
    border: 1px solid var(--rule, #d2ccbf);
    border-radius: var(--r, 6px);
    padding: 12px 14px;
    min-height: var(--tap, 44px);
    cursor: pointer;
    font-family: var(--display, sans-serif);
    font-weight: 600;
    font-size: 14px;
    color: var(--ink, #0d1b34);
    text-decoration: none;
    transition: background var(--tx, .16s);
    -webkit-tap-highlight-color: transparent;
  }
  .item:hover { background: var(--paper-2, #ebe7df); }
  .item .ct {
    background: var(--paper-3, #dfdacf);
    color: var(--navy, #0d1b34);
    font-family: var(--mono, monospace);
    font-size: 11px;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 999px;
    font-variant-numeric: tabular-nums;
  }
  .item .ct.bad { background: var(--red, #c0312f); color: #fff; }

  /* Left-rail variant for tablet/desktop. */
  :host([variant="rail"]) .items {
    grid-template-columns: 1fr;
    gap: 4px;
  }
  :host([variant="rail"]) .item {
    padding: 9px 12px;
    min-height: 38px;
    font-size: 13px;
  }
`;

class ToolsMenu extends HTMLElement {
  static get observedAttributes() { return ['role', 'variant', 'job-id']; }
  constructor() {
    super();
    this._items = null; // override via property
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `<style>${STYLES}</style><div class="wrap"></div>`;
    this._wrapEl = r.querySelector('.wrap');
  }
  set items(v) { this._items = Array.isArray(v) ? v : null; if (this.isConnected) this._render(); }
  get items() { return this._items || DEFAULT_ITEMS; }

  connectedCallback() { this._render(); }
  attributeChangedCallback() { if (this.isConnected) this._render(); }

  _render() {
    const role = this.getAttribute('role') || 'tradie';
    const jobId = this.getAttribute('job-id') || '';

    // Filter by role, then group by .group, preserving the fixed order.
    const grouped = new Map();
    GROUPS.forEach(g => grouped.set(g, []));
    for (const it of this.items) {
      if (it.hidden) continue;
      if (it.roles && !it.roles.includes(role)) continue;
      const g = it.group && grouped.has(it.group) ? it.group : 'Run';
      grouped.get(g).push(it);
    }

    this._wrapEl.textContent = '';
    for (const [g, items] of grouped) {
      if (!items.length) continue;     // empty groups never render (§14)
      const block = document.createElement('div');
      block.className = 'group';
      const lab = document.createElement('div');
      lab.className = 'group-lab';
      lab.textContent = g;
      block.appendChild(lab);
      const list = document.createElement('div');
      list.className = 'items';
      for (const it of items) {
        const a = document.createElement('a');
        a.className = 'item';
        const href = (it.href || '').replace(':jobId', encodeURIComponent(jobId));
        if (href) a.href = href;
        a.dataset.id = it.id;
        const lab = document.createElement('span');
        lab.textContent = it.label;
        a.appendChild(lab);
        if (it.count != null && it.count > 0) {
          const ct = document.createElement('span');
          ct.className = 'ct' + (it.countBad ? ' bad' : '');
          ct.textContent = String(it.count);
          a.appendChild(ct);
        }
        a.addEventListener('click', (ev) => {
          this.dispatchEvent(new CustomEvent('tools-menu:select', {
            bubbles: true, composed: true,
            detail: { id: it.id, href },
          }));
          if (!href || href === '#') ev.preventDefault();
        });
        list.appendChild(a);
      }
      block.appendChild(list);
      this._wrapEl.appendChild(block);
    }
  }
}

if (!customElements.get('tools-menu')) {
  customElements.define('tools-menu', ToolsMenu);
}
