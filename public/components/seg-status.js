// ╔════════════════════════════════════════════════════════════════════╗
// ║  <seg-status> · C-05 · BuhlOS Job Interface                        ║
// ║                                                                    ║
// ║  Per brief §11. 3 states. 44px tall. **No dropdown, ever.**        ║
// ║                                                                    ║
// ║  States:                                                           ║
// ║    not-started   (default ink-3, no fill)                          ║
// ║    in-progress   (amber fill, paper ink)                           ║
// ║    complete      (green fill, paper ink)                           ║
// ║                                                                    ║
// ║  Tapping a segment writes optimistically (the component dispatches ║
// ║  seg-status:change immediately + updates visually); the caller     ║
// ║  is responsible for the queued API write and rolls back on        ║
// ║  failure via .setAttribute('value', oldValue).                     ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    value="not-started|in-progress|complete"                        ║
// ║    disabled                                                        ║
// ║                                                                    ║
// ║  Events:                                                           ║
// ║    seg-status:change  detail = { value, previous }                 ║
// ╚════════════════════════════════════════════════════════════════════╝

const STATES = ['not-started', 'in-progress', 'complete'];
const LABELS = {
  'not-started': 'Not started',
  'in-progress': 'In progress',
  'complete':    'Complete',
};

const STYLES = `
  :host {
    display: block;
    --h: 44px;
  }
  .group {
    display: flex;
    height: var(--h);
    background: var(--paper, #f3efe7);
    border: 1px solid var(--rule, #d2ccbf);
    border-radius: var(--r, 6px);
    overflow: hidden;
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    letter-spacing: .06em;
    text-transform: uppercase;
    font-weight: 600;
  }
  button {
    flex: 1;
    padding: 0 6px;
    text-align: center;
    background: var(--paper, #f3efe7);
    color: var(--ink-3, #6a7591);
    border: 0;
    border-right: 1px solid var(--rule, #d2ccbf);
    cursor: pointer;
    transition: background var(--tx, .16s), color var(--tx, .16s);
    line-height: 1;
    -webkit-tap-highlight-color: transparent;
    min-height: var(--h);
  }
  button:last-child { border-right: 0; }
  button:hover { background: var(--paper-2, #ebe7df); color: var(--ink, #0d1b34); }
  button[aria-pressed="true"] { color: var(--paper, #f3efe7); cursor: default; }
  button[data-v="in-progress"][aria-pressed="true"] { background: var(--amber, #d68a1a); }
  button[data-v="complete"][aria-pressed="true"]    { background: var(--green, #1f8b5a); }
  button[data-v="not-started"][aria-pressed="true"] {
    background: var(--paper-2, #ebe7df);
    color: var(--ink-2, #2a3958);
  }
  :host([disabled]) .group { opacity: .5; pointer-events: none; }
`;

class SegStatus extends HTMLElement {
  static get observedAttributes() { return ['value', 'disabled']; }
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <div class="group" role="radiogroup">
        ${STATES.map(s => `<button type="button" role="radio" data-v="${s}" aria-pressed="false">${LABELS[s]}</button>`).join('')}
      </div>
    `;
    r.querySelectorAll('button').forEach(b => {
      b.addEventListener('click', () => this._select(b.dataset.v));
    });
    this._buttons = r.querySelectorAll('button');
  }
  attributeChangedCallback() { this._paint(); }
  connectedCallback() { this._paint(); }
  get value() { return this.getAttribute('value') || 'not-started'; }
  set value(v) { this.setAttribute('value', v); }
  _select(next) {
    if (this.hasAttribute('disabled')) return;
    const prev = this.value;
    if (next === prev) return;
    this.setAttribute('value', next);
    this.dispatchEvent(new CustomEvent('seg-status:change', {
      bubbles: true, composed: true,
      detail: { value: next, previous: prev }
    }));
  }
  _paint() {
    const v = this.value;
    this._buttons.forEach(b => {
      b.setAttribute('aria-pressed', b.dataset.v === v ? 'true' : 'false');
    });
  }
}

if (!customElements.get('seg-status')) {
  customElements.define('seg-status', SegStatus);
}
