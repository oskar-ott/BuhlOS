// BuhlOS install prompt — shows a one-time bottom-sheet banner
// guiding users to add the app to their home screen.
//
// Three platform paths:
//   • iOS Safari        → share-button instructions
//   • Android Chrome    → native one-tap "Install now" via beforeinstallprompt
//   • iOS non-Safari    → "Open in Safari first" hint (Apple restriction:
//                          Chrome/Firefox/Edge on iOS can't install PWAs)
//
// Desktop and other unsupported browsers are silently skipped.

(function(){
  'use strict';

  // ── Already installed? ────────────────────────────────────────────
  var isStandalone = window.matchMedia('(display-mode: standalone)').matches
                  || window.navigator.standalone === true;
  if (isStandalone) return;

  // ── Platform detection ────────────────────────────────────────────
  var ua = navigator.userAgent || '';
  var isIOS         = /iP(hone|ad|od)/.test(ua) && !window.MSStream;
  var isIOSSafari   = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|OPiOS|EdgiOS|mercury/i.test(ua);
  var isIOSNonSafari = isIOS && !isIOSSafari;
  var isAndroid     = /Android/.test(ua);
  var isAndroidChrome = isAndroid && /Chrome\//.test(ua) && !/Edge|OPR|SamsungBrowser/.test(ua);

  // Anything other than the three supported paths → nothing to do
  if (!isIOSSafari && !isAndroidChrome && !isIOSNonSafari) return;

  // ── Dismiss state (independent keys per banner type) ──────────────
  var INSTALL_PERM_KEY  = 'buhlos_install_never';
  var INSTALL_TEMP_KEY  = 'buhlos_install_dismissed';
  var SAFARI_PERM_KEY   = 'buhlos_safari_hint_never';
  var SAFARI_TEMP_KEY   = 'buhlos_safari_hint_dismissed';
  var SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

  function isSnoozed(permKey, tempKey){
    if (localStorage.getItem(permKey) === '1') return true;
    var t = parseInt(localStorage.getItem(tempKey) || '0', 10);
    if (t && (Date.now() - t) < SEVEN_DAYS) return true;
    return false;
  }

  // ── Style injection (self-contained — no theme.css dependency) ────
  var STYLE_ID = 'pwa-install-styles';
  function injectStyles(){
    if (document.getElementById(STYLE_ID)) return;
    var css = ''
      // Shared backdrop / sheet shell
      + '.pwa-banner{position:fixed;left:0;right:0;bottom:0;z-index:600;'
      +   'background:rgba(15,23,42,.55);'
      +   'display:flex;align-items:flex-end;justify-content:center;'
      +   'animation:pwaFadeIn .25s ease;'
      +   'padding:0 0 env(safe-area-inset-bottom);}'
      + '.pwa-banner.closing{animation:pwaFadeOut .22s ease forwards}'
      + '.pwa-banner-inner{'
      +   'width:100%;max-width:560px;background:#fff;color:#0f172a;'
      +   'border-radius:18px 18px 0 0;'
      +   'padding:18px 20px max(20px, env(safe-area-inset-bottom)) 20px;'
      +   'box-shadow:0 -8px 28px rgba(0,0,0,.25);'
      +   'animation:pwaSlideUp .3s cubic-bezier(.2,.8,.2,1);'
      +   'font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}'
      + '.pwa-banner.closing .pwa-banner-inner{animation:pwaSlideDown .22s ease forwards}'
      + '@media(min-width:520px){.pwa-banner{padding:0 16px env(safe-area-inset-bottom)}'
      +   '.pwa-banner-inner{margin-bottom:16px;border-radius:18px}}'
      // Install-banner specifics
      + '.pwa-banner-hdr{display:flex;align-items:center;gap:12px;margin-bottom:14px}'
      + '.pwa-banner-icon{width:44px;height:44px;border-radius:10px;flex-shrink:0;'
      +   'background:#0d1f35;padding:4px;border:1px solid #e2e8f0;display:block}'
      + '.pwa-banner-title{font-size:16px;font-weight:800;color:#0d1f35;letter-spacing:-.2px;line-height:1.2}'
      + '.pwa-banner-sub{font-size:12px;color:#64748b;margin-top:2px;line-height:1.35}'
      + '.pwa-steps{display:flex;flex-direction:column;gap:10px;margin-bottom:14px;'
      +   'padding:12px 14px;background:#f8fafc;border-radius:10px;border:1px solid #e2e8f0}'
      + '.pwa-step{display:flex;align-items:flex-start;gap:10px;font-size:13px;color:#0f172a;line-height:1.45}'
      + '.pwa-step-num{flex-shrink:0;width:22px;height:22px;border-radius:50%;'
      +   'background:#ffcc00;color:#0f172a;font-size:12px;font-weight:800;'
      +   'display:inline-flex;align-items:center;justify-content:center;line-height:1}'
      + '.pwa-step b{font-weight:700;color:#0d1f35}'
      + '.pwa-share-icon{vertical-align:-3px;color:#007aff;margin:0 2px}'
      + '.pwa-hint{display:flex;align-items:center;gap:6px;justify-content:center;'
      +   'font-size:11px;color:#64748b;font-weight:600;margin-bottom:14px;'
      +   'padding:6px 10px;border-top:1px dashed #e2e8f0}'
      + '.pwa-hint svg{color:#94a3b8;animation:pwaBounce 1.4s ease-in-out infinite}'
      + '.pwa-banner-actions{display:flex;flex-direction:column;gap:8px}'
      + '.pwa-btn{appearance:none;border:none;border-radius:10px;cursor:pointer;'
      +   'font:600 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
      +   'min-height:46px;padding:0 18px;text-align:center;transition:opacity .15s, filter .15s}'
      + '.pwa-btn:active{opacity:.85}'
      + '.pwa-btn-install{background:#ffcc00;color:#0f172a;font-weight:800;letter-spacing:-.1px;'
      +   'box-shadow:0 2px 8px rgba(255,204,0,.35)}'
      + '.pwa-btn-install:hover{filter:brightness(.96)}'
      + '.pwa-btn-later{background:#f1f5f9;color:#0d1f35;border:1px solid #e2e8f0}'
      + '.pwa-btn-later:hover{background:#e2e8f0}'
      + '.pwa-btn-link{appearance:none;border:none;background:none;cursor:pointer;'
      +   'font:600 12px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
      +   'color:#94a3b8;padding:8px;text-align:center;text-decoration:underline}'
      + '.pwa-btn-link:hover{color:#475569}'
      + '.pwa-help-link{display:block;text-align:center;font-size:11px;'
      +   'color:#94a3b8;text-decoration:underline;margin-top:6px}'
      // Safari-hint specifics (iOS Chrome/Firefox/Edge users)
      + '.pwa-safari-note{padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;'
      +   'border-radius:10px;font-size:12px;color:#854d0e;line-height:1.45;'
      +   'margin-bottom:12px}'
      + '.pwa-safari-note b{color:#713f12;font-weight:700}'
      // Animations
      + '@keyframes pwaFadeIn{from{opacity:0}to{opacity:1}}'
      + '@keyframes pwaFadeOut{to{opacity:0}}'
      + '@keyframes pwaSlideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}'
      + '@keyframes pwaSlideDown{to{transform:translateY(100%)}}'
      + '@keyframes pwaBounce{0%,100%{transform:translateY(0)}50%{transform:translateY(3px)}}';
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── Android: capture beforeinstallprompt early ────────────────────
  var deferredPrompt = null;
  if (isAndroidChrome) {
    window.addEventListener('beforeinstallprompt', function(e){
      e.preventDefault();
      deferredPrompt = e;
      var btn = document.getElementById('pwa-install-native');
      if (btn) btn.style.display = '';
    });
  }

  // ── Banner shells: install-banner + safari-hint share the same DOM root ──
  function closeBanner(){
    var b = document.getElementById('pwa-banner');
    if (!b) return;
    b.classList.add('closing');
    setTimeout(function(){ if (b.parentNode) b.parentNode.removeChild(b); }, 250);
  }

  // ── Install banner (iOS Safari / Android Chrome) ──────────────────
  function showInstallBanner(){
    if (document.getElementById('pwa-banner')) return;
    if (isSnoozed(INSTALL_PERM_KEY, INSTALL_TEMP_KEY)) return;
    injectStyles();

    var platformHTML = '';
    if (isIOSSafari) {
      platformHTML = ''
        + '<div class="pwa-steps">'
        + '  <div class="pwa-step">'
        + '    <span class="pwa-step-num">1</span>'
        + '    <span>Tap the <b>Share</b> button '
        + '      <svg class="pwa-share-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>'
        + '      in the toolbar below</span>'
        + '  </div>'
        + '  <div class="pwa-step">'
        + '    <span class="pwa-step-num">2</span>'
        + '    <span>Scroll down and tap <b>"Add to Home Screen"</b></span>'
        + '  </div>'
        + '</div>'
        + '<div class="pwa-hint">'
        + '  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 13 12 18 17 13"/><polyline points="7 6 12 11 17 6"/></svg>'
        + '  Look for the share button here'
        + '</div>';
    } else {
      // Android Chrome
      platformHTML = ''
        + '<div class="pwa-steps">'
        + '  <div class="pwa-step">'
        + '    <span class="pwa-step-num">1</span>'
        + '    <span>Tap the <b>menu</b> &#x22EE; in the top-right corner</span>'
        + '  </div>'
        + '  <div class="pwa-step">'
        + '    <span class="pwa-step-num">2</span>'
        + '    <span>Tap <b>"Install app"</b> or <b>"Add to Home screen"</b></span>'
        + '  </div>'
        + '</div>';
    }

    var nativeBtn = '';
    if (isAndroidChrome) {
      nativeBtn = '<button class="pwa-btn pwa-btn-install" id="pwa-install-native"'
        + (deferredPrompt ? '' : ' style="display:none"')
        + '>Install now</button>';
    }

    var html = ''
      + '<div class="pwa-banner" id="pwa-banner" role="dialog" aria-label="Install BuhlOS">'
      + '  <div class="pwa-banner-inner">'
      + '    <div class="pwa-banner-hdr">'
      + '      <img src="/icon-192.png" class="pwa-banner-icon" alt="" width="44" height="44">'
      + '      <div>'
      + '        <div class="pwa-banner-title">Install BuhlOS</div>'
      + '        <div class="pwa-banner-sub">Faster access, fullscreen, no browser bar.</div>'
      + '      </div>'
      + '    </div>'
      +      platformHTML
      + '    <div class="pwa-banner-actions">'
      +        nativeBtn
      + '      <button class="pwa-btn pwa-btn-later" id="pwa-dismiss-temp">Not now</button>'
      + '      <button class="pwa-btn-link" id="pwa-dismiss-perm">Don\'t show again</button>'
      + '    </div>'
      + '    <a class="pwa-help-link" href="/install">Need help installing?</a>'
      + '  </div>'
      + '</div>';

    var wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper.firstChild);

    document.getElementById('pwa-dismiss-temp').addEventListener('click', function(){
      localStorage.setItem(INSTALL_TEMP_KEY, String(Date.now()));
      closeBanner();
    });
    document.getElementById('pwa-dismiss-perm').addEventListener('click', function(){
      localStorage.setItem(INSTALL_PERM_KEY, '1');
      closeBanner();
    });
    var nativeBtnEl = document.getElementById('pwa-install-native');
    if (nativeBtnEl) {
      nativeBtnEl.addEventListener('click', function(){
        if (deferredPrompt) {
          deferredPrompt.prompt();
          deferredPrompt.userChoice.then(function(result){
            if (result.outcome === 'accepted') {
              localStorage.setItem(INSTALL_PERM_KEY, '1');
            }
            deferredPrompt = null;
            closeBanner();
          });
        }
      });
    }
    document.getElementById('pwa-banner').addEventListener('click', function(e){
      if (e.target === this) {
        localStorage.setItem(INSTALL_TEMP_KEY, String(Date.now()));
        closeBanner();
      }
    });
  }

  // ── Safari hint banner (iOS Chrome/Firefox/Edge — can't install PWAs) ──
  function showSafariHint(){
    if (document.getElementById('pwa-banner')) return;
    if (isSnoozed(SAFARI_PERM_KEY, SAFARI_TEMP_KEY)) return;
    injectStyles();

    var html = ''
      + '<div class="pwa-banner" id="pwa-banner" role="dialog" aria-label="Open BuhlOS in Safari to install">'
      + '  <div class="pwa-banner-inner">'
      + '    <div class="pwa-banner-hdr">'
      + '      <img src="/icon-192.png" class="pwa-banner-icon" alt="" width="44" height="44">'
      + '      <div>'
      + '        <div class="pwa-banner-title">Install BuhlOS on your iPhone</div>'
      + '        <div class="pwa-banner-sub">Open this page in Safari to add it to your home screen.</div>'
      + '      </div>'
      + '    </div>'
      + '    <div class="pwa-safari-note">'
      + '      Chrome on iPhone can’t install web apps — that’s an Apple restriction, not ours. <b>Open this page in Safari</b> first.'
      + '    </div>'
      + '    <div class="pwa-steps">'
      + '      <div class="pwa-step">'
      + '        <span class="pwa-step-num">1</span>'
      + '        <span>Tap the <b>…</b> menu (top right of Chrome)</span>'
      + '      </div>'
      + '      <div class="pwa-step">'
      + '        <span class="pwa-step-num">2</span>'
      + '        <span>Tap <b>"Open in Safari"</b></span>'
      + '      </div>'
      + '      <div class="pwa-step">'
      + '        <span class="pwa-step-num">3</span>'
      + '        <span>In Safari, tap <b>Share → Add to Home Screen</b></span>'
      + '      </div>'
      + '    </div>'
      + '    <div class="pwa-banner-actions">'
      + '      <button class="pwa-btn pwa-btn-later" id="pwa-dismiss-temp">Not now</button>'
      + '      <button class="pwa-btn-link" id="pwa-dismiss-perm">Don\'t show again</button>'
      + '    </div>'
      + '    <a class="pwa-help-link" href="/install">Need help installing?</a>'
      + '  </div>'
      + '</div>';

    var wrapper = document.createElement('div');
    wrapper.innerHTML = html;
    document.body.appendChild(wrapper.firstChild);

    document.getElementById('pwa-dismiss-temp').addEventListener('click', function(){
      localStorage.setItem(SAFARI_TEMP_KEY, String(Date.now()));
      closeBanner();
    });
    document.getElementById('pwa-dismiss-perm').addEventListener('click', function(){
      localStorage.setItem(SAFARI_PERM_KEY, '1');
      closeBanner();
    });
    document.getElementById('pwa-banner').addEventListener('click', function(e){
      if (e.target === this) {
        localStorage.setItem(SAFARI_TEMP_KEY, String(Date.now()));
        closeBanner();
      }
    });
  }

  // ── Trigger 3s after page load (mutually exclusive paths) ─────────
  function trigger(){
    setTimeout(function(){
      if (isIOSNonSafari) showSafariHint();
      else showInstallBanner();
    }, 3000);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', trigger);
  } else {
    trigger();
  }
})();
