// ╔════════════════════════════════════════════════════════════════════╗
// ║  <role-pill> · S-07 · BuhlOS site office                           ║
// ║                                                                    ║
// ║  Per brief §05 (roles) and §15. Subtle tints. Mono caps.           ║
// ║  Never a stack of three reds.                                      ║
// ║                                                                    ║
// ║  Same component as the field interface — so the LH on the truck   ║
// ║  and the boss at the desk read the same chip.                      ║
// ║                                                                    ║
// ║  Roles (admin, office, accounts, leadingHand, tradie, client) map  ║
// ║  to design tokens in /css/buhlos-admin.css under --role-*.         ║
// ║                                                                    ║
// ║  Attributes:                                                       ║
// ║    role="admin|office|accounts|leadingHand|tradie|client"          ║
// ║    label="..."        — override the displayed text                ║
// ║    size="sm|md"       — md default                                 ║
// ╚════════════════════════════════════════════════════════════════════╝

const STYLES = `
  :host {
    display: inline-flex;
    align-items: center;
    font-family: var(--mono, monospace);
    font-size: 10.5px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .04em;
    line-height: 1;
    padding: 3px 10px;
    border-radius: 999px;
    color: var(--ink-2, #2a3958);
    background: var(--paper-2, #ebe7df);
    white-space: nowrap;
  }
  :host([size="sm"]) {
    font-size: 9.5px;
    padding: 2px 7px;
  }

  :host([role="admin"])       { color: var(--role-admin, #5b3a8a);       background: var(--role-admin-bg, #efeaf6); }
  :host([role="office"])      { color: var(--role-office, #1c5fb8);      background: var(--role-office-bg, #e0e9f7); }
  :host([role="accounts"])    { color: var(--role-accounts, #1f8b5a);    background: var(--role-accounts-bg, #e0ede5); }
  :host([role="leadingHand"]) { color: var(--role-leadingHand, #b76b00); background: var(--role-leadingHand-bg, #fbf1de); }
  :host([role="tradie"])      { color: var(--role-tradie, #2557a3);      background: var(--role-tradie-bg, #e7eef9); }
  :host([role="client"])      { color: var(--role-client, #186e48);      background: var(--role-client-bg, #e8f4ec); }
`;

const LABELS = {
  admin:        'ADMIN',
  office:       'OFFICE',
  accounts:     'ACCOUNTS',
  leadingHand:  'LH',
  tradie:       'TRADIE',
  client:       'CLIENT',
};

class RolePill extends HTMLElement {
  static get observedAttributes() { return ['role', 'label']; }
  constructor() {
    super();
    const r = this.attachShadow({ mode: 'open' });
    r.innerHTML = `<style>${STYLES}</style><span class="lab"></span>`;
    this._labEl = r.querySelector('.lab');
  }
  attributeChangedCallback() { this._render(); }
  connectedCallback() { this._render(); }
  _render() {
    const role = (this.getAttribute('role') || '').trim();
    const text = this.getAttribute('label') || LABELS[role] || (role ? role.toUpperCase() : '—');
    this._labEl.textContent = text;
  }
}

if (!customElements.get('role-pill')) {
  customElements.define('role-pill', RolePill);
}
