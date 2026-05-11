// ╔════════════════════════════════════════════════════════════════════╗
// ║  <snag-button> · C-06 · BuhlOS Job Interface                       ║
// ║                                                                    ║
// ║  Per brief §12. Red outline. Compact inline + full-width sheet     ║
// ║  trigger. **Always prefills context** (job/area/task) via data     ║
// ║  attributes, which the consumer reads from the event detail.      ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    job-id="..."   — required for context                           ║
// ║    area-id="..."  — optional                                       ║
// ║    task-id="..."  — optional                                       ║
// ║    size="sm|md"   — sm (inline beside task) | md (full-width)      ║
// ║    label="..."    — override the displayed text                    ║
// ║                                                                    ║
// ║  Events:                                                           ║
// ║    snag-button:open detail = { jobId, areaId, taskId }             ║
// ║                                                                    ║
// ║  The button does NOT open a sheet itself — the consumer listens    ║
// ║  for snag-button:open and decides how to render the snag form     ║
// ║  (per brief §12, it's the same sheet whether you tap from task,    ║
// ║  area, or job home).                                               ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    display: inline-flex;
  }
  :host([size="md"]) { display: flex; width: 100%; }
  button {
    display: inline-flex; align-items: center; justify-content: center;
    gap: 6px;
    min-height: 36px;
    padding: 0 14px;
    background: var(--paper, #f3efe7);
    border: 1px solid var(--red, #c0312f);
    color: var(--red, #c0312f);
    border-radius: var(--r, 6px);
    font-family: var(--display, sans-serif);
    font-weight: 700;
    font-size: 13px;
    letter-spacing: -.005em;
    cursor: pointer;
    transition: background var(--tx, .16s);
    -webkit-tap-highlight-color: transparent;
  }
  button:hover, button:active { background: rgba(192, 49, 47, .08); }
  :host([size="md"]) button {
    width: 100%;
    min-height: var(--tap, 44px);
    font-size: 15px;
  }
  .icn {
    font-family: var(--mono, monospace);
    font-weight: 700;
    font-size: 14px;
  }
`;

class SnagButton extends HTMLElement {
  static get observedAttributes() { return ['size', 'label']; }
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <button type="button"><span class="icn">⚐</span><span class="lab">Raise snag</span></button>
    `;
    this._labEl = r.querySelector('.lab');
    r.querySelector('button').addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('snag-button:open', {
        bubbles: true, composed: true,
        detail: {
          jobId:  this.getAttribute('job-id') || null,
          areaId: this.getAttribute('area-id') || null,
          taskId: this.getAttribute('task-id') || null,
        },
      }));
    });
  }
  attributeChangedCallback() { this._render(); }
  connectedCallback() { this._render(); }
  _render() {
    this._labEl.textContent = this.getAttribute('label') || 'Raise snag';
  }
}

if (!customElements.get('snag-button')) {
  customElements.define('snag-button', SnagButton);
}
