// ╔════════════════════════════════════════════════════════════════════╗
// ║  <area-card> · C-03 · BuhlOS Job Interface                         ║
// ║                                                                    ║
// ║  Per brief §17. Dot · name · meta · count chip · chevron.          ║
// ║  Two densities — card (Work Areas list) or row (compact contexts). ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    name="Unit 14"                                                  ║
// ║    sub="In progress · 67%"                                         ║
// ║    status="not-started|in-progress|complete|snagged"               ║
// ║    snag-count="3"     — renders a red count chip                   ║
// ║    percent="67"       — optional 2px progress-bar underneath       ║
// ║    density="card|row" — card (with padding) | row (compact)        ║
// ║    href="..."         — when set, the host is clickable            ║
// ║                                                                    ║
// ║  Events:                                                           ║
// ║    area-card:tap — host click (when no href)                       ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    display: block;
    background: var(--paper, #f3efe7);
    border: 1px solid var(--rule, #d2ccbf);
    border-radius: var(--r, 6px);
    cursor: default;
    transition: background var(--tx, .16s);
  }
  :host([href]) { cursor: pointer; }
  :host([href]):hover, :host([href]):active { background: var(--paper-2, #ebe7df); }
  :host([status="snagged"]) { border-color: var(--red, #c0312f); }

  .row {
    display: grid;
    grid-template-columns: 16px 1fr auto auto;
    align-items: center;
    gap: 12px;
    min-height: 56px;
    padding: 12px 14px;
  }
  :host([density="row"]) .row {
    min-height: 44px;
    padding: 8px 12px;
  }

  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--ink-3, #6a7591);
    justify-self: center;
  }
  :host([status="in-progress"]) .dot { background: var(--amber, #d68a1a); }
  :host([status="complete"])    .dot { background: var(--green, #1f8b5a); }
  :host([status="snagged"])     .dot { background: var(--red, #c0312f); }

  .body { min-width: 0; }
  .name {
    font-family: var(--display, sans-serif);
    font-weight: 700;
    font-size: var(--t-b, 15px);
    color: var(--ink, #0d1b34);
    letter-spacing: -.005em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .sub {
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    letter-spacing: .04em;
    color: var(--ink-3, #6a7591);
    margin-top: 3px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }

  .chip {
    background: var(--red, #c0312f);
    color: #fff;
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 999px;
    line-height: 1.6;
    display: none;
  }
  :host([snag-count]) .chip { display: inline-flex; }
  :host([snag-count="0"]) .chip { display: none; }

  .chev {
    color: var(--ink-3, #6a7591);
    font-family: var(--mono, monospace);
    font-size: 14px;
    font-weight: 600;
  }
  :host(:not([href])) .chev { display: none; }

  progress-bar {
    display: block;
    padding: 0 14px 12px;
  }
  :host([density="row"]) progress-bar { padding: 0 12px 8px; }
  :host(:not([percent])) progress-bar { display: none; }
`;

class AreaCard extends HTMLElement {
  static get observedAttributes() {
    return ['name', 'sub', 'status', 'snag-count', 'percent', 'density', 'href'];
  }
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <div class="row">
        <span class="dot" aria-hidden="true"></span>
        <div class="body">
          <div class="name"></div>
          <div class="sub"></div>
        </div>
        <span class="chip"></span>
        <span class="chev" aria-hidden="true">▸</span>
      </div>
      <progress-bar size="small"></progress-bar>
    `;
    this._nameEl = r.querySelector('.name');
    this._subEl  = r.querySelector('.sub');
    this._chipEl = r.querySelector('.chip');
    this._barEl  = r.querySelector('progress-bar');
    this.addEventListener('click', this._onClick);
  }
  attributeChangedCallback() { this._render(); }
  connectedCallback() {
    // Lazy-load the progress-bar dep.
    if (!customElements.get('progress-bar')) {
      import('/components/progress-bar.js').catch(() => {});
    }
    this._render();
  }
  _onClick = (ev) => {
    const href = this.getAttribute('href');
    if (href) { window.location.assign(href); return; }
    this.dispatchEvent(new CustomEvent('area-card:tap', { bubbles: true, composed: true }));
  };
  _render() {
    this._nameEl.textContent = this.getAttribute('name') || '';
    this._subEl.textContent  = this.getAttribute('sub') || '';
    this._subEl.style.display = this.hasAttribute('sub') ? '' : 'none';
    const snag = this.getAttribute('snag-count');
    if (snag && Number(snag) > 0) {
      this._chipEl.textContent = snag;
    } else {
      this._chipEl.textContent = '';
    }
    const pct = this.getAttribute('percent');
    if (pct != null && pct !== '') {
      this._barEl.setAttribute('percent', pct);
    }
  }
}

if (!customElements.get('area-card')) {
  customElements.define('area-card', AreaCard);
}
