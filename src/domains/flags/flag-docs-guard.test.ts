import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Unit tests for the `check:flag-docs` CI guard (scripts/check-flag-docs.js):
 * the flag REGISTRY, the `FlagKey` union in feature-flags.d.ts and the flag
 * table in docs/feature-flags.md must agree. The guard's parsers and its
 * comparison are exercised on fixtures here (true positives for every problem
 * code, and the false positives it must not raise), and once against the real
 * tree so `npm run test:unit` catches drift as well as the CI guard does.
 */
const requireFromHere = createRequire(import.meta.url);
const REPO_ROOT = resolve(__dirname, "../../..");

type Problem = { code: string; key: string; detail: string };
type Row = { key: string; kind: string; target: string; expires: string; line: number };
type Def = { default: boolean; target: string; expires: string; killSwitch?: boolean };

const guard = requireFromHere(resolve(REPO_ROOT, "scripts/check-flag-docs.js")) as {
  parseFlagKeyUnion: (dts: string) => string[];
  parseDocRows: (md: string) => Row[];
  compare: (input: { registry: Record<string, Def>; unionKeys: string[]; rows: Row[] }) => Problem[];
  PATHS: { registry: string; dts: string; doc: string };
};

const REGISTRY: Record<string, Def> = {
  alpha: { default: false, target: "global", expires: "2026-12-31" },
  core_thing: { default: true, killSwitch: true, target: "global", expires: "2027-06-30" },
  office_only: { default: false, target: "admin-tier", expires: "2026-11-30" },
};

const UNION = `
// Type declarations — "quoted words" in comments must not count.
export type FlagKey =
  // data-plane levers
  | "alpha" // needs "something" configured
  | "core_thing" // core; a semicolon in a comment must not end the union
  | "office_only";

export interface FlagDefinition { default: boolean; }
export declare const REGISTRY: Record<FlagKey, "unused">;
`;

const DOC = `# Feature flags

## The registry

| Flag | Kind | Target | Expires | What it gates |
|---|---|---|---|---|
| \`alpha\` | launch-gate | global | 2026-12-31 | The alpha thing |
| \`core_thing\` | kill-switch | global | 2027-06-30 | Core; default ON |
| \`office_only\` | launch-gate | admin-tier | 2026-11-30 | Office thing, path \`a/b|c\` with a pipe |

## Flipping a flag

| \`not_a_flag\` | launch-gate | global | 2026-01-01 | a table in another section is ignored |
`;

function codes(problems: Problem[]): string[] {
  return problems.map((p) => `${p.code}:${p.key}`).sort();
}

function rowsWithout(key: string): Row[] {
  return guard.parseDocRows(DOC).filter((r) => r.key !== key);
}

describe("check:flag-docs — parsers", () => {
  it("reads the FlagKey union in order and ignores quoted words in comments", () => {
    expect(guard.parseFlagKeyUnion(UNION)).toEqual(["alpha", "core_thing", "office_only"]);
  });

  it("throws when the union is absent, rather than passing vacuously", () => {
    expect(() => guard.parseFlagKeyUnion("export interface Nope {}")).toThrow(/FlagKey/);
  });

  it("reads only the flag table inside '## The registry' and only the first three cells", () => {
    const rows = guard.parseDocRows(DOC);
    expect(rows.map((r) => r.key)).toEqual(["alpha", "core_thing", "office_only"]);
    const office = rows[2];
    expect(office).toBeDefined();
    expect(office?.kind).toBe("launch-gate");
    expect(office?.target).toBe("admin-tier");
    expect(office?.expires).toBe("2026-11-30");
    expect(office?.line).toBe(9);
  });
});

describe("check:flag-docs — comparison", () => {
  const unionKeys = guard.parseFlagKeyUnion(UNION);
  const rows = guard.parseDocRows(DOC);

  it("reports nothing when registry, union and doc agree", () => {
    expect(guard.compare({ registry: REGISTRY, unionKeys, rows })).toEqual([]);
  });

  it("a registry flag with no doc row → doc_missing", () => {
    expect(codes(guard.compare({ registry: REGISTRY, unionKeys, rows: rowsWithout("office_only") }))).toEqual([
      "doc_missing:office_only",
    ]);
  });

  it("a doc row for a flag that no longer exists → doc_obsolete", () => {
    const stale: Row = { key: "gone_feature", kind: "launch-gate", target: "global", expires: "2026-01-01", line: 99 };
    expect(codes(guard.compare({ registry: REGISTRY, unionKeys, rows: [...rows, stale] }))).toEqual([
      "doc_obsolete:gone_feature",
    ]);
  });

  it("kind, target and expires cells that disagree with the registry → mismatches", () => {
    const edited = rows.map((r) =>
      r.key === "core_thing"
        ? { ...r, kind: "launch-gate", target: "admin-tier", expires: "2026-12-31" }
        : r,
    );
    expect(codes(guard.compare({ registry: REGISTRY, unionKeys, rows: edited }))).toEqual([
      "doc_expires_mismatch:core_thing",
      "doc_kind_mismatch:core_thing",
      "doc_target_mismatch:core_thing",
    ]);
  });

  it("the same flag documented twice → doc_duplicate_row", () => {
    const first = rows[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(codes(guard.compare({ registry: REGISTRY, unionKeys, rows: [...rows, { ...first, line: 50 }] }))).toEqual([
      "doc_duplicate_row:alpha",
    ]);
  });

  it("registry ≠ FlagKey union in either direction → union_missing / union_extra", () => {
    expect(codes(guard.compare({ registry: REGISTRY, unionKeys: ["alpha", "core_thing"], rows }))).toEqual([
      "union_missing:office_only",
    ]);
    expect(codes(guard.compare({ registry: REGISTRY, unionKeys: [...unionKeys, "phantom"], rows }))).toEqual([
      "union_extra:phantom",
    ]);
  });

  it("equal amounts of disagreement are all reported, not just the first", () => {
    const problems = guard.compare({
      registry: REGISTRY,
      unionKeys: ["alpha", "phantom"],
      rows: rowsWithout("alpha"),
    });
    expect(codes(problems)).toEqual([
      "doc_missing:alpha",
      "union_extra:phantom",
      "union_missing:core_thing",
      "union_missing:office_only",
    ]);
  });
});

describe("check:flag-docs — the real tree", () => {
  it("registry, feature-flags.d.ts and docs/feature-flags.md agree today", () => {
    const { REGISTRY: real } = requireFromHere(guard.PATHS.registry) as { REGISTRY: Record<string, Def> };
    const unionKeys = guard.parseFlagKeyUnion(readFileSync(guard.PATHS.dts, "utf8"));
    const rows = guard.parseDocRows(readFileSync(guard.PATHS.doc, "utf8"));
    expect(Object.keys(real).length).toBeGreaterThan(20); // sanity: the registry loaded
    expect(rows.length).toBe(Object.keys(real).length);
    expect(guard.compare({ registry: real, unionKeys, rows })).toEqual([]);
  });
});
