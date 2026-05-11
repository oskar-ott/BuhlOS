// ╔════════════════════════════════════════════════════════════════════╗
// ║  <empty-state> · C-09 · BuhlOS Job Interface                       ║
// ║                                                                    ║
// ║  Per brief §17 ninth-component note: every list that can be empty  ║
// ║  gets one. Plain navy headline, mono caption, optional inline     ║
// ║  action. **Never an empty card frame.**                            ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    title="No work areas set up"                                    ║
// ║    caption="The job needs at least one area before work can…"     ║
// ║    action-label="Set up work areas"                                ║
// ║    action-href="..."                                               ║
// ║                                                                    ║
// ║  Events:                                                           ║
// ║    empty-state:action  — when the inline action is tapped          ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    display: block;
    text-align: center;
    padding: 36px 20px;
    color: var(--ink-3, #6a7591);
  }
  .t {
    font-family: var(--display, sans-serif);
    font-weight: 700;
    font-size: 17px;
    color: var(--navy, #0d1b34);
    letter-spacing: -.005em;
    margin-bottom: 6px;
  }
  .c {
    font-family: var(--mono, monospace);
    font-size: 12px;
    letter-spacing: .04em;
    color: var(--ink-3, #6a7591);
    line-height: 1.5;
    max-width: 36ch;
    margin: 0 auto 12px;
  }
  button {
    display: inline-flex; align-items: center; gap: 6px;
    min-height: 38px;
    padding: 0 14px;
    background: var(--paper-2, #ebe7df);
    border: 1px solid var(--rule, #d2ccbf);
    color: var(--ink, #0d1b34);
    border-radius: var(--r, 6px);
    font-family: var(--display, sans-serif);
    font-weight: 600;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover { background: var(--paper-3, #dfdacf); }
  :host(:not([action-label])) button { display: none; }
`;

class EmptyState extends HTMLElement {
  static get observedAttributes() { return ['title', 'caption', 'action-label', 'action-href']; }
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <div class="t"></div>
      <div class="c"></div>
      <button type="button"></button>
    `;
    this._tEl = r.querySelector('.t');
    this._cEl = r.querySelector('.c');
    this._bEl = r.querySelector('button');
    this._bEl.addEventListener('click', () => {
      const href = this.getAttribute('action-href');
      this.dispatchEvent(new CustomEvent('empty-state:action', {
        bubbles: true, composed: true, detail: { href },
      }));
      if (href) window.location.assign(href);
    });
  }
  attributeChangedCallback() { this._render(); }
  connectedCallback() { this._render(); }
  _render() {
    this._tEl.textContent = this.getAttribute('title') || '';
    this._cEl.textContent = this.getAttribute('caption') || '';
    this._cEl.style.display = this.hasAttribute('caption') ? '' : 'none';
    this._bEl.textContent = this.getAttribute('action-label') || '';
  }
}

if (!customElements.get('empty-state')) {
  customElements.define('empty-state', EmptyState);
}
