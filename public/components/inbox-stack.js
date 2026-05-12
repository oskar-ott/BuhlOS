// ╔════════════════════════════════════════════════════════════════════╗
// ║  <inbox-stack> · S-03 · BuhlOS site office                         ║
// ║                                                                    ║
// ║  Per brief §04 (inbox model). A queue with a DRAIN-IT button.      ║
// ║  Used on Overview and as the head of any inbox view.               ║
// ║                                                                    ║
// ║  The contract: every inbox row has at most ONE primary action and  ║
// ║  ONE overflow. If the office can't drain it with the keyboard,     ║
// ║  the inbox isn't done.                                             ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    label="HOURS PENDING"      — caption                            ║
// ║    count="15"                  — queue depth (mono, tabular)       ║
// ║    summary="5 tradies..."      — one-line detail                   ║
// ║    action-label="Review →"     — primary CTA text                  ║
// ║    action-href="/admin/hours"  — primary CTA destination           ║
// ║    severity="ok|warn|bad"      — colour gloss on the count badge   ║
// ║      ok    = neutral grey                                          ║
// ║      warn  = yellow (age > 24h)                                    ║
// ║      bad   = red    (SLA breach — see brief §02 sidebar)           ║
// ║                                                                    ║
// ║  Events:                                                           ║
// ║    inbox-stack:drain — fires when the primary action is clicked    ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    display: block;
    background: var(--paper, #f3efe7);
    border: 1px solid var(--rule, #d2ccbf);
    border-radius: var(--r-lg, 10px);
    padding: 14px 16px;
    font-family: var(--body, sans-serif);
    color: var(--ink, #0d1b34);
  }
  :host([severity="bad"]) { border-left: 3px solid var(--red, #c0312f); }
  :host([severity="warn"]) { border-left: 3px solid var(--yellow, #f5d020); }

  .row {
    display: flex; align-items: center; gap: 14px;
  }
  .body { flex: 1; min-width: 0; }
  .lab {
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--ink-3, #6a7591);
    display: flex; align-items: center; gap: 8px;
  }
  .lab .ct {
    background: var(--paper-2, #ebe7df);
    color: var(--ink-2, #2a3958);
    padding: 1px 8px;
    border-radius: 999px;
    font-size: 10.5px;
    letter-spacing: 0;
  }
  :host([severity="warn"]) .lab .ct { background: var(--yellow, #f5d020); color: var(--yellow-ink, #1d1700); }
  :host([severity="bad"])  .lab .ct { background: var(--red, #c0312f);    color: #fff; }

  .summary {
    font-family: var(--display, sans-serif);
    font-weight: 700;
    font-size: 17px;
    color: var(--ink, #0d1b34);
    letter-spacing: -.005em;
    margin-top: 6px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cta {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--yellow, #f5d020);
    color: var(--yellow-ink, #1d1700);
    border: 0;
    height: 34px;
    padding: 0 14px;
    border-radius: var(--r, 6px);
    font-family: var(--display, sans-serif);
    font-weight: 700;
    font-size: 13px;
    cursor: pointer;
    white-space: nowrap;
    transition: background .14s;
  }
  .cta:hover { background: var(--yellow-2, #e8c000); }
  :host([severity="ok"]) .cta {
    background: var(--paper-2, #ebe7df);
    color: var(--ink, #0d1b34);
  }
  :host([severity="ok"]) .cta:hover { background: var(--paper-3, #dfdacf); }

  ::slotted([slot="extra"]) {
    display: block;
    margin-top: 8px;
    font-size: var(--type-meta, 12px);
    color: var(--ink-3, #6a7591);
  }
`;

class InboxStack extends HTMLElement {
  static get observedAttributes() {
    return ['label', 'count', 'summary', 'action-label', 'action-href', 'severity'];
  }

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${STYLES}</style>
      <div class="row">
        <div class="body">
          <div class="lab"><span class="t"></span><span class="ct"></span></div>
          <div class="summary"></div>
          <slot name="extra"></slot>
        </div>
        <button class="cta" type="button"></button>
      </div>
    `;
    this._tEl = root.querySelector('.lab .t');
    this._ctEl = root.querySelector('.lab .ct');
    this._sumEl = root.querySelector('.summary');
    this._ctaEl = root.querySelector('.cta');
    this._ctaEl.addEventListener('click', this._onAction);
  }

  attributeChangedCallback() {
    this._render();
  }
  connectedCallback() {
    this._render();
  }

  _render() {
    this._tEl.textContent = this.getAttribute('label') || '';
    const count = this.getAttribute('count');
    this._ctEl.textContent = count == null || count === '' ? '' : count;
    this._ctEl.style.display = count == null || count === '' ? 'none' : '';
    this._sumEl.textContent = this.getAttribute('summary') || '';
    this._ctaEl.textContent = this.getAttribute('action-label') || 'Open →';
  }

  _onAction = (ev) => {
    ev.preventDefault();
    const href = this.getAttribute('action-href');
    this.dispatchEvent(new CustomEvent('inbox-stack:drain', {
      bubbles: true, composed: true,
      detail: { href }
    }));
    if (href) window.location.assign(href);
  };
}

if (!customElements.get('inbox-stack')) {
  customElements.define('inbox-stack', InboxStack);
}
