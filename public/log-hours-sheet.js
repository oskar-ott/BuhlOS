// BuhlOS — log-hours bottom sheet modal
//
// Vanilla, self-contained, no deps. Mirrors the install-prompt pattern:
// injects its own styles, no global CSS dependencies, exposes one entry point.
//
// Usage:
//   <script src="/log-hours-sheet.js" defer></script>
//   BuhlLogHours.open({
//     scheduledJobId: 'abc-123' | null,
//     entry: existingEntry | undefined,    // pass to edit
//     defaultDate: 'YYYY-MM-DD' | undefined,
//     // On-behalf editing (admin/LH only — server enforces):
//     targetUserId:   'user-id' | undefined,    // edit/create for this user instead of the logged-in user
//     targetUserName: 'Display Name' | undefined,
//     onSaved: () => { ... },
//   });

(function () {
  'use strict';

  let activeOverlay = null;

  window.BuhlLogHours = {
    open(opts) {
      if (activeOverlay) return;
      injectStyles();
      activeOverlay = renderSheet(opts || {});
    },
    close() { if (activeOverlay) { activeOverlay.remove(); activeOverlay = null; } },
  };

  // ─── Styles ───────────────────────────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('log-hours-styles')) return;
    var s = document.createElement('style');
    s.id = 'log-hours-styles';
    s.textContent = ''
      + '.lh-overlay{position:fixed;inset:0;z-index:700;display:flex;align-items:flex-end;justify-content:center;animation:lhFade .25s ease}'
      + '.lh-scrim{position:absolute;inset:0;background:rgba(15,23,42,.55)}'
      + '.lh-sheet{position:relative;width:100%;max-width:480px;background:#fff;color:#0f172a;'
      +   'border-radius:18px 18px 0 0;padding:18px 18px max(20px,env(safe-area-inset-bottom)) 18px;'
      +   'max-height:92vh;overflow-y:auto;box-shadow:0 -8px 32px rgba(0,0,0,.25);'
      +   'animation:lhSlide .3s cubic-bezier(.2,.8,.2,1);'
      +   'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}'
      + '@media(min-width:520px){.lh-overlay{padding:0 16px env(safe-area-inset-bottom)}.lh-sheet{margin-bottom:16px;border-radius:18px}}'
      + '.lh-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}'
      + '.lh-title{font-size:17px;font-weight:800;color:#0d1f35;margin:0;letter-spacing:-.2px}'
      + '.lh-close{background:none;border:none;font-size:24px;color:#94a3b8;cursor:pointer;padding:0 4px;line-height:1}'
      + '.lh-row{margin-bottom:12px}'
      + '.lh-label{display:block;font-size:11px;font-weight:700;color:#64748b;margin-bottom:5px;text-transform:uppercase;letter-spacing:.5px}'
      + '.lh-input,.lh-select,.lh-textarea{width:100%;box-sizing:border-box;border:1px solid #e2e8f0;border-radius:10px;'
      +   'padding:10px 12px;font-size:14px;background:#fff;font-family:inherit;color:#0f172a;outline:none;-webkit-appearance:none}'
      + '.lh-input:focus,.lh-select:focus,.lh-textarea:focus{border-color:#0d1f35}'
      + '.lh-total{font-size:13px;color:#475569;margin-top:8px;display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap}'
      + '.lh-total strong{color:#0d1f35;font-size:15px;font-weight:800}'
      // Total-hours grid: a wide hours-input cell on the left, minute chips
      // on the right. Hours sets the integer hours; minutes is a chip pick of
      // 0/15/30/45 — phone-friendly, fast, no native picker.
      + '.lh-hm-grid{display:flex;gap:10px;align-items:stretch}'
      + '.lh-hm-cell{position:relative;flex-shrink:0;width:104px}'
      + '.lh-hm-input{font-size:24px;font-weight:800;padding:14px 30px 14px 14px;text-align:center;height:54px}'
      + '.lh-hm-input::-webkit-outer-spin-button,.lh-hm-input::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}'
      + '.lh-hm-input{-moz-appearance:textfield}'
      + '.lh-hm-suf{position:absolute;right:14px;top:50%;transform:translateY(-50%);font-size:14px;font-weight:700;color:#94a3b8;pointer-events:none}'
      + '.lh-min-chips{display:grid;grid-template-columns:repeat(4,1fr);gap:6px;flex:1}'
      + '.lh-min-chip{appearance:none;-webkit-appearance:none;border:1px solid #e2e8f0;background:#fff;color:#0d1f35;'
      +   'border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit;line-height:1;'
      +   'display:flex;align-items:center;justify-content:center;min-height:54px;font-variant-numeric:tabular-nums}'
      + '.lh-min-chip:hover{background:#f8fafc}'
      + '.lh-min-chip.on{background:#0d1f35;border-color:#0d1f35;color:#fff}'
      + '.lh-quick{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap}'
      + '.lh-quick-lbl{font-size:10px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;padding:6px 0;flex-shrink:0}'
      + '.lh-quick-chip{appearance:none;-webkit-appearance:none;border:1px solid #e2e8f0;background:#fff;color:#0d1f35;'
      +   'border-radius:999px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;line-height:1;min-height:36px;flex:1;min-width:60px}'
      + '.lh-quick-chip:hover{background:#f8fafc}'
      + '.lh-quick-chip.on{background:#ffcc00;border-color:#ffcc00;color:#0f172a;box-shadow:0 1px 4px rgba(255,204,0,.3)}'
      + '.lh-alloc-row{display:flex;gap:6px;align-items:flex-start;margin-bottom:6px}'
      + '.lh-alloc-job{flex:1;min-width:0}'
      + '.lh-alloc-hours{width:74px;text-align:center}'
      + '.lh-alloc-remove{background:none;border:none;color:#94a3b8;font-size:22px;padding:0 6px;cursor:pointer;align-self:center;line-height:1}'
      + '.lh-alloc-remainder{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px}'
      + '.lh-rem-ok{color:#16a34a}'
      + '.lh-rem-under{color:#d97706}'
      + '.lh-rem-over{color:#dc2626}'
      + '.lh-add-job{background:none;border:none;color:#0d1f35;font-size:13px;font-weight:700;padding:6px 0;cursor:pointer}'
      + '.lh-ot-toggle{width:100%;display:flex;justify-content:space-between;align-items:center;padding:10px 0;background:none;border:none;font-size:13px;color:#475569;cursor:pointer;font-family:inherit}'
      + '.lh-ot-toggle strong{color:#0d1f35;font-weight:800}'
      + '.lh-ot-auto{font-size:11px;color:#94a3b8;margin-left:4px}'
      + '.lh-ot-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px}'
      + '.lh-reset-auto{grid-column:span 2;background:none;border:none;color:#0d1f35;font-size:12px;cursor:pointer;padding:4px 0 0;font-weight:600}'
      + '.lh-error{background:#fef2f2;color:#991b1b;padding:9px 12px;border-radius:9px;font-size:13px;margin-bottom:10px;border:1px solid #fecaca}'
      + '.lh-rejected-banner{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:10px 12px;border-radius:10px;font-size:13px;margin-bottom:14px;line-height:1.45}'
      + '.lh-rejected-banner b{font-weight:700}'
      + '.lh-onbehalf-banner{background:#dbeafe;border:1px solid #bfdbfe;color:#1e40af;padding:10px 12px;border-radius:10px;font-size:13px;margin-bottom:14px;line-height:1.4;display:flex;align-items:center;gap:8px}'
      + '.lh-onbehalf-banner b{font-weight:800;color:#1e3a8a}'
      + '.lh-onbehalf-banner::before{content:"⚖";font-size:16px;line-height:1;flex-shrink:0}'
      + '.lh-footer{display:flex;gap:8px;margin-top:16px}'
      + '.lh-btn{flex:1;padding:13px;border-radius:10px;font-size:14px;font-weight:700;border:none;cursor:pointer;font-family:inherit;min-height:46px}'
      + '.lh-btn:disabled{opacity:.5;cursor:not-allowed}'
      + '.lh-btn-secondary{background:#fff;border:1px solid #e2e8f0;color:#475569}'
      + '.lh-btn-secondary:hover{background:#f8fafc}'
      + '.lh-btn-primary{background:#ffcc00;color:#0f172a;font-weight:800;letter-spacing:-.1px;box-shadow:0 2px 8px rgba(255,204,0,.3)}'
      + '.lh-btn-primary:hover{filter:brightness(.96)}'
      + '.lh-jp-wrap{position:relative}'
      + '.lh-jp-button{width:100%;text-align:left;background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;font-size:14px;cursor:pointer;font-family:inherit;color:#0f172a;min-height:42px;-webkit-appearance:none}'
      + '.lh-jp-placeholder{color:#94a3b8}'
      + '.lh-jp-name{font-weight:700;color:#0d1f35;display:block;line-height:1.2}'
      + '.lh-jp-id{color:#64748b;font-size:12px;display:block;margin-top:1px}'
      + '.lh-jp-dropdown{position:absolute;left:0;right:0;top:100%;margin-top:4px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 8px 24px rgba(15,23,42,.15);max-height:280px;overflow-y:auto;z-index:10}'
      + '.lh-jp-search{width:100%;box-sizing:border-box;padding:10px 12px;border:none;border-bottom:1px solid #e2e8f0;font-size:14px;outline:none;font-family:inherit;color:#0f172a}'
      + '.lh-jp-section{padding:8px 12px 4px;font-size:10px;font-weight:800;color:#64748b;text-transform:uppercase;letter-spacing:.5px}'
      + '.lh-jp-row{width:100%;text-align:left;background:none;border:none;padding:9px 12px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-family:inherit}'
      + '.lh-jp-row:hover,.lh-jp-row:focus{background:#f8fafc;outline:none}'
      + '.lh-jp-pill{background:#ffcc00;color:#0f172a;font-size:10px;font-weight:800;padding:2px 8px;border-radius:999px;flex-shrink:0;margin-left:8px;text-transform:uppercase;letter-spacing:.4px}'
      + '.lh-jp-internal{width:100%;text-align:left;background:none;border:none;border-top:1px solid #e2e8f0;padding:10px 12px;font-size:13px;color:#475569;cursor:pointer;font-family:inherit}'
      + '.lh-jp-internal:hover{background:#f8fafc}'
      + '.lh-jp-empty{padding:14px;color:#94a3b8;font-size:13px;text-align:center}'
      + '@keyframes lhFade{from{opacity:0}to{opacity:1}}'
      + '@keyframes lhSlide{from{transform:translateY(100%)}to{transform:translateY(0)}}';
    document.head.appendChild(s);
  }

  // ─── Sheet ────────────────────────────────────────────────────────────────
  function renderSheet(opts) {
    var today = new Date().toISOString().slice(0, 10);

    // Workers log total hours, not start/end times. We seed hoursH/hoursM
    // from the existing entry's totalHours when editing, or from a sensible
    // 8h default on create. Existing start/end fields on the entry are
    // preserved server-side via the PATCH merge — we just don't show them.
    var seedTotal = (opts.entry && typeof opts.entry.totalHours === 'number')
      ? opts.entry.totalHours
      : 8;
    var seedH = Math.max(0, Math.min(23, Math.floor(seedTotal)));
    var seedMRaw = Math.round((seedTotal - seedH) * 60);
    // Snap minutes to the nearest 15 so the chip control accurately reflects
    // the value (existing entries with 7.42hrs won't show as "25 min" in a
    // 0/15/30/45 picker — pick the closest chip).
    var seedM = [0, 15, 30, 45].reduce(function (best, m) {
      return Math.abs(m - seedMRaw) < Math.abs(best - seedMRaw) ? m : best;
    }, 0);

    var state = {
      mode: opts.entry ? 'edit' : 'create',
      entry: opts.entry || null,
      // Admin/LH "log on behalf" — when set, all API URLs append ?userId=
      targetUserId:   opts.targetUserId   || (opts.entry && opts.entry.userId) || null,
      targetUserName: opts.targetUserName || (opts.entry && opts.entry.userName) || null,
      date: (opts.entry && opts.entry.date) || opts.defaultDate || today,
      // Total-hours model — replaces start/end/break.
      hoursH: seedH,
      hoursM: seedM,
      ordinaryHours: opts.entry && opts.entry.ordinaryHours != null ? opts.entry.ordinaryHours : 0,
      overtimeHours: opts.entry && opts.entry.overtimeHours != null ? opts.entry.overtimeHours : 0,
      otOverridden: !!(opts.entry && opts.entry.otOverridden),
      notes: (opts.entry && opts.entry.notes) || '',
      allocations: opts.entry && Array.isArray(opts.entry.allocations) && opts.entry.allocations.length
        ? opts.entry.allocations.map(function(a){ return { _key: rid(), jobId: a.jobId || null, hours: a.hours, notes: a.notes || null, _internal: !a.jobId }; })
        : [{ _key: rid(), jobId: opts.scheduledJobId || null, hours: seedTotal, notes: null, _internal: false }],
      scheduledJobId: opts.scheduledJobId || null,
      jobsCache: null,
      recentJobIds: [],
      submitting: false,
      error: null,
      _otOpen: false,
    };

    var overlay = document.createElement('div');
    overlay.className = 'lh-overlay';
    overlay.innerHTML = '<div class="lh-scrim" data-action="cancel"></div><div class="lh-sheet"></div>';
    document.body.appendChild(overlay);
    overlay.querySelector('[data-action="cancel"]').addEventListener('click', closeSheet);

    function closeSheet() { overlay.remove(); activeOverlay = null; }

    Promise.all([fetchJobs(), fetchRecent()]).then(function (vals) {
      state.jobsCache = vals[0];
      state.recentJobIds = vals[1];
      rerender();
    });

    // Total = whole hours + minutes/60. Single source of truth for the
    // payload, the OT split, and the allocation autofill.
    function totalHours() {
      var h = Number(state.hoursH) || 0;
      var m = Number(state.hoursM) || 0;
      return Math.round((h + m / 60) * 100) / 100;
    }
    function allocSum() { return state.allocations.reduce(function (s, a) { return s + (Number(a.hours) || 0); }, 0); }

    // When there's only one allocation row (the common worker case), keep
    // its hours synced to the total so workers don't have to enter the same
    // number twice. If they manually split across jobs, we leave it alone.
    function syncSingleAllocation() {
      if (state.allocations.length === 1) {
        state.allocations[0].hours = totalHours();
      }
    }

    function autoOTIfNeeded() {
      if (state.otOverridden) return;
      var t = totalHours();
      state.ordinaryHours = Math.round(Math.min(t, 8) * 100) / 100;
      state.overtimeHours = Math.round(Math.max(0, t - 8) * 100) / 100;
    }

    function rerender() {
      // Always keep the single-allocation case synced to the latest total
      // before we run OT auto-split + render so everything is in agreement.
      syncSingleAllocation();
      autoOTIfNeeded();
      var total = totalHours();
      var allocated = allocSum();
      var remainder = Math.round((total - allocated) * 100) / 100;
      var remState = remainder === 0 ? 'ok' : remainder > 0 ? 'under' : 'over';
      var canSubmit =
        total > 0 &&
        remainder === 0 &&
        state.allocations.every(function (a) { return Number(a.hours) > 0; }) &&
        state.allocations.every(function (a) { return a.jobId || a._internal; }) &&
        Math.abs((Number(state.ordinaryHours) + Number(state.overtimeHours)) - total) < 0.01;

      var remainderLabel = remState === 'ok'
        ? '✓ Fully allocated'
        : remState === 'under'
          ? (remainder.toFixed(2) + ' hrs unallocated')
          : (Math.abs(remainder).toFixed(2) + ' hrs over');

      // Quick-hour preset chips — one tap to common worker totals.
      // Highlights the chip matching the current total (within 0.05).
      var QUICK_HOURS = [6, 7, 7.5, 8, 8.5, 9];
      var quickChipsHtml = '<div class="lh-quick">'
        + QUICK_HOURS.map(function(h){
            var on = Math.abs(total - h) < 0.05;
            var lbl = (h === Math.floor(h)) ? (h + 'h') : (h.toFixed(1) + 'h');
            return '<button type="button" class="lh-quick-chip' + (on ? ' on' : '') + '" data-quick-h="' + h + '">' + lbl + '</button>';
          }).join('')
        + '</div>';

      // Minute chips: 0/15/30/45 — workers don't need finer granularity, and
      // a chip row is faster to tap than a number stepper on phones.
      var MIN_CHOICES = [0, 15, 30, 45];
      var minChipsHtml = MIN_CHOICES.map(function(m){
        return '<button type="button" class="lh-min-chip' + (state.hoursM === m ? ' on' : '') + '" data-min="' + m + '">' + m + '</button>';
      }).join('');

      var otBlockHtml = state._otOpen
        ? ('<div class="lh-ot-grid">'
            + '<div><label class="lh-label">Ordinary</label><input class="lh-input" type="number" step="0.25" min="0" data-bind="ordinaryHours" data-override-ot="1" value="' + state.ordinaryHours + '"></div>'
            + '<div><label class="lh-label">Overtime</label><input class="lh-input" type="number" step="0.25" min="0" data-bind="overtimeHours" data-override-ot="1" value="' + state.overtimeHours + '"></div>'
            + (state.otOverridden ? '<button class="lh-reset-auto" data-action="reset-ot">Reset to auto</button>' : '')
            + '</div>')
        : '';

      var rejectedBannerHtml = (state.entry && state.entry.status === 'rejected' && state.entry.rejectedReason)
        ? ('<div class="lh-rejected-banner"><b>Rejected:</b> ' + esc(state.entry.rejectedReason) + '. Fix and resubmit.</div>')
        : '';

      // On-behalf banner: shown whenever this modal is acting on a different
      // user's entry (server enforces the actual permission).
      var onBehalfBannerHtml = '';
      if (state.targetUserId && state.targetUserName) {
        // We don't have a reliable client-side "logged in user id" here; a name
        // mismatch with the entry's userName is enough signal for the banner to
        // be useful. (When self-editing, the entry.userName === current user.)
        onBehalfBannerHtml = '<div class="lh-onbehalf-banner">'
          + (state.mode === 'edit' ? 'Editing ' : 'Logging for ')
          + '<b>' + esc(state.targetUserName) + '</b>'
          + ' &nbsp;·&nbsp; saves to their timecard, not yours.'
          + '</div>';
      }

      var errorHtml = state.error ? ('<div class="lh-error">' + esc(state.error) + '</div>') : '';
      var otAutoTag = !state.otOverridden ? '<span class="lh-ot-auto">(auto)</span>' : '';

      var sheet = overlay.querySelector('.lh-sheet');
      sheet.innerHTML =
          '<div class="lh-header">'
        +   '<h2 class="lh-title">' + (state.mode === 'edit' ? 'Edit hours' : 'Log hours') + '</h2>'
        +   '<button class="lh-close" data-action="cancel" aria-label="Close">×</button>'
        + '</div>'
        + onBehalfBannerHtml
        + rejectedBannerHtml
        + '<div class="lh-row">'
        +   '<label class="lh-label">Date</label>'
        +   '<input class="lh-input" type="date" data-bind="date" value="' + state.date + '">'
        + '</div>'
        + '<div class="lh-row">'
        +   '<label class="lh-label">Total hours</label>'
        +   '<div class="lh-hm-grid">'
        +     '<div class="lh-hm-cell">'
        +       '<input class="lh-input lh-hm-input" type="number" min="0" max="23" step="1" data-bind-num="hoursH" value="' + state.hoursH + '" inputmode="numeric" aria-label="Hours">'
        +       '<span class="lh-hm-suf">h</span>'
        +     '</div>'
        +     '<div class="lh-min-chips" role="group" aria-label="Minutes">' + minChipsHtml + '</div>'
        +   '</div>'
        +   quickChipsHtml
        + '</div>'
        // Allocation section. For the common single-job case the header
        // ("Allocate to jobs … X unallocated") is just noise — workers see
        // a plain job picker with the total auto-filled. The "+ Add another
        // job" button still exists for split-day workers.
        + '<div class="lh-row">'
        +   (state.allocations.length > 1
            ? '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
              + '<span class="lh-label" style="margin:0">Split across jobs</span>'
              + '<span class="lh-alloc-remainder lh-rem-' + remState + '">' + remainderLabel + '</span>'
              + '</div>'
            : '<label class="lh-label">Job</label>')
        +   '<div data-region="allocations"></div>'
        +   '<button class="lh-add-job" data-action="add-alloc">'
        +     (state.allocations.length > 1 ? '+ Add another job' : '+ Split across jobs')
        +   '</button>'
        + '</div>'
        // OT section. Hidden in the simple case (total ≤ 8 with auto-split,
        // no manual override) — workers don't care about ordinary/OT split
        // when there's no overtime. Surfaced when total > 8 OR when admin
        // has expanded it manually OR when previously overridden.
        + ((total > 8 || state.otOverridden || state._otOpen)
          ? '<div class="lh-row">'
            + '<button class="lh-ot-toggle" data-action="toggle-ot">'
            + '<span>Ordinary <strong>' + Number(state.ordinaryHours).toFixed(2) + '</strong> · OT <strong>' + Number(state.overtimeHours).toFixed(2) + '</strong>' + otAutoTag + '</span>'
            + '<span style="color:#94a3b8">' + (state._otOpen ? '▴' : '▾') + '</span>'
            + '</button>'
            + otBlockHtml
            + '</div>'
          : '')
        + '<div class="lh-row">'
        +   '<label class="lh-label">Notes (optional)</label>'
        +   '<textarea class="lh-textarea" rows="2" data-bind="notes" placeholder="e.g. rough-in level 3, ran cable to MSB">' + esc(state.notes) + '</textarea>'
        + '</div>'
        + errorHtml
        + '<div class="lh-footer">'
        +   '<button class="lh-btn lh-btn-secondary" data-action="save-draft"' + (total === 0 || state.submitting ? ' disabled' : '') + '>Save draft</button>'
        +   '<button class="lh-btn lh-btn-primary" data-action="submit"' + (!canSubmit || state.submitting ? ' disabled' : '') + '>' + (state.submitting ? 'Saving…' : 'Submit') + '</button>'
        + '</div>';

      var allocRegion = sheet.querySelector('[data-region="allocations"]');
      state.allocations.forEach(function (a, idx) { allocRegion.appendChild(renderAllocRow(a, idx, state, rerender)); });

      sheet.querySelectorAll('[data-bind]').forEach(function (el) {
        el.addEventListener('input', function () {
          var key = el.dataset.bind;
          var val = el.value;
          if (el.type === 'number') val = parseFloat(val) || 0;
          if (el.dataset.overrideOt) state.otOverridden = true;
          state[key] = val;
          rerender();
        });
      });

      // data-bind-num: integer-clamped numeric inputs (hoursH). Always
      // re-renders so the total + allocation sync stays correct as the user
      // types. Bare `parseInt` to avoid leading-zero / decimal weirdness.
      sheet.querySelectorAll('[data-bind-num]').forEach(function (el) {
        el.addEventListener('input', function () {
          var key = el.dataset.bindNum;
          var raw = parseInt(el.value, 10);
          if (isNaN(raw)) raw = 0;
          if (raw < 0) raw = 0;
          if (key === 'hoursH' && raw > 23) raw = 23;
          state[key] = raw;
          rerender();
        });
      });

      // Minute chips — exclusive, one of {0,15,30,45}.
      sheet.querySelectorAll('[data-min]').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          state.hoursM = parseInt(el.dataset.min, 10) || 0;
          rerender();
        });
      });

      sheet.querySelectorAll('[data-action]').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          var action = el.dataset.action;
          if (action === 'cancel') closeSheet();
          else if (action === 'add-alloc') {
            state.allocations.push({ _key: rid(), jobId: null, hours: 0, notes: null, _internal: false });
            rerender();
          } else if (action === 'toggle-ot') { state._otOpen = !state._otOpen; rerender(); }
          else if (action === 'reset-ot')   { state.otOverridden = false; rerender(); }
          else if (action === 'save-draft') save('draft');
          else if (action === 'submit')     save('submitted');
        });
      });

      // Quick-hour chips — set total directly. Tapping a chip overrides
      // both whole-hours and minutes so e.g. "7.5h" → 7h + 30m chip selected.
      sheet.querySelectorAll('[data-quick-h]').forEach(function (el) {
        el.addEventListener('click', function (e) {
          e.preventDefault();
          var targetH = parseFloat(el.dataset.quickH);
          if (isNaN(targetH) || targetH <= 0) return;
          state.hoursH = Math.floor(targetH);
          var rawMin = Math.round((targetH - state.hoursH) * 60);
          // Snap to nearest 15 so the minute chips stay accurate.
          state.hoursM = [0, 15, 30, 45].reduce(function (best, m) {
            return Math.abs(m - rawMin) < Math.abs(best - rawMin) ? m : best;
          }, 0);
          rerender();
        });
      });
    }

    async function save(status) {
      // If editing a rejected entry and the user picks "Save draft", that's fine (clears nothing).
      // But if they're transitioning from rejected → resubmit, surface as `submitted`.
      state.submitting = true;
      state.error = null;
      rerender();
      try {
        // Total-hours payload — no start/end/break. The server preserves
        // any existing start/end fields on PATCH (`{...existing, ...body}`),
        // and new entries get null values per the API contract.
        var payload = {
          date: state.date,
          totalHours: totalHours(),
          ordinaryHours: Number(state.ordinaryHours),
          overtimeHours: Number(state.overtimeHours),
          otOverridden: state.otOverridden,
          notes: state.notes || null,
          status: status,
          allocations: state.allocations.map(function (a) {
            return { jobId: a._internal ? null : a.jobId, hours: Number(a.hours), notes: a.notes || null };
          }),
        };
        // On-behalf: append ?userId= for both PATCH (edits the target user's
        // entry) and POST (creates for the target user). Server enforces.
        var qs = [];
        if (state.mode === 'edit') qs.push('date=' + encodeURIComponent(state.date));
        if (state.targetUserId) qs.push('userId=' + encodeURIComponent(state.targetUserId));
        var url = '/api/time-entries' + (qs.length ? '?' + qs.join('&') : '');
        var method = state.mode === 'edit' ? 'PATCH' : 'POST';
        var res = await fetch(url, {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(payload),
        });
        // Friendly 409: an entry for this user+date already exists. Instead of
        // erroring, fetch it and switch the modal into edit mode in-place.
        if (res.status === 409 && state.mode === 'create') {
          try {
            var existingRes = await fetch(
              '/api/time-entries?fromDate=' + encodeURIComponent(state.date) +
              '&toDate=' + encodeURIComponent(state.date) +
              (state.targetUserId ? '&userId=' + encodeURIComponent(state.targetUserId) : ''),
              { credentials: 'same-origin' }
            );
            if (existingRes.ok) {
              var existing = ((await existingRes.json()).entries || [])
                .find(function(e){ return e.date === state.date; });
              if (existing) {
                state.mode  = 'edit';
                state.entry = existing;
                state.error = 'Already logged for this day — switched to edit. Adjust and save again.';
                state.submitting = false;
                rerender();
                return;
              }
            }
          } catch (_) {}
        }
        if (!res.ok) {
          var j = {};
          try { j = await res.json(); } catch (e) {}
          throw new Error((j && j.error) || ('Failed (' + res.status + ')'));
        }
        // Pass the saved entry back to onSaved so callers can render
        // confirmation toasts with the actual logged total ("Logged 7h 30m").
        var savedEntry = null;
        try { var jr = await res.json(); savedEntry = (jr && jr.entry) || null; } catch (_) {}
        if (typeof opts.onSaved === 'function') opts.onSaved(savedEntry);
        closeSheet();
      } catch (e) {
        state.error = e.message || 'Save failed';
        state.submitting = false;
        rerender();
      }
    }

    rerender();
    return overlay;
  }

  // ─── Allocation row + Job picker ──────────────────────────────────────────
  // Single-allocation rows hide the per-row hours input: the day's total IS
  // the allocation in that case, and showing both creates confusion ("which
  // number is real?"). When splitting across jobs (≥ 2 allocations) the
  // hours input reappears so workers can divide the day.
  function renderAllocRow(alloc, idx, state, rerender) {
    var wrap = document.createElement('div');
    wrap.className = 'lh-alloc-row';
    var multi = state.allocations.length > 1;
    wrap.innerHTML = ''
      + '<div class="lh-alloc-job"></div>'
      + (multi
          ? '<input class="lh-input lh-alloc-hours" type="number" step="0.25" min="0" value="' + (alloc.hours || '') + '" placeholder="hrs" inputmode="decimal">'
          : '')
      + (multi ? '<button class="lh-alloc-remove" aria-label="Remove">×</button>' : '');
    wrap.querySelector('.lh-alloc-job').appendChild(renderJobPicker(alloc, state, rerender));
    var hi = wrap.querySelector('.lh-alloc-hours');
    if (hi) hi.addEventListener('input', function (e) {
      alloc.hours = parseFloat(e.target.value) || 0;
      rerender();
    });
    var rm = wrap.querySelector('.lh-alloc-remove');
    if (rm) rm.addEventListener('click', function () {
      state.allocations = state.allocations.filter(function (a) { return a._key !== alloc._key; });
      rerender();
    });
    return wrap;
  }

  function renderJobPicker(alloc, state, rerender) {
    var wrap = document.createElement('div');
    wrap.className = 'lh-jp-wrap';
    var open = false;
    var search = '';

    function render() {
      var jobs = state.jobsCache || [];
      var excludeIds = state.allocations
        .filter(function (a) { return a._key !== alloc._key; })
        .map(function (a) { return a.jobId; })
        .filter(Boolean);
      var lower = search.toLowerCase();
      var filtered = jobs.filter(function (j) {
        if (excludeIds.indexOf(j.id) !== -1) return false;
        if (!search) return true;
        return (j.name || '').toLowerCase().indexOf(lower) !== -1
            || (j.id   || '').toLowerCase().indexOf(lower) !== -1;
      });
      var scheduled = state.scheduledJobId ? filtered.filter(function (j) { return j.id === state.scheduledJobId; }) : [];
      var recent = filtered.filter(function (j) { return state.recentJobIds.indexOf(j.id) !== -1 && j.id !== state.scheduledJobId; }).slice(0, 5);
      var usedIds = {};
      [].concat(scheduled, recent).forEach(function (j) { usedIds[j.id] = 1; });
      var rest = filtered.filter(function (j) { return !usedIds[j.id]; });

      var current = jobs.find(function (j) { return j.id === alloc.jobId; });
      var buttonInner = alloc._internal
        ? '<em style="color:#475569">Internal — no job</em>'
        : current
          ? '<span class="lh-jp-name">' + esc(current.name) + '</span><span class="lh-jp-id">' + esc(current.id) + '</span>'
          : '<span class="lh-jp-placeholder">Select a job…</span>';

      wrap.innerHTML = ''
        + '<button type="button" class="lh-jp-button">' + buttonInner + '</button>'
        + (open
            ? '<div class="lh-jp-dropdown">'
              + '<input class="lh-jp-search" placeholder="Search jobs…" value="' + esc(search) + '">'
              + (scheduled.length ? '<div class="lh-jp-section">Today’s job</div>' + scheduled.map(function (j) { return jobRowHtml(j, true); }).join('') : '')
              + (recent.length    ? '<div class="lh-jp-section">Recent</div>' + recent.map(function (j) { return jobRowHtml(j, false); }).join('') : '')
              + (rest.length      ? '<div class="lh-jp-section">All active jobs</div>' + rest.map(function (j) { return jobRowHtml(j, false); }).join('') : '')
              + (!filtered.length ? '<div class="lh-jp-empty">No jobs found</div>' : '')
              + '<button type="button" class="lh-jp-internal" data-internal="1">No job — internal (training, sick, RDO)</button>'
            + '</div>'
            : '');

      wrap.querySelector('.lh-jp-button').addEventListener('click', function () { open = !open; render(); });
      if (open) {
        var s = wrap.querySelector('.lh-jp-search');
        s.addEventListener('input', function (e) { search = e.target.value; render(); });
        setTimeout(function () { s.focus(); }, 30);
        wrap.querySelectorAll('[data-job-id]').forEach(function (el) {
          el.addEventListener('click', function () {
            alloc.jobId = el.dataset.jobId;
            alloc._internal = false;
            open = false;
            rerender();
          });
        });
        var ib = wrap.querySelector('[data-internal]');
        if (ib) ib.addEventListener('click', function () {
          alloc.jobId = null;
          alloc._internal = true;
          open = false;
          rerender();
        });
      }
    }
    render();
    return wrap;
  }

  function jobRowHtml(job, scheduled) {
    return ''
      + '<button type="button" class="lh-jp-row" data-job-id="' + esc(job.id) + '">'
      +   '<span style="min-width:0;flex:1">'
      +     '<span class="lh-jp-name">' + esc(job.name) + '</span>'
      +     '<span class="lh-jp-id">' + esc(job.id) + '</span>'
      +   '</span>'
      +   (scheduled ? '<span class="lh-jp-pill">Scheduled</span>' : '')
      + '</button>';
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function rid() { return Math.random().toString(36).slice(2, 9); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  async function fetchJobs() {
    try {
      var r = await fetch('/api/jobs', { credentials: 'same-origin' });
      if (!r.ok) return [];
      var d = await r.json();
      return (d.jobs || []).filter(function (j) { return (j.status || 'active') === 'active'; });
    } catch { return []; }
  }
  async function fetchRecent() {
    try {
      var r = await fetch('/api/time-entries-recent-jobs', { credentials: 'same-origin' });
      if (!r.ok) return [];
      var d = await r.json();
      return d.jobIds || [];
    } catch { return []; }
  }
})();
