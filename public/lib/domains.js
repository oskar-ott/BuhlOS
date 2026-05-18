// BuhlOS — browser-side canonical domain helpers.
//
// Loaded via a plain <script src="/lib/domains.js"></script> and exposes
// a single global, window.BUHLOS_DOMAINS, with the same surface as the
// server-side helpers in /api/_lib/domains.js.
//
// Defaults match the canonical structure:
//
//   buhlos.com          — main BuhlOS dashboard / login / admin
//   phil.buhlos.com     — Phil mobile worker app
//   api.buhlos.com      — API (note: today the API is served same-origin
//                         from /api on whichever host you're on; getApiUrl()
//                         returns '' to keep relative fetches working
//                         unless window.BUHLOS_CONFIG.api is explicitly set)
//   docs.buhlos.com     — optional future docs / help
//
// Runtime overrides:
//   Set window.BUHLOS_CONFIG = { buhlos: '…', phil: '…', api: '…', docs: '…' }
//   BEFORE this script loads to point at non-prod URLs without
//   redeploying.
//
// There is no build step in this repo, so this file deliberately uses
// ES5 patterns (no const/let in module scope, no template literals) so
// it works in any browser the field crew may have on their phone.

(function (global) {
  'use strict';

  var DEFAULTS = {
    buhlos: 'https://buhlos.com',
    phil:   'https://phil.buhlos.com',
    api:    'https://api.buhlos.com',
    docs:   'https://docs.buhlos.com'
  };

  function clean(url) {
    if (!url || typeof url !== 'string') return null;
    var t = url.trim().replace(/\/+$/, '');
    return t || null;
  }

  function override(key) {
    var cfg = (global && global.BUHLOS_CONFIG) || {};
    return clean(cfg[key]);
  }

  function stripPort(hostname) {
    if (!hostname) return '';
    var i = hostname.indexOf(':');
    return i === -1 ? hostname : hostname.slice(0, i);
  }

  function currentHostname() {
    try {
      return (global.location && global.location.hostname) || '';
    } catch (e) { return ''; }
  }

  function isPhilHost(hostname) {
    var h = stripPort(hostname || '').toLowerCase();
    return !!h && /^phil\./.test(h);
  }
  function isApiHost(hostname) {
    var h = stripPort(hostname || '').toLowerCase();
    return !!h && /^api\./.test(h);
  }
  function isLocalHost(hostname) {
    var h = stripPort(hostname || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || /\.local$/.test(h);
  }
  function isBuhlOSHost(hostname) {
    var h = stripPort(hostname || '').toLowerCase();
    if (!h) return false;
    if (isPhilHost(h) || isApiHost(h)) return false;
    if (isLocalHost(h)) return true;
    return /(^|\.)buhlos\.com$/.test(h);
  }

  function getBuhlOSUrl() {
    return override('buhlos') || DEFAULTS.buhlos;
  }
  function getPhilUrl() {
    return override('phil') || DEFAULTS.phil;
  }
  function getDocsUrl() {
    return override('docs') || DEFAULTS.docs;
  }
  // Same-origin by default. Set window.BUHLOS_CONFIG.api when the API
  // is split out to its own subdomain — the rest of the app calls
  // buildApiUrl('/api/...') and gets the right base back.
  function getApiUrl() {
    return override('api') || '';
  }

  function joinPath(base, path) {
    if (!path) return base;
    var sep = String(path).charAt(0) === '/' ? '' : '/';
    return base + sep + path;
  }

  function buildBuhlOSUrl(path) { return joinPath(getBuhlOSUrl(), path); }
  function buildPhilUrl(path)   { return joinPath(getPhilUrl(),   path); }
  function buildDocsUrl(path)   { return joinPath(getDocsUrl(),   path); }
  function buildApiUrl(path) {
    var base = getApiUrl();
    if (!base) return path; // same-origin — keep paths relative
    return joinPath(base, path);
  }

  // Returns the canonical URL the install instructions should point at,
  // based on the current host. Field crew installing Phil on their phone
  // see "phil.buhlos.com"; everyone else sees "buhlos.com". Localhost
  // stays on whatever origin the dev is using so the screenshots still
  // make sense.
  function currentInstallUrl() {
    var host = currentHostname();
    if (isLocalHost(host)) {
      try { return (global.location && global.location.origin) || getBuhlOSUrl(); }
      catch (e) { return getBuhlOSUrl(); }
    }
    if (isPhilHost(host)) return getPhilUrl();
    return getBuhlOSUrl();
  }
  function currentInstallHost() {
    var url = currentInstallUrl();
    try { return new URL(url).host; } catch (e) {
      return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    }
  }

  global.BUHLOS_DOMAINS = {
    DEFAULTS: DEFAULTS,
    getBuhlOSUrl: getBuhlOSUrl,
    getPhilUrl: getPhilUrl,
    getApiUrl: getApiUrl,
    getDocsUrl: getDocsUrl,
    buildBuhlOSUrl: buildBuhlOSUrl,
    buildPhilUrl: buildPhilUrl,
    buildApiUrl: buildApiUrl,
    buildDocsUrl: buildDocsUrl,
    isPhilHost: isPhilHost,
    isApiHost: isApiHost,
    isLocalHost: isLocalHost,
    isBuhlOSHost: isBuhlOSHost,
    currentHostname: currentHostname,
    currentInstallUrl: currentInstallUrl,
    currentInstallHost: currentInstallHost
  };
})(typeof window !== 'undefined' ? window : this);
