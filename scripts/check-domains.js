#!/usr/bin/env node
// Smoke-test the central domain config + CORS + cookie helpers.
//
// Run with:
//   node scripts/check-domains.js
//
// Exits non-zero on any assertion failure so it can be wired into a
// pre-deploy check or CI step.

'use strict';

let failed = 0;
let total = 0;
function check(label, ok, detail) {
  total++;
  if (ok) {
    console.log('  PASS  ' + label);
  } else {
    failed++;
    console.log('  FAIL  ' + label + (detail ? '  → ' + detail : ''));
  }
}

function reload(modPath) {
  delete require.cache[require.resolve(modPath)];
  return require(modPath);
}

// ── domains.js defaults ──────────────────────────────────────────────
console.log('\n[domains] defaults');
{
  for (const k of [
    'NEXT_PUBLIC_BUHLOS_URL', 'BUHLOS_URL',
    'NEXT_PUBLIC_PHIL_URL',   'PHIL_URL',
    'NEXT_PUBLIC_API_URL',    'API_URL',
    'NEXT_PUBLIC_DOCS_URL',   'DOCS_URL',
    'ALLOWED_ORIGINS', 'BUHLOS_COOKIE_DOMAIN',
    'ADMIN_ALERT_EMAIL', 'NOREPLY_EMAIL', 'VERCEL_URL',
  ]) delete process.env[k];

  const d = reload('../api/_lib/domains.js');
  check('getBuhlOSUrl() default',     d.getBuhlOSUrl() === 'https://buhlos.com',     d.getBuhlOSUrl());
  check('getPhilUrl() default',       d.getPhilUrl()   === 'https://phil.buhlos.com', d.getPhilUrl());
  check('getApiUrl() default',        d.getApiUrl()    === 'https://api.buhlos.com',  d.getApiUrl());
  check('getDocsUrl() default',       d.getDocsUrl()   === 'https://docs.buhlos.com', d.getDocsUrl());
  check('getSupportUrl()',            d.getSupportUrl()    === 'https://buhlos.com/admin/support', d.getSupportUrl());
  check('getAdminAlertEmail()',       d.getAdminAlertEmail() === 'office@buhlos.com');
  check('getNoReplyAddress()',        d.getNoReplyAddress()  === 'noreply@buhlos.com');
  check('buildBuhlOSUrl(/a/b)',       d.buildBuhlOSUrl('/a/b') === 'https://buhlos.com/a/b');
  check('buildPhilUrl(a/b)',          d.buildPhilUrl('a/b')    === 'https://phil.buhlos.com/a/b');
  check('buildApiUrl(/api/x)',        d.buildApiUrl('/api/x')  === 'https://api.buhlos.com/api/x');
  check('getCookieDomain() default',  d.getCookieDomain() === undefined);
}

// ── hostname classification ──────────────────────────────────────────
console.log('\n[domains] host classifiers');
{
  const d = reload('../api/_lib/domains.js');
  const cases = [
    ['phil.buhlos.com',           { phil:true,  api:false, buhlos:false }],
    ['phil.preview-x.vercel.app', { phil:true,  api:false, buhlos:false }],
    ['api.buhlos.com',            { phil:false, api:true,  buhlos:false }],
    ['buhlos.com',                { phil:false, api:false, buhlos:true  }],
    ['www.buhlos.com',            { phil:false, api:false, buhlos:true  }],
    ['localhost',                 { phil:false, api:false, buhlos:true  }],
    ['localhost:3000',            { phil:false, api:false, buhlos:true  }],
    ['127.0.0.1',                 { phil:false, api:false, buhlos:true  }],
    ['evil.example',              { phil:false, api:false, buhlos:false }],
    ['',                          { phil:false, api:false, buhlos:false }],
  ];
  for (const [host, want] of cases) {
    const got = { phil: d.isPhilHost(host), api: d.isApiHost(host), buhlos: d.isBuhlOSHost(host) };
    check(`classify ${host || '(empty)'}`,
      JSON.stringify(got) === JSON.stringify(want),
      JSON.stringify(got));
  }
}

