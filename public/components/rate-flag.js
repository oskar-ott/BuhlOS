// ╔════════════════════════════════════════════════════════════════════╗
// ║  <rate-flag> · S-06 · BuhlOS site office                           ║
// ║                                                                    ║
// ║  Per brief §09 (Hours · anomaly flag) and §15.                     ║
// ║                                                                    ║
// ║  Hour entries above policy threshold get a YELLOW flag. Not a      ║
// ║  block. Not red. Reviewable, not refusable.                        ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    hours="11.0"           — number to render with .0 / .5 etc      ║
// ║    threshold="9"          — comparison threshold (visual only)     ║
// ║    note="weekend"         — optional reason (trailing muted text)  ║
// ║    severity="warn|info"   — warn (default, yellow) | info (paper)  ║
// ║                                                                    ║
// ║  The 'warn' style maps to the brief's "yellow flag" — used for     ║
// ║  any anomaly worth a look (over 9h, weekend, public holiday).      ║
// ║  'info' is the calm variant for entries that aren't anomalies but  ║
// ║  still want a chip (e.g. the LH's roll-up of a tradie's day).      ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    display: inline-flex; align-items: center; gap: 8px;
    font-family: var(--mono, monospace);
    font-size: 11px;
    color: var(--ink-2, #2a3958);
    vertical-align: middle;
  }
  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--yellow, #f5d020);
    color: var(--yellow-ink, #1d1700);
    padding: 2px 8px;
    border-radius: var(--r-sm, 4px);
    font-family: var(--mono, monospace);
    font-weight: 700;
    line-height: 1.4;
    font-variant-numeric: tabular-nums;
  }
  :host([severity="info"]) .pill {
    background: var(--paper-2, #ebe7df);
    color: var(--ink, #0d1b34);
    font-weight: 600;
  }
  .note {
    color: var(--ink-3, #6a7591);
    font-family: var(--body, sans-serif);
    font-size: 11.5px;
  }
`;

class RateFlag extends HTMLElement {
  static get observedAttributes() {
    return ['hours', 'threshold', 'note', 'severity'];
  }
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <span class="pill"><span class="g">⚑</span><span class="h"></span></span>
      <span class="note"></span>
    `;
    this._gEl = r.querySelector('.g');
    this._hEl = r.querySelector('.h');
    this._nEl = r.querySelector('.note');
  }

  attributeChangedCallback() { this._render(); }
  connectedCallback() { this._render(); }

  _render() {
    const sev = this.getAttribute('severity') || 'warn';
    this._gEl.textContent = sev === 'info' ? '·' : '⚑';
    const hours = this.getAttribute('hours');
    this._hEl.textContent = hours == null ? '' : `${hours}h`;
    const note = this.getAttribute('note');
    const th = this.getAttribute('threshold');
    let suffix = '';
    if (note) {
      suffix = note;
    } else if (th) {
      suffix = `over ${th} — review`;
    }
    this._nEl.textContent = suffix;
    this._nEl.style.display = suffix ? '' : 'none';
  }
}

if (!customElements.get('rate-flag')) {
  customElements.define('rate-flag', RateFlag);
}
