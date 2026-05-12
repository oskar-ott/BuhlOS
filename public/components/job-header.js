// ╔════════════════════════════════════════════════════════════════════╗
// ║  <job-header> · C-01 · BuhlOS Job Interface                        ║
// ║                                                                    ║
// ║  Per brief §02 (job header). Sticky top. Solid navy band. Used by  ║
// ║  every job-side screen.                                            ║
// ║                                                                    ║
// ║  Holds: dot · job name · code · % · sync stamp (right-edge).       ║
// ║  No bell, no red dot. The <buhl-mark> on the right shrinks to a    ║
// ║  14px sync indicator (idle / pulsing / offline / failed).          ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    name="19–23 Birdwood Ave"                                       ║
// ║    code="IV3232"                                                   ║
// ║    percent="64"                                                    ║
// ║    sync="idle|pulsing|offline|failed"  — default "idle"            ║
// ║    back-href="..."   — when set, renders a left-side back arrow    ║
// ║                                                                    ║
// ║  Events:                                                           ║
// ║    job-header:back  — when the back arrow is tapped                ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    display: block;
    position: sticky; top: 0; z-index: 50;
    background: var(--navy, #0d1b34);
    color: var(--paper, #f3efe7);
    padding-top: env(safe-area-inset-top);
  }
  .row {
    display: flex; align-items: center;
    height: var(--header-h, 52px);
    padding: 0 14px;
    gap: 12px;
  }
  .back {
    display: inline-flex; align-items: center; justify-content: center;
    width: 36px; height: 36px;
    margin-left: -10px;
    border-radius: 6px;
    color: rgba(255, 255, 255, .8);
    background: transparent;
    cursor: pointer;
    border: 0;
    font-family: var(--mono, monospace);
    font-size: 20px;
    font-weight: 600;
    line-height: 1;
  }
  .back:hover { background: rgba(255, 255, 255, .08); color: #fff; }
  .name {
    font-family: var(--display, sans-serif);
    font-weight: 700;
    font-size: var(--t-m, 18px);
    letter-spacing: -.018em;
    color: #fff;
    flex: 1;
    min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .code {
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    letter-spacing: .08em;
    color: rgba(255, 255, 255, .55);
    font-weight: 500;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .pct {
    font-family: var(--display, sans-serif);
    font-weight: 800;
    font-size: 17px;
    color: var(--yellow, #f5d020);
    letter-spacing: -.01em;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }
  .sync {
    display: inline-flex;
    width: 14px; height: 14px;
    align-items: center; justify-content: center;
    border-radius: 50%;
    flex-shrink: 0;
    position: relative;
  }
  .sync::after {
    content: ""; position: absolute; inset: 3px;
    border-radius: 50%;
    background: var(--green, #1f8b5a);
    transition: background .14s;
  }
  :host([sync="pulsing"]) .sync::after { background: var(--amber, #d68a1a); animation: pulse 1s infinite ease-in-out; }
  :host([sync="offline"]) .sync::after { background: transparent; box-shadow: inset 0 0 0 1.5px rgba(255, 255, 255, .6); }
  :host([sync="failed"])  .sync::after { background: var(--red, #c0312f); }
  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(.7); opacity: .6; }
  }

  /* Hide back arrow unless back-href is set. */
  .back { display: none; }
  :host([back-href]) .back { display: inline-flex; }
`;

class JobHeader extends HTMLElement {
  static get observedAttributes() {
    return ['name', 'code', 'percent', 'sync', 'back-href'];
  }
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <div class="row">
        <button class="back" type="button" aria-label="Back">←</button>
        <span class="name"></span>
        <span class="code"></span>
        <span class="pct"></span>
        <span class="sync" aria-label="Sync state"></span>
      </div>
    `;
    this._backEl = r.querySelector('.back');
    this._nameEl = r.querySelector('.name');
    this._codeEl = r.querySelector('.code');
    this._pctEl  = r.querySelector('.pct');
    this._backEl.addEventListener('click', () => {
      const href = this.getAttribute('back-href');
      this.dispatchEvent(new CustomEvent('job-header:back', { bubbles: true, composed: true, detail: { href } }));
      if (href) window.location.assign(href);
    });
  }
  attributeChangedCallback() { this._render(); }
  connectedCallback() { this._render(); }
  _render() {
    this._nameEl.textContent = this.getAttribute('name') || '';
    const code = this.getAttribute('code') || '';
    this._codeEl.textContent = code;
    this._codeEl.style.display = code ? '' : 'none';
    const pct = this.getAttribute('percent');
    if (pct != null && pct !== '') {
      this._pctEl.textContent = `${pct}%`;
      this._pctEl.style.display = '';
    } else {
      this._pctEl.style.display = 'none';
    }
  }
}

if (!customElements.get('job-header')) {
  customElements.define('job-header', JobHeader);
}
