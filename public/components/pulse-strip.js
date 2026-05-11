// ╔════════════════════════════════════════════════════════════════════╗
// ║  <pulse-strip> · S-05 · BuhlOS site office                         ║
// ║                                                                    ║
// ║  Per brief §02 and §15. Four numbers, equal weight, each clickable ║
// ║  to its queue. Used at the top of Overview and per-job detail.     ║
// ║                                                                    ║
// ║  These are NOT verb cards — they're an at-a-glance pulse of the    ║
// ║  business. Overview's exception cards (§03) are still the focus.   ║
// ║                                                                    ║
// ║  Usage:                                                            ║
// ║    <pulse-strip>                                                   ║
// ║      <a href="/admin/hours" data-label="Hours" data-sub="this wk"  ║
// ║         data-value="256.5"></a>                                    ║
// ║      ...                                                           ║
// ║    </pulse-strip>                                                  ║
// ║                                                                    ║
// ║  Or imperatively via .setItems([{label, value, sub, href}]).       ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 1px;
    background: var(--rule, #d2ccbf);
    border: 1px solid var(--rule, #d2ccbf);
    border-radius: var(--r-lg, 10px);
    overflow: hidden;
    font-family: var(--body, sans-serif);
  }
  .cell {
    background: var(--paper, #f3efe7);
    padding: 14px 16px;
    display: flex; flex-direction: column; gap: 4px;
    color: var(--ink, #0d1b34);
    text-decoration: none;
    transition: background .14s;
  }
  .cell[href]:hover { background: var(--paper-2, #ebe7df); }
  .lab {
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    font-weight: 600;
    color: var(--ink-3, #6a7591);
    text-transform: uppercase;
    letter-spacing: .08em;
  }
  .val {
    font-family: var(--display, sans-serif);
    font-weight: 700;
    font-size: 24px;
    line-height: 1.1;
    color: var(--ink, #0d1b34);
    font-variant-numeric: tabular-nums;
    letter-spacing: -.01em;
  }
  .val em {
    font-style: normal;
    color: var(--ink-3, #6a7591);
    font-size: 16px;
  }
  .sub {
    font-size: var(--type-meta, 12px);
    color: var(--ink-3, #6a7591);
  }
`;

class PulseStrip extends HTMLElement {
  constructor() {
    super();
    this._root = this.attachShadow({ mode: 'open' });
    this._root.innerHTML = `<style>${STYLES}</style><div class="grid"></div>`;
    this._grid = this._root.querySelector('.grid');
    // The :host already lays out the grid; the inner div lets us preserve markup
    // when slots are streamed in via DOM.
  }

  connectedCallback() {
    this._renderFromChildren();
  }

  /**
   * Render items from <a data-label data-value data-sub href> children.
   * Re-runs on slotchange.
   */
  _renderFromChildren() {
    // Build cells out of the light-DOM children once on mount.
    const cells = Array.from(this.children).map(c => ({
      label: c.dataset.label || c.getAttribute('data-label') || '',
      value: c.dataset.value || c.getAttribute('data-value') || c.textContent || '',
      sub:   c.dataset.sub   || c.getAttribute('data-sub')   || '',
      href:  c.getAttribute('href') || null,
    }));
    this.setItems(cells);
  }

  setItems(items) {
    if (!Array.isArray(items)) return;
    this._items = items;
    // The :host is the grid container — render cells inside the shadow root
    // directly (no light DOM cleanup needed; we overwrite each call).
    while (this._root.lastChild && this._root.lastChild.tagName !== 'STYLE') {
      this._root.removeChild(this._root.lastChild);
    }
    items.forEach(it => {
      const el = document.createElement(it.href ? 'a' : 'div');
      el.className = 'cell';
      if (it.href) el.setAttribute('href', it.href);
      const lab = document.createElement('div'); lab.className = 'lab'; lab.textContent = it.label || '';
      const val = document.createElement('div'); val.className = 'val';
      // Allow value like "256.5" → "256<em>.5</em>"
      const v = String(it.value);
      const dot = v.indexOf('.');
      if (dot !== -1) {
        val.appendChild(document.createTextNode(v.slice(0, dot)));
        const em = document.createElement('em');
        em.textContent = v.slice(dot);
        val.appendChild(em);
      } else {
        val.textContent = v;
      }
      const sub = document.createElement('div'); sub.className = 'sub'; sub.textContent = it.sub || '';
      el.appendChild(lab); el.appendChild(val); el.appendChild(sub);
      this._root.appendChild(el);
    });
    // Hide the light-DOM children — we've copied them in.
    Array.from(this.children).forEach(c => { c.style.display = 'none'; });
  }
}

if (!customElements.get('pulse-strip')) {
  customElements.define('pulse-strip', PulseStrip);
}
