// ╔════════════════════════════════════════════════════════════════════╗
// ║  <cmd-palette> · S-04 · BuhlOS site office                         ║
// ║                                                                    ║
// ║  Per brief §06 (command palette) and §15.                          ║
// ║                                                                    ║
// ║  The ⌘K SURFACE. Verb-first. Reads commands from a global         ║
// ║  registry that every view contributes to on mount. Jump · do ·    ║
// ║  switch.                                                           ║
// ║                                                                    ║
// ║  This component owns:                                              ║
// ║    - the modal sheet (paper, navy text, rule)                      ║
// ║    - the fuzzy filter (subsequence match with score)                ║
// ║    - the keyboard nav (↑↓ to move, ↵ to run, esc to close)         ║
// ║    - the open/close state (⌘K / ⌃K toggles, also via API)          ║
// ║                                                                    ║
// ║  USAGE:                                                            ║
// ║                                                                    ║
// ║    import { CmdRegistry } from '/components/cmd-palette.js';       ║
// ║                                                                    ║
// ║    CmdRegistry.register({                                          ║
// ║      id: 'approve-hours-under-9',                                  ║
// ║      verb: 'Approve',                                              ║
// ║      label: 'Approve all hours under 9h',                          ║
// ║      group: 'Actions',                                             ║
// ║      shortcut: '⌘\\\\',                                              ║
// ║      run: () => approveAllUnder(9)                                 ║
// ║    });                                                             ║
// ║                                                                    ║
// ║    // Or jump-to-URL commands:                                     ║
// ║    CmdRegistry.register({                                          ║
// ║      id: 'jump-iv3232', verb: 'Open', label: 'IV3232 · Birdwood',  ║
// ║      group: 'Jump', href: '/admin/job?id=iv3232'                   ║
// ║    });                                                             ║
// ║                                                                    ║
// ║    // The palette can be opened anywhere:                          ║
// ║    document.querySelector('cmd-palette').open();                   ║
// ║                                                                    ║
// ║  Views should call CmdRegistry.scope('view-id') to register a      ║
// ║  bundle that gets cleared when they unmount. Without scoping the   ║
// ║  registry grows forever on SPAs.                                   ║
// ╚════════════════════════════════════════════════════════════════════╝

// ── Registry ─────────────────────────────────────────────────────────
// Singleton. Lives on window so multiple modules import the same one.

const REG_KEY = '__buhl_cmd_registry__';
const reg = window[REG_KEY] || (window[REG_KEY] = {
  commands: new Map(),
  scopes: new Map(),
  listeners: new Set(),
});

function notify() {
  reg.listeners.forEach(fn => { try { fn(); } catch (e) { /* swallow */ } });
}

export const CmdRegistry = {
  /** Register a single command. Returns an unregister function. */
  register(cmd) {
    if (!cmd || !cmd.id) throw new Error('cmd-palette: register() needs an id');
    reg.commands.set(cmd.id, cmd);
    notify();
    return () => CmdRegistry.unregister(cmd.id);
  },
  /** Bulk-register a list of commands. */
  registerMany(cmds) {
    if (!Array.isArray(cmds)) return () => {};
    const ids = cmds.map(c => { reg.commands.set(c.id, c); return c.id; });
    notify();
    return () => ids.forEach(id => CmdRegistry.unregister(id));
  },
  unregister(id) {
    if (reg.commands.delete(id)) notify();
  },
  /** Scope: register a bundle under a key, clear all of them at once. */
  scope(key) {
    if (reg.scopes.has(key)) reg.scopes.get(key)();
    return (cmds) => {
      const unreg = CmdRegistry.registerMany(cmds);
      reg.scopes.set(key, unreg);
      return unreg;
    };
  },
  /** Clear a scope's commands. */
  clearScope(key) {
    if (reg.scopes.has(key)) { reg.scopes.get(key)(); reg.scopes.delete(key); }
  },
  /** All currently-registered commands. */
  list() {
    return Array.from(reg.commands.values());
  },
  /** Subscribe to changes (palette re-renders on each call). */
  subscribe(fn) {
    reg.listeners.add(fn);
    return () => reg.listeners.delete(fn);
  },
};

// ── Fuzzy filter ─────────────────────────────────────────────────────
// Subsequence match with scoring:
//   - all query chars must appear in order in the haystack (case-insensitive)
//   - tighter clusters score higher
//   - matches at word starts score higher
//   - shorter haystacks score higher (tie-break)
// Returns null if no match.

