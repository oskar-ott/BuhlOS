// ╔════════════════════════════════════════════════════════════════════╗
// ║  <progress-bar> · C-02 · BuhlOS Job Interface                      ║
// ║                                                                    ║
// ║  Per brief §17. Yellow fill on paper-3 track. Used in Job Home,    ║
// ║  KPI strip, area cards.                                            ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    percent="64"                                                    ║
// ║    label="Overall"   — optional caption above (uppercase mono)     ║
// ║    size="default"    — default | small (2px track on area cards)   ║
// ║    tone="yellow|green|amber|red"  — fill colour                    ║
// ║                                                                    ║
// ║  Light DOM friendly — single host, no slots. Trivial to compose.   ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    display: block;
    --h: 6px;
    width: 100%;
  }
  :host([size="small"]) { --h: 2px; }
  .head {
    display: flex; justify-content: space-between;
    font-family: var(--mono, monospace);
    font-size: 10px;
    letter-spacing: .08em;
    color: var(--ink-3, #6a7591);
    text-transform: uppercase;
    margin-bottom: 4px;
  }
  .head .lab { font-weight: 600; }
  .head .pct { font-weight: 700; color: var(--ink, #0d1b34); font-variant-numeric: tabular-nums; }
  .track {
    height: var(--h);
    background: var(--paper-3, #dfdacf);
    border-radius: 999px;
    overflow: hidden;
    position: relative;
  }
  .fill {
    height: 100%;
    background: var(--yellow, #f5d020);
    border-radius: inherit;
    transition: width .24s ease;
  }
  :host([tone="green"]) .fill { background: var(--green, #1f8b5a); }
  :host([tone="amber"]) .fill { background: var(--amber, #d68a1a); }
  :host([tone="red"])   .fill { background: var(--red, #c0312f); }

  /* When no label, hide the head row entirely. */
  :host(:not([label])) .head { display: none; }
`;

class ProgressBar extends HTMLElement {
  static get observedAttributes() { return ['percent', 'label', 'tone', 'size']; }
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <div class="head"><span class="lab"></span><span class="pct"></span></div>
      <div class="track"><div class="fill"></div></div>
    `;
    this._labEl  = r.querySelector('.lab');
    this._pctEl  = r.querySelector('.pct');
    this._fillEl = r.querySelector('.fill');
  }
  attributeChangedCallback() { this._render(); }
  connectedCallback() { this._render(); }
  _render() {
    const lab = this.getAttribute('label') || '';
    this._labEl.textContent = lab;
    let pct = Math.max(0, Math.min(100, Number(this.getAttribute('percent')) || 0));
    this._fillEl.style.width = pct + '%';
    this._pctEl.textContent = pct + '%';
  }
}

if (!customElements.get('progress-bar')) {
  customElements.define('progress-bar', ProgressBar);
}