// ── CORS allow-list ──────────────────────────────────────────────────
console.log('\n[domains] CORS allow-list');
{
  process.env.ALLOWED_ORIGINS = 'https://preview-abc.vercel.app';
  const d = reload('../api/_lib/domains.js');
  check('allow buhlos.com',     d.resolveAllowedOrigin('https://buhlos.com')       === 'https://buhlos.com');
  check('allow phil.buhlos.com',d.resolveAllowedOrigin('https://phil.buhlos.com')  === 'https://phil.buhlos.com');
  check('allow api.buhlos.com', d.resolveAllowedOrigin('https://api.buhlos.com')   === 'https://api.buhlos.com');
  check('allow localhost:3000', d.resolveAllowedOrigin('http://localhost:3000')    === 'http://localhost:3000');
  check('allow preview override', d.resolveAllowedOrigin('https://preview-abc.vercel.app') === 'https://preview-abc.vercel.app');
  check('reject evil.example',  d.resolveAllowedOrigin('https://evil.example')     === null);
  check('reject empty origin',  d.resolveAllowedOrigin('')                         === null);
  check('reject http://buhlos.com (scheme matters)', d.resolveAllowedOrigin('http://buhlos.com') === null);
  delete process.env.ALLOWED_ORIGINS;
}

// ── env-var overrides ────────────────────────────────────────────────
console.log('\n[domains] env-var overrides');
{
  process.env.NEXT_PUBLIC_BUHLOS_URL = 'https://staging.buhlos.com/';
  process.env.NEXT_PUBLIC_PHIL_URL   = 'https://phil-staging.buhlos.com';
  process.env.NEXT_PUBLIC_DOCS_URL   = 'https://docs-staging.buhlos.com';
  process.env.BUHLOS_COOKIE_DOMAIN   = '.buhlos.com';
  process.env.ADMIN_ALERT_EMAIL      = 'alerts@example.com';
  process.env.NOREPLY_EMAIL          = 'no-reply@example.com';
  const d = reload('../api/_lib/domains.js');
  check('NEXT_PUBLIC_BUHLOS_URL strips trailing slash', d.getBuhlOSUrl() === 'https://staging.buhlos.com');
  check('NEXT_PUBLIC_PHIL_URL respected',               d.getPhilUrl()   === 'https://phil-staging.buhlos.com');
  check('NEXT_PUBLIC_DOCS_URL respected',               d.getDocsUrl()   === 'https://docs-staging.buhlos.com');
  check('BUHLOS_COOKIE_DOMAIN respected',               d.getCookieDomain() === '.buhlos.com');
  check('ADMIN_ALERT_EMAIL respected',                  d.getAdminAlertEmail() === 'alerts@example.com');
  check('NOREPLY_EMAIL respected',                      d.getNoReplyAddress()  === 'no-reply@example.com');
  delete process.env.NEXT_PUBLIC_BUHLOS_URL;
  delete process.env.NEXT_PUBLIC_PHIL_URL;
  delete process.env.NEXT_PUBLIC_DOCS_URL;
  delete process.env.BUHLOS_COOKIE_DOMAIN;
  delete process.env.ADMIN_ALERT_EMAIL;
  delete process.env.NOREPLY_EMAIL;
}

// ── CORS via setNoCache ──────────────────────────────────────────────
console.log('\n[blob] setNoCache CORS');
{
  const { setNoCache } = reload('../api/_lib/blob.js');
  const mk = () => { const h = {}; return { headers:h, setHeader:(k,v)=>{h[k]=v;} }; };

  let r = mk(); setNoCache(r, { headers:{ origin:'https://phil.buhlos.com' }});
  check('echoes phil origin',  r.headers['Access-Control-Allow-Origin'] === 'https://phil.buhlos.com');
  check('credentials enabled', r.headers['Access-Control-Allow-Credentials'] === 'true');
  check('Vary: Origin set',    r.headers['Vary'] === 'Origin');

  r = mk(); setNoCache(r, { headers:{ origin:'https://evil.example' }});
  check('rejects evil origin', r.headers['Access-Control-Allow-Origin'] === undefined && r.headers['Access-Control-Allow-Credentials'] === undefined);

  r = mk(); setNoCache(r);
  check('legacy single-arg call: no Allow-Origin header', r.headers['Access-Control-Allow-Origin'] === undefined);
  check('legacy single-arg call: cache headers still set', r.headers['Cache-Control'] && r.headers['Vercel-CDN-Cache-Control']);

  r = mk(); setNoCache(r, { headers:{ origin:'http://localhost:5173' }});
  check('allows localhost:5173', r.headers['Access-Control-Allow-Origin'] === 'http://localhost:5173');
}

