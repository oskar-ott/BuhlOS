// ╔════════════════════════════════════════════════════════════════════╗
// ║  <open-in-field> · S-08 · BuhlOS site office                       ║
// ║                                                                    ║
// ║  Per brief §02 (topbar slot) and §15. Lives in the topbar. Knows   ║
// ║  the current job/area and deep-links the phone surface.            ║
// ║                                                                    ║
// ║  The fix for F-09: looking at a job on the desk should never       ║
// ║  require typing the URL into another window to see what the LH    ║
// ║  is seeing.                                                        ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    job="iv3232"     — job code (lowercased)                        ║
// ║    area="unit-14"   — optional area slug                           ║
// ║    label="..."      — override the displayed text                  ║
// ║    href="..."       — override the destination (rarely needed)     ║
// ║                                                                    ║
// ║  Default destination:                                              ║
// ║    /my-day?job={code}                  (when no area)              ║
// ║    /my-day?job={code}&area={area}      (when area is set)          ║
// ║                                                                    ║
// ║  Disabled (renders dimmed) when no job is set, since "Open in      ║
// ║  field" with no context goes nowhere meaningful.                   ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--display, sans-serif);
    font-weight: 600;
    font-size: 13px;
    color: var(--ink, #0d1b34);
  }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--paper, #f3efe7);
    border: 1px solid var(--rule-2, #c5beaf);
    color: var(--ink, #0d1b34);
    padding: 6px 12px;
    border-radius: var(--r, 6px);
    cursor: pointer;
    font: inherit;
    transition: background .14s, border-color .14s;
    text-decoration: none;
  }
  .btn:hover { background: var(--paper-2, #ebe7df); border-color: var(--rule-2, #c5beaf); }
  :host([disabled]) .btn { opacity: .42; pointer-events: none; }
  .arr { font-family: var(--mono, monospace); font-weight: 600; }
`;

class OpenInField extends HTMLElement {
  static get observedAttributes() { return ['job', 'area', 'label', 'href']; }
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <a class="btn" target="_blank" rel="noopener">
        <span class="lab"></span><span class="arr">↗</span>
      </a>
    `;
    this._btnEl = r.querySelector('.btn');
    this._labEl = r.querySelector('.lab');
  }
  attributeChangedCallback() { this._render(); }
  connectedCallback() { this._render(); }
  _render() {
    const job = (this.getAttribute('job') || '').trim();
    const area = (this.getAttribute('area') || '').trim();
    const explicitHref = (this.getAttribute('href') || '').trim();

    let href = explicitHref;
    if (!href && job) {
      const params = new URLSearchParams();
      params.set('job', job);
      if (area) params.set('area', area);
      href = `/my-day?${params.toString()}`;
    }
    if (href) {
      this._btnEl.setAttribute('href', href);
      this.removeAttribute('disabled');
    } else {
      this._btnEl.removeAttribute('href');
      this.setAttribute('disabled', '');
    }

    const label = this.getAttribute('label') || 'Open in field';
    this._labEl.textContent = label;
  }
}

if (!customElements.get('open-in-field')) {
  customElements.define('open-in-field', OpenInField);
}
