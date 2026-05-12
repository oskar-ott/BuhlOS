// ╔════════════════════════════════════════════════════════════════════╗
// ║  <task-row> · C-04 · BuhlOS Job Interface                          ║
// ║                                                                    ║
// ║  Per brief §11. The row that hosts <seg-status> on expand and      ║
// ║  <snag-button> on long-press / hover.                              ║
// ║                                                                    ║
// ║  Layout:                                                           ║
// ║    dot · name + optional <product-chip> · status segment · snag    ║
// ║                                                                    ║
// ║  Snagged is derived (brief §10/§11): if snag-count > 0 the row    ║
// ║  gets a red left border. Status is never "snagged" stored on the   ║
// ║  task — only "not-started | in-progress | complete".              ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    name="Light fittings"                                           ║
// ║    product-code="Clipsal 30 series" (optional — renders chip)     ║
// ║    status="not-started|in-progress|complete"                       ║
// ║    snag-count="0" (default; >0 → red border)                       ║
// ║    expanded — when set, shows the seg-status control               ║
// ║    job-id="..." area-id="..." task-id="..."  — context for snag    ║
// ║                                                                    ║
// ║  Events:                                                           ║
// ║    task-row:toggle — when the row chevron is tapped                ║
// ║    task-row:change — when seg-status changes (proxied)             ║
// ║    snag-button:open — bubbles from the snag button                 ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    display: block;
    background: var(--paper, #f3efe7);
    border: 1px solid var(--rule, #d2ccbf);
    border-radius: var(--r, 6px);
    transition: background var(--tx, .16s);
    overflow: hidden;
  }
  :host([snag-count]:not([snag-count="0"])) { border-left: 3px solid var(--red, #c0312f); }

  .row {
    display: grid;
    grid-template-columns: 16px 1fr auto;
    align-items: center;
    gap: 12px;
    min-height: 52px;
    padding: 10px 14px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .row:hover { background: var(--paper-2, #ebe7df); }

  .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--ink-3, #6a7591);
    justify-self: center;
  }
  :host([status="in-progress"]) .dot { background: var(--amber, #d68a1a); }
  :host([status="complete"])    .dot { background: var(--green, #1f8b5a); }

  .body {
    display: flex; align-items: center; gap: 8px;
    min-width: 0;
    flex-wrap: wrap;
  }
  .name {
    font-family: var(--display, sans-serif);
    font-weight: 600;
    font-size: var(--t-b, 15px);
    color: var(--ink, #0d1b34);
    letter-spacing: -.005em;
  }
  .chev {
    color: var(--ink-3, #6a7591);
    font-family: var(--mono, monospace);
    font-size: 14px;
    font-weight: 600;
    transition: transform var(--tx, .16s);
  }
  :host([expanded]) .chev { transform: rotate(90deg); }

  .expand {
    padding: 0 14px 14px;
    display: flex; flex-direction: column; gap: 10px;
  }
  :host(:not([expanded])) .expand { display: none; }
  .controls {
    display: flex; gap: 10px;
    align-items: stretch;
  }
  .controls seg-status { flex: 1; }
`;

class TaskRow extends HTMLElement {
  static get observedAttributes() {
    return ['name', 'product-code', 'status', 'snag-count', 'expanded', 'job-id', 'area-id', 'task-id'];
  }
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <div class="row" role="button" tabindex="0">
        <span class="dot" aria-hidden="true"></span>
        <div class="body">
          <span class="name"></span>
          <product-chip class="pc"></product-chip>
        </div>
        <span class="chev" aria-hidden="true">▸</span>
      </div>
      <div class="expand">
        <div class="controls">
          <seg-status></seg-status>
          <snag-button size="sm"></snag-button>
        </div>
      </div>
    `;
    this._rowEl = r.querySelector('.row');
    this._nameEl = r.querySelector('.name');
    this._pcEl = r.querySelector('product-chip');
    this._segEl = r.querySelector('seg-status');
    this._snagEl = r.querySelector('snag-button');

    this._rowEl.addEventListener('click', () => this._toggle());
    this._rowEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this._toggle(); }
    });
    this._segEl.addEventListener('seg-status:change', (ev) => {
      // Mirror onto the host so the dot updates immediately.
      this.setAttribute('status', ev.detail.value);
      this.dispatchEvent(new CustomEvent('task-row:change', {
        bubbles: true, composed: true,
        detail: {
          value: ev.detail.value,
          previous: ev.detail.previous,
          jobId: this.getAttribute('job-id'),
          areaId: this.getAttribute('area-id'),
          taskId: this.getAttribute('task-id'),
        },
      }));
    });
  }
  connectedCallback() {
    // Lazy-load deps.
    if (!customElements.get('seg-status'))   import('/components/seg-status.js').catch(() => {});
    if (!customElements.get('snag-button'))  import('/components/snag-button.js').catch(() => {});
    if (!customElements.get('product-chip')) import('/components/product-chip.js').catch(() => {});
    this._render();
  }
  attributeChangedCallback() { this._render(); }
  _toggle() {
    if (this.hasAttribute('expanded')) this.removeAttribute('expanded');
    else this.setAttribute('expanded', '');
    this.dispatchEvent(new CustomEvent('task-row:toggle', { bubbles: true, composed: true, detail: { expanded: this.hasAttribute('expanded') } }));
  }
  _render() {
    this._nameEl.textContent = this.getAttribute('name') || '';
    const code = this.getAttribute('product-code') || '';
    if (code) {
      this._pcEl.setAttribute('code', code);
      this._pcEl.style.display = '';
    } else {
      this._pcEl.style.display = 'none';
    }
    this._segEl.setAttribute('value', this.getAttribute('status') || 'not-started');
    // Forward context to the snag button.
    ['job-id', 'area-id', 'task-id'].forEach(k => {
      const v = this.getAttribute(k);
      if (v) this._snagEl.setAttribute(k, v); else this._snagEl.removeAttribute(k);
    });
  }
}

if (!customElements.get('task-row')) {
  customElements.define('task-row', TaskRow);
}