function fuzzyScore(needle, haystack) {
  if (!needle) return 1;
  const n = needle.toLowerCase();
  const h = haystack.toLowerCase();
  let score = 0;
  let hi = 0;
  let lastHit = -2;
  for (let i = 0; i < n.length; i++) {
    const ch = n[i];
    let found = -1;
    while (hi < h.length) {
      if (h[hi] === ch) { found = hi; hi++; break; }
      hi++;
    }
    if (found < 0) return null;
    // Adjacency bonus.
    if (found === lastHit + 1) score += 3;
    // Word-start bonus.
    const prev = h[found - 1];
    if (found === 0 || prev === ' ' || prev === '-' || prev === '/' || prev === '·') score += 2;
    score += 1;
    lastHit = found;
  }
  // Shorter haystacks rank higher.
  score += Math.max(0, 20 - h.length) * 0.05;
  return score;
}

// ── Component ────────────────────────────────────────────────────────

const STYLES = `
  :host {
    position: fixed; inset: 0;
    display: none;
    background: rgba(13, 27, 52, .42);
    z-index: 9999;
    align-items: flex-start;
    justify-content: center;
    padding-top: 14vh;
    -webkit-backdrop-filter: blur(2px);
    backdrop-filter: blur(2px);
  }
  :host([open]) { display: flex; }
  .sheet {
    width: min(640px, 92vw);
    max-height: 70vh;
    display: flex; flex-direction: column;
    background: var(--paper, #f3efe7);
    border: 1px solid var(--rule, #d2ccbf);
    border-radius: 12px;
    box-shadow: 0 24px 56px rgba(13, 27, 52, .24);
    overflow: hidden;
    font-family: var(--body, sans-serif);
    color: var(--ink, #0d1b34);
  }
  .head {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--rule, #d2ccbf);
  }
  .head .arr { color: var(--ink-3, #6a7591); font-family: var(--mono, monospace); font-weight: 600; }
  .head input {
    flex: 1;
    border: 0; outline: 0; background: transparent;
    font-family: var(--display, sans-serif);
    font-weight: 500;
    font-size: 17px;
    color: var(--ink, #0d1b34);
    caret-color: var(--navy, #0d1b34);
  }
  .head input::placeholder { color: var(--ink-3, #6a7591); font-weight: 500; }
  .head .esc {
    background: var(--paper-2, #ebe7df);
    border: 1px solid var(--rule, #d2ccbf);
    border-radius: 4px;
    padding: 2px 7px;
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    font-weight: 600;
    color: var(--ink-3, #6a7591);
  }

  .results {
    overflow-y: auto;
    padding: 6px;
  }
  .group {
    font-family: var(--mono, monospace);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .1em;
    text-transform: uppercase;
    color: var(--ink-3, #6a7591);
    padding: 10px 10px 4px;
  }
  .item {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--ink, #0d1b34);
  }
  .item .verb {
    font-family: var(--mono, monospace);
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-3, #6a7591);
    width: 60px;
    flex-shrink: 0;
  }
  .item .label {
    flex: 1;
    font-family: var(--display, sans-serif);
    font-weight: 600;
    font-size: 14px;
    color: var(--ink, #0d1b34);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .item .label small {
    color: var(--ink-3, #6a7591);
    font-weight: 500;
    margin-left: 6px;
    font-family: var(--body, sans-serif);
    font-size: 12px;
  }
  .item .sc {
    color: var(--ink-3, #6a7591);
    font-family: var(--mono, monospace);
    font-size: 11px;
  }
  .item.active {
    background: var(--paper-2, #ebe7df);
  }
  .item.active .verb { color: var(--ink, #0d1b34); }
  .item .glyph {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--paper-3, #dfdacf);
    flex-shrink: 0;
  }
  .item.active .glyph {
    background: var(--yellow, #f5d020);
  }

  .empty {
    padding: 18px;
    text-align: center;
    color: var(--ink-3, #6a7591);
    font-size: 13px;
  }
  .foot {
    padding: 8px 14px;
    border-top: 1px solid var(--rule, #d2ccbf);
    display: flex; gap: 16px;
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    color: var(--ink-3, #6a7591);
    flex-wrap: wrap;
  }
  .foot span b { color: var(--ink-2, #2a3958); font-weight: 600; }
`;

