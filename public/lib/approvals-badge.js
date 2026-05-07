// Lightweight pending-approvals badge for the nav pill.
//
// Drop this into any page that has an `#approvalsLink` nav-pill (or just a
// link to /approvals). On boot, fetches the submitted-entries count and
// renders a small red badge if > 0. Silent if push or auth fails.
//
// Usage:
//   <script src="/lib/approvals-badge.js" defer></script>
//   ...then make sure the Approvals link element has id="approvalsLink"
//   (jobs.html / admin.html already do; overview/approvals just need the id added).
//
// Safe to load on every page — if no approvals link exists, the script is a no-op.

(function () {
  // Inject one rule for the badge style — once.
  if (!document.getElementById('approvals-badge-style')) {
    var s = document.createElement('style');
    s.id = 'approvals-badge-style';
    s.textContent =
      '.pill-badge{display:inline-flex;align-items:center;justify-content:center;'
      + 'min-width:18px;height:18px;padding:0 6px;margin-left:6px;'
      + 'background:#dc2626;color:#fff;font-size:10px;font-weight:800;'
      + 'border-radius:999px;line-height:1;letter-spacing:0;font-variant-numeric:tabular-nums}';
    document.head.appendChild(s);
  }

  // Don't burn an API call if there's nowhere to render the badge.
  function findLink() {
    return document.getElementById('approvalsLink')
        || document.querySelector('a.nav-pill[href="/approvals"]')
        || null;
  }

  function setBadge(link, count) {
    if (!link) return;
    // Strip any existing badge first
    var existing = link.querySelector('.pill-badge');
    if (existing) existing.remove();
    if (count > 0) {
      var b = document.createElement('span');
      b.className = 'pill-badge';
      b.textContent = String(count);
      b.title = count + ' pending approval' + (count === 1 ? '' : 's');
      link.appendChild(b);
    }
  }

  async function refresh() {
    var link = findLink();
    if (!link) return;
    try {
      var r = await fetch('/api/time-entries?status=submitted&scope=approver',
                         { credentials: 'same-origin' });
      if (!r.ok) return; // 401/403 → silent (page handles auth itself)
      var j = await r.json();
      setBadge(link, ((j && j.entries) || []).length);
    } catch (e) { /* silent */ }
  }

  // Run once on DOM ready (deferred script means DOM is parsed already).
  // Re-run every 60s while the tab is visible so the badge stays fresh
  // without being chatty.
  refresh();
  var iv = setInterval(function () {
    if (document.visibilityState === 'visible') refresh();
  }, 60 * 1000);
  // When the tab regains focus, refresh immediately
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') refresh();
  });

  // Expose a manual refresh hook for after approve/reject actions
  window.refreshApprovalsBadge = refresh;
})();
