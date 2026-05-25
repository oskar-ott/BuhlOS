#!/usr/bin/env node
// Smoke the evidence loop's HTTP surfaces (Phase D5).
//
//   node scripts/smoke-evidence-routes.js                # buhlos.com
//   node scripts/smoke-evidence-routes.js <preview-url>  # any preview
//
// Checks each route returns the right status code and content-type
// when called UNAUTHENTICATED. Authenticated end-to-end smoke needs
// a real session cookie and is documented in
// docs/rebuild-audit/phase-d5-runbook.md §field test script.
//
// Exit codes:
//   0 — every check passed
//   1 — at least one check failed (details printed)
//
// This is the post-deploy smoke that every D2/D3/D4/D5 production
// release should run. The companion `npm run smoke:admin-routes`
// script (static checks) runs at build time; this one runs against a
// live deployment.

const DEFAULT_BASE = "https://buhlos.com";
const base = (process.argv[2] || DEFAULT_BASE).replace(/\/$/, "");

const ANSI = process.stdout.isTTY
  ? { red: "\x1b[31m", green: "\x1b[32m", dim: "\x1b[2m", reset: "\x1b[0m" }
  : { red: "", green: "", dim: "", reset: "" };

let failures = 0;
const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
}

async function fetchStatus(url, init) {
  try {
    const res = await fetch(url, {
      redirect: "manual",
      ...init,
    });
    const code = res.status;
    const ct = res.headers.get("content-type") || "";
    return { code, ct, ok: true };
  } catch (e) {
    return { code: 0, ct: "", ok: false, error: e.message || String(e) };
  }
}

async function expectStatus(name, url, opts) {
  const { method = "GET", body, headers, expect } = opts || {};
  const init = { method, redirect: "manual" };
  if (body) init.body = body;
  if (headers) init.headers = headers;
  const r = await fetchStatus(url, init);
  if (!r.ok) {
    record(name, false, r.error || "network error");
    return;
  }
  const okStatus = !expect?.status || expect.status.includes(r.code);
  const okCt =
    !expect?.contentType ||
    r.ct.toLowerCase().includes(expect.contentType.toLowerCase());
  const ok = okStatus && okCt;
  record(name, ok, `${r.code} ${r.ct || "(no content-type)"}`);
}

(async function main() {
  console.log(
    `${ANSI.dim}smoke-evidence-routes · ${base}${ANSI.reset}`
  );

  // HTML routes — every Next.js route should respond 200 (server
  // renders a redirect or full page; both come back as 200 by default
  // unless gated by middleware which 307s).
  await expectStatus("HTML  /v2/login", `${base}/v2/login`, {
    expect: { status: [200], contentType: "text/html" },
  });
  await expectStatus(
    "HTML  /phil/jobs (gated → 307)",
    `${base}/phil/jobs`,
    { expect: { status: [307] } }
  );
  await expectStatus(
    "HTML  /phil/jobs/birdwood-iv3232 (gated → 307)",
    `${base}/phil/jobs/birdwood-iv3232`,
    { expect: { status: [307] } }
  );
  await expectStatus(
    "HTML  /v2/jobs/birdwood-iv3232/evidence (gated → 307)",
    `${base}/v2/jobs/birdwood-iv3232/evidence`,
    { expect: { status: [307] } }
  );
  await expectStatus(
    "HTML  /v2/jobs/birdwood-iv3232/snags (gated → 307)",
    `${base}/v2/jobs/birdwood-iv3232/snags`,
    { expect: { status: [307] } }
  );
  await expectStatus("HTML  /command-centre (gated → 307)", `${base}/command-centre`, {
    expect: { status: [307] },
  });
  await expectStatus("HTML  /hours/approvals (gated → 307)", `${base}/hours/approvals`, {
    expect: { status: [307] },
  });

  // Legacy routes — served by vercel.json rewrite, should 200.
  await expectStatus("HTML  /login (legacy)", `${base}/login`, {
    expect: { status: [200], contentType: "text/html" },
  });
  await expectStatus("HTML  /phil (legacy)", `${base}/phil`, {
    expect: { status: [200], contentType: "text/html" },
  });
  await expectStatus("HTML  /admin/operations (legacy)", `${base}/admin/operations`, {
    expect: { status: [200], contentType: "text/html" },
  });

  // API GET — every endpoint returns 401 JSON without auth.
  for (const path of [
    "/api/auth?action=me",
    "/api/jobs",
    "/api/evidence?jobId=birdwood-iv3232",
    "/api/snags?jobId=birdwood-iv3232",
    "/api/audit-log?targetType=evidence&targetId=ev_smoke&jobId=birdwood-iv3232",
    "/api/audit-log?targetType=snag&targetId=sn_smoke&jobId=birdwood-iv3232",
    "/api/time-entries",
    "/api/assets",
  ]) {
    await expectStatus(`GET   ${path}`, `${base}${path}`, {
      expect: { status: [401], contentType: "application/json" },
    });
  }

  // API POST — same 401 JSON gate.
  await expectStatus(
    "POST  /api/evidence (note)",
    `${base}/api/evidence?jobId=birdwood-iv3232`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "note", note: "x" }),
      expect: { status: [401], contentType: "application/json" },
    }
  );
  await expectStatus(
    "POST  /api/evidence?action=review",
    `${base}/api/evidence?jobId=birdwood-iv3232&action=review`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ evidenceId: "x", status: "reviewed" }),
      expect: { status: [401], contentType: "application/json" },
    }
  );
  await expectStatus(
    "POST  /api/photos?action=upload-evidence-photo",
    `${base}/api/photos?jobId=birdwood-iv3232&action=upload-evidence-photo`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/jpeg;base64,YQ==" }),
      expect: { status: [401], contentType: "application/json" },
    }
  );
  await expectStatus(
    "POST  /api/snags (create)",
    `${base}/api/snags?jobId=birdwood-iv3232`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "smoke" }),
      expect: { status: [401], contentType: "application/json" },
    }
  );
  await expectStatus(
    "POST  /api/snags?action=transition",
    `${base}/api/snags?jobId=birdwood-iv3232&action=transition`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snagId: "x", nextStatus: "in_progress" }),
      expect: { status: [401], contentType: "application/json" },
    }
  );

  // Print summary.
  const pad = (s, n) => (s + " ".repeat(n)).slice(0, n);
  for (const r of results) {
    const mark = r.ok ? `${ANSI.green}PASS${ANSI.reset}` : `${ANSI.red}FAIL${ANSI.reset}`;
    console.log(`${mark}  ${pad(r.name, 60)}  ${ANSI.dim}${r.detail}${ANSI.reset}`);
  }
  const total = results.length;
  const passed = total - failures;
  if (failures === 0) {
    console.log(
      `\n${ANSI.green}OK   ${ANSI.reset}${passed}/${total} smoke checks passed against ${base}.`
    );
    process.exit(0);
  }
  console.log(
    `\n${ANSI.red}FAIL ${ANSI.reset}${failures}/${total} smoke checks failed against ${base}.`
  );
  process.exit(1);
})().catch((e) => {
  console.error(`${ANSI.red}smoke crashed:${ANSI.reset}`, e.stack || e.message || String(e));
  process.exit(2);
});
