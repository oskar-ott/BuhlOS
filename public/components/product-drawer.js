// ╔════════════════════════════════════════════════════════════════════╗
// ║  <product-drawer> · BuhlOS Job Interface                           ║
// ║                                                                    ║
// ║  Per brief §17 (component rule) and §20 (definition of success):  ║
// ║    "App-leave for product specs = 0."                              ║
// ║                                                                    ║
// ║  Listens for product-chip:open events bubbling from <product-chip> ║
// ║  and renders an in-app bottom-sheet spec drawer. No external       ║
// ║  links, no app-leave. When a real product database lands the       ║
// ║  drawer fetches and populates; until then it shows a respectful   ║
// ║  fallback that surfaces what the chip carries (code, label) and    ║
// ║  links to the existing /admin/suppliers entry where the field       ║
// ║  worker can read the supplier register without leaving BuhlOS.    ║
// ║                                                                    ║
// ║  Mounting: <product-drawer></product-drawer> anywhere on the page  ║
// ║  is enough. The element wires document-level listeners on connect, ║
// ║  so any <product-chip> in the same page opens the drawer.          ║
// ║                                                                    ║
// ║  Method: openFor(code, label, opts) for programmatic open.         ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    position: fixed; inset: 0;
    display: none;
    z-index: 90;
    background: rgba(13, 27, 52, .42);
    align-items: flex-end;
    justify-content: center;
  }
  :host([open]) { display: flex; animation: pd-in .18s ease; }
  @keyframes pd-in { from { background: rgba(13, 27, 52, 0); } to { background: rgba(13, 27, 52, .42); } }

  .sheet {
    width: 100%;
    max-width: 560px;
    background: var(--paper, #f3efe7);
    border-radius: 16px 16px 0 0;
    padding: 18px 18px calc(22px + env(safe-area-inset-bottom));
    max-height: 80vh;
    overflow-y: auto;
    box-shadow: 0 -8px 32px rgba(13, 27, 52, .24);
    animation: pd-up .22s cubic-bezier(.2, .8, .2, 1);
    font-family: var(--body, sans-serif);
    color: var(--ink, #0d1b34);
  }
  @keyframes pd-up { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  .handle {
    display: block; margin: -8px auto 12px;
    width: 36px; height: 4px;
    background: var(--rule-2, #c5beaf);
    border-radius: 2px;
  }

  .head {
    display: flex; align-items: flex-start; gap: 14px; margin-bottom: 14px;
  }
  .head .code {
    background: var(--paper-3, #dfdacf);
    color: var(--navy, #0d1b34);
    font-family: var(--mono, monospace);
    font-size: 12px;
    font-weight: 600;
    padding: 4px 10px;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .head h2 {
    font-family: var(--display, sans-serif);
    font-weight: 700;
    font-size: 18px;
    letter-spacing: -.018em;
    margin: 0;
    color: var(--navy, #0d1b34);
    flex: 1;
    min-width: 0;
  }
  .head .close {
    background: transparent;
    border: 0;
    font-size: 22px;
    line-height: 1;
    color: var(--ink-3, #6a7591);
    cursor: pointer;
    padding: 4px 8px;
  }

  .body {
    font-size: 14px;
    color: var(--ink-2, #2a3958);
    line-height: 1.5;
  }
  .body p { margin: 0 0 10px; }
  .body p:last-child { margin-bottom: 0; }
  .body .empty {
    background: var(--paper-2, #ebe7df);
    border: 1px solid var(--rule, #d2ccbf);
    border-radius: 6px;
    padding: 12px 14px;
    color: var(--ink-3, #6a7591);
    font-size: 13px;
  }
  .body .empty b { color: var(--ink, #0d1b34); font-family: var(--display, sans-serif); font-weight: 600; }

  .row {
    display: grid;
    grid-template-columns: 96px 1fr;
    gap: 12px;
    padding: 8px 0;
    border-bottom: 1px solid var(--rule, #d2ccbf);
    font-size: 13.5px;
  }
  .row:last-of-type { border-bottom: 0; }
  .row .k {
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    letter-spacing: .08em;
    text-transform: uppercase;
    color: var(--ink-3, #6a7591);
    padding-top: 2px;
  }
  .row .v {
    font-family: var(--display, sans-serif);
    font-weight: 600;
    color: var(--navy, #0d1b34);
  }

  .actions {
    display: flex; gap: 10px;
    margin-top: 16px;
    flex-direction: column;
  }
  .btn {
    min-height: 44px;
    border-radius: 6px;
    font-family: var(--display, sans-serif);
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    border: 1px solid var(--rule-2, #c5beaf);
    background: var(--paper, #f3efe7);
    color: var(--ink, #0d1b34);
    text-decoration: none;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  }
  .btn:hover { background: var(--paper-2, #ebe7df); }
  .btn.primary {
    background: var(--yellow, #f5d020);
    color: var(--yellow-ink, #1d1700);
    border-color: var(--navy, #0d1b34);
    min-height: 48px;
    font-weight: 700;
  }
  .btn.primary:hover { background: var(--yellow-2, #e8c000); }
`;

class ProductDrawer extends HTMLElement {
  static get observedAttributes() { return ['open']; }

  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="pd-title">
        <span class="handle" aria-hidden="true"></span>
        <div class="head">
          <span class="code" id="pd-code"></span>
          <h2 id="pd-title"></h2>
          <button class="close" type="button" aria-label="Close">✕</button>
        </div>
        <div class="body" id="pd-body"></div>
      </div>
    `;
    this._codeEl  = r.getElementById('pd-code');
    this._titleEl = r.getElementById('pd-title');
    this._bodyEl  = r.getElementById('pd-body');
    r.querySelector('.close').addEventListener('click', () => this.close());
    this.addEventListener('click', (ev) => {
      if (ev.composedPath().some(n => n.classList && n.classList.contains('sheet'))) return;
      this.close();
    });
  }

  connectedCallback() {
    // Listen at document level so every <product-chip> on the page opens us.
    this._docHandler = (ev) => {
      const d = ev.detail || {};
      this.openFor(d.code || '', d.label || '', { href: d.href || null });
    };
    document.addEventListener('product-chip:open', this._docHandler);
    document.addEventListener('keydown', this._escHandler);
  }
  disconnectedCallback() {
    if (this._docHandler) document.removeEventListener('product-chip:open', this._docHandler);
    document.removeEventListener('keydown', this._escHandler);
  }

  _escHandler = (ev) => {
    if (ev.key === 'Escape' && this.hasAttribute('open')) {
      ev.preventDefault();
      this.close();
    }
  };

  /**
   * Open the drawer for a given product code + optional label.
   * `opts.href` is reserved for a future "view full spec" link — for now
   * we route to /admin/suppliers so internal users see the supplier
   * register without app-leave.
   */
  openFor(code, label, opts) {
    opts = opts || {};
    this._codeEl.textContent = code || '—';
    this._codeEl.style.display = code ? '' : 'none';
    this._titleEl.textContent = label || (code ? code : 'Product');

    // Until a real product database ships, render the minimal known
    // info + a single tertiary action that keeps the user in BuhlOS.
    const body = [];
    body.push(`<div class="empty"><b>Spec sheet not on file yet.</b><br>The boss is wiring this up. Until then, the chip is here so you don't have to retype the code.</div>`);
    body.push(`<div class="row"><span class="k">Code</span><span class="v">${esc(code || '—')}</span></div>`);
    if (label) body.push(`<div class="row"><span class="k">Label</span><span class="v">${esc(label)}</span></div>`);

    body.push(`
      <div class="actions">
        <a class="btn primary" href="/admin/suppliers?q=${encodeURIComponent(code || '')}">Open supplier register ↗</a>
        <button class="btn" type="button" data-copy="${esc(code || '')}">Copy code</button>
      </div>
    `);
    this._bodyEl.innerHTML = body.join('');

    const copyBtn = this._bodyEl.querySelector('[data-copy]');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(copyBtn.dataset.copy);
        copyBtn.textContent = 'Copied ✓';
        setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 1200);
      } catch {
        copyBtn.textContent = 'Long-press to copy';
      }
    });

    this.setAttribute('open', '');
  }

  close() { this.removeAttribute('open'); }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

if (!customElements.get('product-drawer')) {
  customElements.define('product-drawer', ProductDrawer);
}
