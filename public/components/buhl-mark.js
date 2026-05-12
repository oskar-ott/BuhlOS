// ╔════════════════════════════════════════════════════════════════════╗
// ║  <buhl-mark> · BuhlOS brand mark + sync indicator                  ║
// ║                                                                    ║
// ║  Per prompt: "<buhl-mark> doubles as the sync indicator — wire it  ║
// ║  to a small sync.js event bus that API helpers fire into (pulse   ║
// ║  on upload, both dots stroked when offline)."                      ║
// ║                                                                    ║
// ║  Visual: two dots arranged as the "b·ü" — the left dot animates    ║
// ║  on pulse, both go stroked (outlines only) when offline, the      ║
// ║  whole mark turns red on fail.                                     ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    size="md"  — sm (14px, sync stamp) | md (24px) | lg (36px)     ║
// ║    label      — when set, renders "bühl" beside the dots          ║
// ║                                                                    ║
// ║  Subscribes to /components/sync.js — no API needed from caller.    ║
// ╚════════════════════════════════════════════════════════════════════╝

import { Sync } from '/components/sync.js';

const STYLES = `
  :host {
    display: inline-flex; align-items: center; gap: 8px;
    color: currentColor;
    line-height: 1;
  }
  .mark {
    display: inline-flex; align-items: center; gap: 3px;
    position: relative;
  }
  .d {
    display: inline-block;
    width: var(--d, 8px);
    height: var(--d, 8px);
    border-radius: 50%;
    background: currentColor;
    transition: background .14s, transform .14s, opacity .14s;
  }
  :host([size="sm"]) { --d: 4px; gap: 4px; }
  :host([size="md"]) { --d: 7px; }
  :host([size="lg"]) { --d: 10px; }

  /* Pulsing — left dot animates */
  :host([state="pulsing"]) .d.l { animation: pulse 0.9s infinite ease-in-out; background: var(--amber, #d68a1a); }
  :host([state="pulsing"]) .d.r { background: var(--amber, #d68a1a); opacity: .55; }
  @keyframes pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(.55); opacity: .6; }
  }

  /* Offline — both dots stroked */
  :host([state="offline"]) .d {
    background: transparent;
    box-shadow: inset 0 0 0 1.5px currentColor;
  }

  /* Failed — red */
  :host([state="failed"]) .d { background: var(--red, #c0312f); }

  .lab {
    font-family: var(--display, sans-serif);
    font-weight: 700;
    font-size: 12px;
    letter-spacing: -.005em;
  }
  :host(:not([label])) .lab { display: none; }
`;

class BuhlMark extends HTMLElement {
  static get observedAttributes() { return ['size', 'label']; }
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `
      <style>${STYLES}</style>
      <span class="mark" aria-label="Sync indicator">
        <span class="d l"></span>
        <span class="d r"></span>
      </span>
      <span class="lab">bühl</span>
    `;
  }
  connectedCallback() {
    this._unsub = Sync.subscribe(({ state }) => this.setAttribute('state', state));
  }
  disconnectedCallback() {
    if (this._unsub) this._unsub();
  }
  attributeChangedCallback() { /* host CSS handles it */ }
}

if (!customElements.get('buhl-mark')) {
  customElements.define('buhl-mark', BuhlMark);
}
