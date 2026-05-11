// ╔════════════════════════════════════════════════════════════════════╗
// ║  <product-chip> · C-07 · BuhlOS Job Interface                      ║
// ║                                                                    ║
// ║  Per brief §17. A mono code chip that hangs off task names.        ║
// ║  Tap → product spec inline drawer. **Never leaves the app.**       ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    code="Clipsal 756"                                              ║
// ║    label="Smoke alarm"   — optional, for accessibility             ║
// ║    href="..."            — optional explicit URL                   ║
// ║                                                                    ║
// ║  Events:                                                           ║
// ║    product-chip:open detail = { code, label, href }                ║
// ║                                                                    ║
// ║  The chip does NOT open a drawer itself — the consumer listens     ║
// ║  for product-chip:open and renders the spec sheet/drawer. The     ║
// ║  brief is explicit: app-leave for product specs = 0 in the         ║
// ║  definition of done (§20).                                         ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    display: inline-block;
  }
  button {
    display: inline-flex; align-items: center; gap: 4px;
    background: var(--paper-3, #dfdacf);
    color: var(--navy, #0d1b34);
    font-family: var(--mono, monospace);
    font-size: 11px;
    font-weight: 500;
    padding: 3px 8px;
    border-radius: 2px;
    border: 0;
    cursor: pointer;
    line-height: 1.4;
    transition: background var(--tx, .16s);
    -webkit-tap-highlight-color: transparent;
  }
  button:hover { background: #d4ceba; }
  button:active { transform: translateY(0); }
`;

class ProductChip extends HTMLElement {
  static get observedAttributes() { return ['code', 'label']; }
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `<style>${STYLES}</style><button type="button"></button>`;
    this._btnEl = r.querySelector('button');
    this._btnEl.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('product-chip:open', {
        bubbles: true, composed: true,
        detail: {
          code:  this.getAttribute('code') || '',
          label: this.getAttribute('label') || '',
          href:  this.getAttribute('href') || null,
        },
      }));
    });
  }
  attributeChangedCallback() { this._render(); }
  connectedCallback() { this._render(); }
  _render() {
    this._btnEl.textContent = this.getAttribute('code') || '—';
    const label = this.getAttribute('label');
    this._btnEl.setAttribute('aria-label', `${this._btnEl.textContent}${label ? ' · ' + label : ''}`);
  }
}

if (!customElements.get('product-chip')) {
  customElements.define('product-chip', ProductChip);
}
