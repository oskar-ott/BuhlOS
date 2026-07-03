import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * RLS-03 (#152) — the Supabase read-cutover flags stay dark + protected.
 *
 * A `supabase_read_*` flag serves PG-backed reads over data that may be
 * un-backfilled or RLS-denied; enabling one prematurely serves wrong/empty
 * reads. Two invariants keep that safe, both machine-checked by
 * scripts/check-read-flags-protected.js (wired into CI):
 *   1. default DARK (false) — never a killSwitch (which would default it ON);
 *   2. isProtectedFlag(key) === true — the owner UI renders it read-only and
 *      the owner write route rejects toggling it.
 * This test pins those invariants against the real registry AND runs the guard
 * to prove it exits 0 on the current (green) tree.
 */
const requireFromHere = createRequire(import.meta.url);
const REPO_ROOT = resolve(__dirname, "../../..");
const flags = requireFromHere(
  resolve(REPO_ROOT, "api/_lib/feature-flags.js"),
) as {
  listFlags: () => Array<{
    key: string;
    default: boolean;
    killSwitch?: boolean;
  }>;
  isProtectedFlag: (key: string) => boolean;
};

const READ_PREFIX = "supabase_read_";
const readFlags = flags.listFlags().filter((f) => f.key.startsWith(READ_PREFIX));

describe("supabase_read_* flags are dark + protected (RLS-03)", () => {
  it("there are read-cutover flags to guard (the prefix still matches)", () => {
    expect(readFlags.length).toBeGreaterThan(0);
  });

  it("every read-cutover flag defaults DARK and is not a kill-switch", () => {
    for (const f of readFlags) {
      expect(f.default, `${f.key} must default false`).toBe(false);
      expect(f.killSwitch, `${f.key} must not be a killSwitch`).toBeFalsy();
    }
  });

  it("every read-cutover flag is protected (owner UI can't toggle it)", () => {
    for (const f of readFlags) {
      expect(flags.isProtectedFlag(f.key), `${f.key} must be protected`).toBe(true);
    }
  });

  it("the guard script passes on the current tree (exit 0)", () => {
    const res = spawnSync(
      process.execPath,
      [resolve(REPO_ROOT, "scripts/check-read-flags-protected.js")],
      { encoding: "utf8" },
    );
    expect(res.status, res.stderr || res.stdout).toBe(0);
    expect(res.stdout).toMatch(/dark by default and protected/);
  });

  it("is wired into the CI check job and the local CI-parity runner", () => {
    const yml = readFileSync(
      resolve(REPO_ROOT, ".github/workflows/ci.yml"),
      "utf8",
    );
    expect(yml).toMatch(/npm run check:read-flags-protected/);
    const { STEPS } = requireFromHere(
      resolve(REPO_ROOT, "scripts/check-full-ci.js"),
    ) as { STEPS: string[] };
    expect(STEPS).toContain("check:read-flags-protected");
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:read-flags-protected"]).toBe(
      "node scripts/check-read-flags-protected.js",
    );
  });
});
