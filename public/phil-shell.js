// Phil shared shell — utilities + Me-sheet wiring shared across the
// worker pages (/my-day, /jobs, /my-gear, /onboarding). Workspace
// (/jobs/:id, index.html) uses a different element-id namespace
// (workerMe*) and stays inline.
//
// Loaded via a synchronous <script src="/phil-shell.js"></script>
// tag immediately before each page's inline <script>, so window.PhilShell
// is on the global by the time the inline boot code runs.
//
// PhilShell.mountMeSheet(user[, ids]) wires the Me sheet on the current
// page. Default ID map (matches /my-day, /my-gear, /jobs, /onboarding):
//   #tab-me        button that opens the sheet
//   #me-scrim      the backdrop that contains the sheet
//   #me-who-name   identity name
//   #me-who-role   identity role label
//   #me-avatar     2-letter initials
//   #me-signout    sign-out action
//   #me-cancel     cancel button
//
// Workspace (/jobs/:id, index.html) passes a custom map because its
// page chrome uses different IDs (`workerMe*`) to avoid colliding with
// pre-existing markup in that 9600-line file. Pass `{ tab: 'workerTabMe',
// scrim: 'workerMeScrim', ... }` to point mountMeSheet at custom IDs.
//
// If a page omits any non-required IDs (e.g. /onboarding's sheet
// doesn't include the Onboarding link) the missing nodes are just
// skipped — mountMeSheet wires only what it finds.

(function () {
  'use strict';

  const PhilShell = {
    // HTML-escape a value before interpolating into innerHTML. Returns
    // an empty string for null/undefined so template strings don't
    // render the word "null".
    esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    },

    // Two-letter initials for an avatar. Splits on whitespace + the
    // common separator characters that show up in usernames; falls
    // back to "?" so the avatar never renders empty.
    initials(name) {
      return String(name || '?')
        .split(/[\s._-]+/).filter(Boolean).slice(0, 2)
        .map(w => w[0]).join('').toUpperCase() || '?';
    },

    // Wire the Me sheet on the current page. Returns { open, close }
    // for programmatic control; the tab button is also wired internally.
    // Idempotent in practice (it's only called once per page boot).
    //
    // `ids` is an optional override map for pages that use a custom
    // element-id namespace (Workspace passes workerMe*).
    mountMeSheet(user, ids) {
      const map = Object.assign({
        tab:     'tab-me',
        scrim:   'me-scrim',
        cancel:  'me-cancel',
        signOut: 'me-signout',
        nameEl:  'me-who-name',
        roleEl:  'me-who-role',
        avatar:  'me-avatar',
      }, ids || {});
      const tab     = document.getElementById(map.tab);
      const scrim   = document.getElementById(map.scrim);
      const cancel  = document.getElementById(map.cancel);
      const signOut = document.getElementById(map.signOut);
      const nameEl  = document.getElementById(map.nameEl);
      const roleEl  = document.getElementById(map.roleEl);
      const avEl    = document.getElementById(map.avatar);
      if (!tab || !scrim) return { open() {}, close() {} };

      const name = (user && user.username) || 'You';
      const roleLabel = user && user.role === 'leadingHand' ? 'Leading hand'
                      : user && user.role === 'tradie'      ? 'Tradie'
                      : '';
      if (nameEl) nameEl.textContent = name;
      if (roleEl) roleEl.textContent = roleLabel;
      if (avEl)   avEl.textContent   = PhilShell.initials(name);

      const open  = () => { scrim.hidden = false; document.body.style.overflow = 'hidden'; };
      const close = () => { scrim.hidden = true;  document.body.style.overflow = ''; };

      tab.addEventListener('click', open);
      if (cancel) cancel.addEventListener('click', close);
      scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
      // Only handle Escape while the sheet is open so we don't shadow
      // anything else listening at the document level.
      document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && !scrim.hidden) close();
      });

      if (signOut) {
        signOut.addEventListener('click', async () => {
          // All four worker pages use the same logout endpoint; funnel
          // through it so cookie clear + redirect stays consistent.
          try { await fetch('/api/auth?action=logout', { method:'POST', credentials:'same-origin' }); }
          catch (e) {}
          location.href = '/login';
        });
      }

      return { open, close };
    },
  };

  window.PhilShell = PhilShell;
})();
