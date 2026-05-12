// ╔════════════════════════════════════════════════════════════════════╗
// ║  <list-row> · S-02 · BuhlOS site office                            ║
// ║                                                                    ║
// ║  Per brief §07 (Jobs · "one row component") and §15 (specimens).   ║
// ║                                                                    ║
// ║  THREE SLOTS:                                                      ║
// ║    identity  — status dot + name + optional sub-line               ║
// ║    metric    — meta column (counts, % complete, time)              ║
// ║    action    — single primary action, plus optional overflow       ║
// ║                                                                    ║
// ║  Used by Jobs, Users, Hours, Snags, Activity. ONE component, six   ║
// ║  surfaces. The whole point of the rebuild — the boss never has to  ║
// ║  relearn a list shape.                                             ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    status="green|yellow|red|blue|amber|none"  — dot colour         ║
// ║    code="IV3232"     — optional mono sub-line under the name       ║
// ║    name="..."        — primary label (display 600)                 ║
// ║    sub="..."         — secondary line (ink-3)                      ║
// ║    href="..."        — if set, the row click navigates             ║
// ║                                                                    ║
// ║  Events:                                                           ║
// ║    list-row:select   — bubbles on row click (when no href)         ║
// ║    list-row:action   — fires when primary action clicked           ║
// ║                                                                    ║
// ║  Light DOM, because every surface that uses it wants to put its    ║
// ║  own metric/action markup in. Shadow would force us to invent      ║
// ║  slot props for every shape of cell.                               ║
// ╚════════════════════════════════════════════════════════════════════╝

const TPL_CSS = `
  list-row {
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: var(--pad-x, 14px);
    min-height: var(--row-h, 40px);
    padding: 0 var(--pad-x, 14px);
    border-bottom: 1px solid var(--rule, #d2ccbf);
    background: var(--paper, #f3efe7);
    cursor: default;
    font-size: var(--type-base, 14px);
    color: var(--ink, #0d1b34);
  }
  list-row:last-of-type { border-bottom: 0; }
  list-row[href] { cursor: pointer; }
  list-row[href]:hover { background: var(--paper-2, #ebe7df); }
  list-row[selected] { background: var(--paper-2, #ebe7df); }

  list-row > .lr-identity {
    display: flex; align-items: center; gap: 10px; min-width: 0;
  }
  list-row > .lr-identity > .lr-name {
    font-family: var(--display, "Inter Tight", sans-serif);
    font-weight: 600;
    color: var(--ink, #0d1b34);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  list-row > .lr-identity > .lr-name .lr-sub {
    display: block;
    font-family: var(--mono, monospace);
    font-weight: 500;
    font-size: var(--type-meta, 12px);
    color: var(--ink-3, #6a7591);
    letter-spacing: .04em;
    margin-top: 2px;
  }

  list-row > .lr-metric {
    display: flex; align-items: center; gap: 14px;
    font-family: var(--mono, monospace);
    font-size: var(--type-meta, 12px);
    color: var(--ink-3, #6a7591);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  list-row > .lr-metric b { color: var(--ink-2, #2a3958); font-weight: 600; }

  list-row > .lr-action {
    display: flex; align-items: center; gap: 6px;
  }
  list-row[head] {
    background: var(--paper-2, #ebe7df);
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: .08em;
    color: var(--ink-3, #6a7591);
    min-height: 28px;
    cursor: default;
  }
  list-row[head]:hover { background: var(--paper-2, #ebe7df); }
  list-row[head] > .lr-identity > .lr-name { font-family: var(--mono, monospace); font-weight: 600; font-size: 10.5px; color: var(--ink-3, #6a7591); }
`;

// Inject the row-level CSS exactly once.
function ensureStyles() {
  if (document.getElementById('lr-styles')) return;
  const s = document.createElement('style');
  s.id = 'lr-styles';
  s.textContent = TPL_CSS;
  document.head.appendChild(s);
}

class ListRow extends HTMLElement {
  static get observedAttributes() {
    return ['name', 'sub', 'status', 'href'];
  }

  constructor() {
    super();
    ensureStyles();
  }

  connectedCallback() {
    if (!this._mounted) {
      this._render();
      this._mounted = true;
      this.addEventListener('click', this._onClick);
    }
  }

  attributeChangedCallback() {
    if (this._mounted) this._render();
  }

  _render() {
    // Snapshot any slot content the consumer already put in, then rebuild.
    const oldMetric = this.querySelector(':scope > [slot="metric"]');
    const oldAction = this.querySelector(':scope > [slot="action"]');
    const oldIdentityExtra = this.querySelector(':scope > [slot="identity-extra"]');

    this.textContent = '';

    const identity = document.createElement('div');
    identity.className = 'lr-identity';

    const status = this.getAttribute('status');
    if (status && status !== 'none') {
      const dot = document.createElement('span');
      dot.className = 'dot ' + status;
      identity.appendChild(dot);
    }

    const nameWrap = document.createElement('span');
    nameWrap.className = 'lr-name';
    nameWrap.textContent = this.getAttribute('name') || '';
    const sub = this.getAttribute('sub');
    if (sub) {
      const subEl = document.createElement('span');
      subEl.className = 'lr-sub';
      subEl.textContent = sub;
      nameWrap.appendChild(subEl);
    }
    identity.appendChild(nameWrap);
    if (oldIdentityExtra) identity.appendChild(oldIdentityExtra);

    this.appendChild(identity);

    const metric = document.createElement('div');
    metric.className = 'lr-metric';
    if (oldMetric) {
      // re-host children
      while (oldMetric.firstChild) metric.appendChild(oldMetric.firstChild);
    }
    this.appendChild(metric);

    const action = document.createElement('div');
    action.className = 'lr-action';
    if (oldAction) {
      while (oldAction.firstChild) action.appendChild(oldAction.firstChild);
    }
    this.appendChild(action);
  }

  _onClick = (ev) => {
    // Don't fire row select when clicking inside the action column.
    const inAction = ev.target.closest('.lr-action');
    if (inAction) return;
    const href = this.getAttribute('href');
    if (href) {
      window.location.assign(href);
      return;
    }
    this.dispatchEvent(new CustomEvent('list-row:select', { bubbles: true, detail: { row: this } }));
  };
}

if (!customElements.get('list-row')) {
  customElements.define('list-row', ListRow);
}