// ── auth.js cookie helper ────────────────────────────────────────────
console.log('\n[auth] session cookie');
{
  process.env.SESSION_SECRET = 'a'.repeat(32);
  delete process.env.BUHLOS_COOKIE_DOMAIN;
  let auth = reload('../api/_lib/auth.js');
  const mk = () => { const h = {}; return { headers:h, setHeader:(k,v)=>{h[k]=v;} }; };

  let r = mk(); auth.setSessionCookie(r, { userId:'u1', role:'admin' });
  let c = r.headers['Set-Cookie'];
  check('host-only by default: no Domain=',  !/Domain=/i.test(c));
  check('host-only: HttpOnly',                /HttpOnly/.test(c));
  check('host-only: Secure',                  /Secure/.test(c));
  check('host-only: SameSite=Lax',            /SameSite=Lax/.test(c));
  check('host-only: Path=/',                  /Path=\//.test(c));
  check('host-only: Max-Age set',             /Max-Age=\d+/.test(c));

  r = mk(); auth.clearSessionCookie(r);
  c = r.headers['Set-Cookie'];
  check('clear (no domain): no Domain=',     !/Domain=/i.test(c));
  check('clear: Max-Age=0',                   /Max-Age=0/.test(c));

  process.env.BUHLOS_COOKIE_DOMAIN = '.buhlos.com';
  // bust both auth.js and domains.js so the new env propagates
  delete require.cache[require.resolve('../api/_lib/domains.js')];
  auth = reload('../api/_lib/auth.js');
  r = mk(); auth.setSessionCookie(r, { userId:'u1', role:'admin' });
  c = r.headers['Set-Cookie'];
  check('shared-domain set: Domain=.buhlos.com', /Domain=\.buhlos\.com/.test(c));
  r = mk(); auth.clearSessionCookie(r);
  c = r.headers['Set-Cookie'];
  check('shared-domain clear: Domain=.buhlos.com', /Domain=\.buhlos\.com/.test(c));
  check('shared-domain clear: Max-Age=0',         /Max-Age=0/.test(c));
  delete process.env.BUHLOS_COOKIE_DOMAIN;
  delete process.env.SESSION_SECRET;
}

// ── browser-side helpers in a VM sandbox ─────────────────────────────
console.log('\n[browser] public/lib/domains.js');
{
  const fs = require('fs');
  const vm = require('vm');
  const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'lib', 'domains.js'), 'utf8');

  function load(hostname, configOverride) {
    const sandbox = {
      window: {
        location: { hostname, origin: 'https://' + hostname },
        BUHLOS_CONFIG: configOverride,
      },
    };
    sandbox.global = sandbox.window;
    vm.runInNewContext(src, sandbox);
    return sandbox.window.BUHLOS_DOMAINS;
  }

  let D = load('phil.buhlos.com');
  check('browser: getBuhlOSUrl()',          D.getBuhlOSUrl() === 'https://buhlos.com');
  check('browser: getPhilUrl()',            D.getPhilUrl() === 'https://phil.buhlos.com');
  check('browser: getApiUrl() same-origin', D.getApiUrl() === '');
  check('browser: buildApiUrl(/api/x) same-origin', D.buildApiUrl('/api/x') === '/api/x');
  check('browser: isPhilHost on phil host', D.isPhilHost('phil.buhlos.com') === true);
  check('browser: !isBuhlOSHost on phil',   D.isBuhlOSHost('phil.buhlos.com') === false);
  check('browser: currentInstallHost on phil', D.currentInstallHost() === 'phil.buhlos.com');

  D = load('buhlos.com');
  check('browser: isBuhlOSHost on buhlos.com',     D.isBuhlOSHost('buhlos.com') === true);
  check('browser: currentInstallHost on buhlos',   D.currentInstallHost() === 'buhlos.com');

  D = load('localhost');
  check('browser: isBuhlOSHost on localhost',      D.isBuhlOSHost('localhost') === true);

  D = load('phil.buhlos.com', { api: 'https://api-staging.buhlos.com' });
  check('browser: runtime API override',           D.getApiUrl() === 'https://api-staging.buhlos.com');
  check('browser: buildApiUrl with override',      D.buildApiUrl('/api/x') === 'https://api-staging.buhlos.com/api/x');
}

// ── repo-level sanity ────────────────────────────────────────────────
console.log('\n[repo] no stale literals');
{
  const { execSync } = require('child_process');
  function grep(pattern, dir) {
    try {
      return execSync(
        `grep -rln ${JSON.stringify(pattern)} --include='*.js' --include='*.html' --include='*.json' --include='*.md' --include='*.css' ${dir} 2>/dev/null | grep -v node_modules | grep -v 'scripts/check-domains.js' || true`,
        { encoding: 'utf8' }
      ).trim();
    } catch (e) { return ''; }
  }
  const buhlapp = grep('buhlapp', '.');
  check('no buhlapp.xyz references anywhere',  buhlapp === '', buhlapp);
  const appBuhl = grep('app\\.buhlos', '.');
  check('no app.buhlos references anywhere',   appBuhl === '', appBuhl);
}

// ── done ─────────────────────────────────────────────────────────────
console.log('\n' + (failed ? `✗ ${failed}/${total} failed` : `✓ ${total}/${total} passed`));
process.exit(failed ? 1 : 0);
