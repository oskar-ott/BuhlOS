import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Drift guard for the local CI-parity gate (`npm run check:full-ci`).
 *
 * The runner (`scripts/check-full-ci.js`) hardcodes the ordered list of npm
 * scripts the CI "check" job runs. If CI gains a new guard but the runner
 * isn't updated, "green locally" stops meaning "green in CI" — the exact
 * failure mode this command was built to kill. This test re-reads
 * `.github/workflows/ci.yml`, extracts every `npm run <script>` the check job
 * invokes, and asserts the runner covers all of them.
 *
 * Invariant: CI check-job scripts ⊆ runner STEPS. The runner may list extra
 * steps (a superset is safe — it only means running more locally), but it must
 * never miss one CI runs.
 */
const requireFromHere = createRequire(import.meta.url);
const REPO_ROOT = resolve(__dirname, "../../..");

const { STEPS } = requireFromHere(
  resolve(REPO_ROOT, "scripts/check-full-ci.js"),
) as { STEPS: string[] };

/** Every `npm run <script>` invoked anywhere in ci.yml's check job. */
function ciCheckJobScripts(): string[] {
  const yml = readFileSync(resolve(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  const found = new Set<string>();
  // `npm run <script>` — script names are [a-z0-9:-]. Covers both the named
  // steps (`run: npm run typecheck`) and the multi-line guards block.
  const re = /npm run ([a-z0-9:_-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(yml)) !== null) {
    if (m[1]) found.add(m[1]);
  }
  return [...found];
}

describe("check:full-ci mirrors the CI check job", () => {
  it("the runner exists and exports an ordered STEPS array", () => {
    expect(Array.isArray(STEPS)).toBe(true);
    expect(STEPS.length).toBeGreaterThan(0);
    // No duplicates — each guard runs once.
    expect(new Set(STEPS).size).toBe(STEPS.length);
  });

  it("covers every npm script the CI check job runs (CI ⊆ runner)", () => {
    const ciScripts = ciCheckJobScripts();
    expect(ciScripts.length).toBeGreaterThan(5); // sanity: we actually parsed the workflow
    const stepSet = new Set(STEPS);
    const missing = ciScripts.filter((s) => !stepSet.has(s));
    expect(
      missing,
      `check:full-ci is missing CI guards: ${missing.join(", ")}. ` +
        `Add them to STEPS in scripts/check-full-ci.js.`,
    ).toEqual([]);
  });

  it("is registered as the check:full-ci npm alias", () => {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["check:full-ci"]).toBe("node scripts/check-full-ci.js");
    // check:full (heavier — adds browser e2e) stays distinct and untouched.
    expect(pkg.scripts["check"]).toBeDefined();
  });
});