class CmdPalette extends HTMLElement {
  static get observedAttributes() { return ['open']; }

  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Command palette">
        <div class="head">
          <span class="arr">→</span>
          <input type="text" placeholder="Jump or do…" autocomplete="off" spellcheck="false" />
          <span class="esc">esc</span>
        </div>
        <div class="results" role="listbox"></div>
        <div class="foot">
          <span><b>↑↓</b> navigate</span><span><b>↵</b> run</span><span><b>esc</b> close</span>
        </div>
      </div>
    `;
    this._inputEl = r.querySelector('input');
    this._resultsEl = r.querySelector('.results');
    this._sheetEl = r.querySelector('.sheet');
    this._activeIdx = 0;
    this._filtered = [];
    this._handleKeydown = this._handleKeydown.bind(this);
    this._handleBackdrop = this._handleBackdrop.bind(this);
  }

  connectedCallback() {
    document.addEventListener('keydown', this._globalKey);
    this.addEventListener('click', this._handleBackdrop);
    this._inputEl.addEventListener('input', () => this._renderResults());
    this._inputEl.addEventListener('keydown', this._handleKeydown);
    this._unsubReg = CmdRegistry.subscribe(() => { if (this.isOpen) this._renderResults(); });
  }
  disconnectedCallback() {
    document.removeEventListener('keydown', this._globalKey);
    if (this._unsubReg) this._unsubReg();
  }

  /** Whether the palette is currently open. */
  get isOpen() { return this.hasAttribute('open'); }

  /** Show the palette. */
  open() {
    this.setAttribute('open', '');
    this._inputEl.value = '';
    this._activeIdx = 0;
    this._renderResults();
    queueMicrotask(() => this._inputEl.focus());
  }

  /** Hide the palette. */
  close() {
    this.removeAttribute('open');
  }

  /** Toggle open state. */
  toggle() {
    if (this.isOpen) this.close(); else this.open();
  }

  /** Global ⌘K / Ctrl-K listener — also handles esc when open. */
  _globalKey = (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'k' || ev.key === 'K')) {
      ev.preventDefault();
      this.toggle();
    }
    if (this.isOpen && ev.key === 'Escape') {
      ev.preventDefault();
      this.close();
    }
  };

  _handleBackdrop(ev) {
    // The host fills the screen as a backdrop; the sheet sits in the middle.
    // Clicks inside the sheet get retargeted to the host (shadow boundary),
    // so `ev.target === this` isn't enough — use composedPath to detect.
    const path = ev.composedPath();
    const inSheet = path.some(el => el && el.classList && el.classList.contains && el.classList.contains('sheet'));
    if (!inSheet && this.isOpen) this.close();
  }

  _handleKeydown(ev) {
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      this._activeIdx = Math.min(this._filtered.length - 1, this._activeIdx + 1);
      this._paintActive();
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      this._activeIdx = Math.max(0, this._activeIdx - 1);
      this._paintActive();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      this._run(this._filtered[this._activeIdx]);
    }
  }

  _run(cmd) {
    if (!cmd) return;
    this.close();
    if (typeof cmd.run === 'function') {
      try { cmd.run(); } catch (e) { console.error('cmd-palette run failed', cmd.id, e); }
    } else if (cmd.href) {
      window.location.assign(cmd.href);
    }
  }

  _renderResults() {
    const q = this._inputEl.value.trim();
    const cmds = CmdRegistry.list();
    let scored = cmds.map(c => ({
      c,
      score: fuzzyScore(q, [c.verb, c.label, c.group].filter(Boolean).join(' ')),
    })).filter(x => x.score != null);

    // If no query, show all in registered order.
    if (!q) {
      scored = cmds.map(c => ({ c, score: 0 }));
    } else {
      scored.sort((a, b) => b.score - a.score);
    }

    this._filtered = scored.map(x => x.c);
    if (this._activeIdx >= this._filtered.length) this._activeIdx = Math.max(0, this._filtered.length - 1);

    // Group by .group (preserving insertion order from the filter sort).
    const groups = new Map();
    this._filtered.forEach(c => {
      const g = c.group || 'Commands';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    });

    const out = document.createDocumentFragment();
    let globalIdx = 0;
    if (this._filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = q ? `No commands match “${q}”.` : 'No commands registered.';
      out.appendChild(empty);
    } else {
      for (const [groupName, items] of groups) {
        const lab = document.createElement('div');
        lab.className = 'group';
        lab.textContent = groupName;
        out.appendChild(lab);
        items.forEach(cmd => {
          const idx = globalIdx++;
          const row = document.createElement('div');
          row.className = 'item';
          row.setAttribute('role', 'option');
          row.dataset.idx = idx;
          if (idx === this._activeIdx) row.classList.add('active');
          row.innerHTML = `
            <span class="glyph"></span>
            <span class="verb">${cmd.verb ? escapeHtml(cmd.verb) : ''}</span>
            <span class="label">${escapeHtml(cmd.label || cmd.id)}${cmd.detail ? ` <small>${escapeHtml(cmd.detail)}</small>` : ''}</span>
            <span class="sc">${cmd.shortcut ? escapeHtml(cmd.shortcut) : (cmd.href ? '↗' : '↵')}</span>
          `;
          row.addEventListener('click', () => this._run(cmd));
          row.addEventListener('mouseenter', () => {
            this._activeIdx = idx;
            this._paintActive();
          });
          out.appendChild(row);
        });
      }
    }
    this._resultsEl.textContent = '';
    this._resultsEl.appendChild(out);
  }

  _paintActive() {
    const rows = this._resultsEl.querySelectorAll('.item');
    rows.forEach(r => {
      const i = Number(r.dataset.idx);
      r.classList.toggle('active', i === this._activeIdx);
    });
    const active = this._resultsEl.querySelector('.item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

if (!customElements.get('cmd-palette')) {
  customElements.define('cmd-palette', CmdPalette);
}
